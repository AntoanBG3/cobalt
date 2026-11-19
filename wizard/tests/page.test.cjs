const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { chromium, webkit } = require("playwright-core");

const pageURL = process.env.WIZARD_PAGE_URL || "http://127.0.0.1:9910";
const apiURL = "http://127.0.0.1:9911";
const postURL = "https://example.com/post";
const metadata = { cobalt: { version: "fixture" } };
const file = { status: "tunnel", url: apiURL + "/file", filename: "sample.txt" };
const sample = "Media fixture";
const json = (res, data, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
const attachment = (res) => res.writeHead(200, {
    "Content-Type": res.req.headers["sec-fetch-mode"] === "navigate" ? "application/octet-stream" : "text/plain",
    "Content-Length": Buffer.byteLength(sample),
    "Content-Disposition": 'attachment; filename="sample.txt"',
}).end(sample);

let browser, respond;
const api = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", new URL(pageURL).origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, cf-turnstile-response");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    await respond(req, res, body);
});

before(async () => {
    await new Promise((resolve, reject) => api.once("error", reject).listen(9911, "127.0.0.1", resolve));
    const engine = process.env.WIZARD_WEBKIT ? webkit : chromium;
    browser = await engine.launch({ executablePath: process.env.WIZARD_BROWSER_EXECUTABLE });
});

after(async () => {
    await browser?.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
});

const browserTest = (name, run) => test(name, { timeout: 15000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try { await run(page, context); } finally { await context.close(); }
});

const enterLink = async (page) => {
    await page.goto(pageURL);
    await page.locator("#url").fill(postURL);
};

const waitStatus = (page, text) => page.getByRole("status").getByText(text, { exact: true }).waitFor();
const download = (page) => page.getByRole("button", { name: "Download", exact: true });
const waitDownload = (context) => context.waitForEvent("download", { timeout: 5000 });
const submitWithoutActivation = (page) => page.locator("#form").evaluate(form => form.requestSubmit());

test("the built page revalidates HTML and serves fingerprinted assets", async () => {
    const page = await fetch(pageURL);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    const assets = [...(await page.text()).matchAll(/"((?:app|style)\.([0-9a-f]{12})\.(?:js|css))"/g)];
    assert.equal(assets.length, 2);
    for (const [, name, hash] of assets) {
        const res = await fetch(new URL(name, pageURL));
        assert.equal(res.status, 200);
        assert.match(res.headers.get("cache-control"), /immutable/);
        assert.equal(createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex").slice(0, 12), hash);
    }
    const config = await fetch(new URL("config.js", pageURL));
    assert.equal(config.headers.get("cache-control"), "no-store");
    await config.body.cancel();
});

browserTest("a file handoff leaves the form and its recovery link in place", async (page, context) => {
    let transferStatus = 502;
    respond = (req, res) => {
        if (req.url === "/file") {
            if (transferStatus === 502) return res.writeHead(502).end("Temporary upstream failure");
            return attachment(res);
        }
        return json(res, req.method === "GET" ? metadata : file);
    };
    await enterLink(page);
    await submitWithoutActivation(page);
    await waitStatus(page, "File ready: sample.txt");
    const save = page.getByRole("link", { name: "Save file" });
    const failure = context.waitForEvent("response", { predicate: r => r.url() === file.url });
    await save.click();
    assert.equal((await failure).status(), 502);
    assert.equal(page.url(), new URL(pageURL).href);
    assert.equal(await page.locator("#url").inputValue(), postURL);

    transferStatus = 200;
    const saved = waitDownload(context);
    await save.click();
    const item = await saved;
    assert.equal(item.suggestedFilename(), "sample.txt");
    assert.equal(await readFile(await item.path(), "utf8"), sample);
    assert.equal(await save.isVisible(), true);
});

browserTest("direct downloads opt into provider links and keep tunnels available", async (page) => {
    const source = "https://example.org/media.mp4";
    const requests = [];
    respond = (req, res, body) => {
        if (req.method === "GET") return json(res, metadata);
        requests.push(body.alwaysProxy);
        const direct = !body.alwaysProxy && requests.length === 2;
        return json(res, direct ? { status: "redirect", url: source } : file);
    };
    await enterLink(page);
    const submit = async expected => {
        await submitWithoutActivation(page);
        await page.waitForFunction(href => !document.querySelector("#result").hidden
            && document.querySelector("#save-file").href === href, expected);
    };
    await submit(file.url);
    await page.locator('label[for="direct-download"]').click();
    await submit(source);
    await submit(file.url);
    await page.locator('label[for="mode-captions"]').click();
    assert.equal(await page.locator("#direct-options").isVisible(), false);
    await submit(file.url);
    assert.deepEqual(requests, [true, false, false, true]);
});

browserTest("a quick result still starts a download directly", async (page, context) => {
    respond = (req, res) => req.url === "/file" ? attachment(res)
        : json(res, req.method === "GET" ? metadata : file);
    await enterLink(page);
    const saved = waitDownload(context);
    await download(page).click();
    assert.equal((await saved).suggestedFilename(), "sample.txt");
});

browserTest("the picker refreshes expired links and restores keyboard focus", async (page, context) => {
    let requests = 0;
    let transfers = 0;
    respond = (req, res, body) => {
        if (req.url.startsWith("/tunnel?")) { transfers++; return attachment(res); }
        if (req.method === "GET") return json(res, metadata);
        assert.equal(body.url, postURL);
        const expiry = Date.now() + (++requests === 1 ? -1000 : 90000);
        return json(res, {
            status: "picker",
            picker: [{ type: "photo", url: apiURL + "/tunnel?exp=" + expiry }],
        });
    };
    await enterLink(page);
    await download(page).click();
    await waitStatus(page, "1 item");
    assert.equal(await page.locator("#picker-title").evaluate(el => el === document.activeElement), true);
    const save = page.getByRole("link", { name: "Save photo 1" });
    await save.click();
    await waitStatus(page, "This link expired. Refresh the list and try again.");
    assert.equal(transfers, 0);
    await page.getByRole("button", { name: "Refresh list" }).click();
    await waitStatus(page, "1 item");
    const saved = waitDownload(context);
    await save.click();
    await saved;
    assert.equal(requests, 2);
    assert.ok(transfers > 0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await page.locator("#url").evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator("#url").inputValue(), postURL);
});

browserTest("verification waits for metadata and uses a new token after a failed exchange", async (page, context) => {
    let release, media = 0, sessions = 0;
    const gate = new Promise(resolve => { release = resolve; });
    await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js?*", route => route.fulfill({
        contentType: "application/javascript",
        body: `let nextToken = 0;
            window.turnstile = {
                render(_el, options) {
                    const id = ++nextToken;
                    options.callback("fixture-" + id);
                    return id;
                },
                remove() {}
            };`,
    }));
    respond = async (req, res) => {
        if (req.method === "GET") {
            await gate;
            return json(res, { cobalt: { ...metadata.cobalt, turnstileSitekey: "fixture" } });
        }
        if (req.url === "/session") {
            assert.equal(req.headers["cf-turnstile-response"], "fixture-" + (++sessions));
            if (sessions === 1) return res.writeHead(502, { "Content-Type": "text/html" }).end("<title>Edge error</title>");
            return json(res, { token: "test-session", exp: 600 });
        }
        media++;
        assert.equal(req.headers.authorization, "Bearer test-session");
        return json(res, { status: "error", error: { code: "error.api.link.unsupported" } }, 400);
    };
    try {
        await enterLink(page);
        await download(page).click();
        await waitStatus(page, "Connecting...");
        assert.equal(media, 0);
        release();
        await waitStatus(page, "The server returned an error (502). Try again.");
        assert.equal(media, 0);
        await download(page).click();
        await waitStatus(page, "This site or link type isn't supported.");
        await download(page).click();
        await waitStatus(page, "This site or link type isn't supported.");
        assert.equal(sessions, 2);
        assert.equal(media, 2);
    } finally { release(); }
});

browserTest("a blocked Turnstile script gives a retryable error", async (page, context) => {
    const scripts = "https://challenges.cloudflare.com/turnstile/v0/api.js?*";
    let loads = 0, posts = 0;
    await context.route(scripts, route => { loads++; return route.abort(); });
    respond = (req, res) => {
        if (req.method === "POST") posts++;
        return json(res, { cobalt: { ...metadata.cobalt, turnstileSitekey: "fixture" } });
    };
    await enterLink(page);
    for (let i = 0; i < 2; i++) {
        await download(page).click();
        await waitStatus(page, "The bot check could not load. Check if your browser blocks Cloudflare and try again.");
    }
    assert.equal(loads, 2);
    assert.equal(posts, 0);
});

browserTest("errors wrap on narrow screens and Help fits and restores focus", async (page) => {
    respond = (req, res) => req.method === "GET" ? json(res, metadata) : json(res, {
        status: "error",
        error: { code: "error.api.content.video.unavailable", context: { service: "youtube" } },
    }, 400);
    await enterLink(page);
    await download(page).click();
    await waitStatus(page, "That video isn't available. It may be private, deleted or region locked. [youtube]");
    assert.equal(await page.getByRole("status").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.setViewportSize({ width: 568, height: 240 });
    const help = page.getByRole("button", { name: "Help" });
    await help.click();
    const dialog = page.getByRole("dialog");
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 240);
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press("Tab");
    // WebKit on macOS can move Tab focus to browser chrome.
    assert.equal(await page.locator("#main-window").evaluate(el => el.contains(document.activeElement)), false);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await help.evaluate(el => el === document.activeElement), true);
});

browserTest("audio and captions include only the selected format", async (page) => {
    const sent = [];
    respond = (req, res, body) => {
        if (req.method === "GET") return json(res, metadata);
        sent.push(body);
        return json(res, { status: "error", error: { code: "error.api.link.unsupported" } }, 400);
    };
    await enterLink(page);
    const send = async () => {
        await download(page).click();
        await waitStatus(page, "This site or link type isn't supported.");
    };
    await page.locator('label[for="mode-audio"]').click();
    await send();
    await page.locator("#audio-format").selectOption("mp3");
    await send();
    await page.locator('label[for="mode-captions"]').click();
    await page.locator("#caption-format").selectOption("srt");
    await send();
    assert.deepEqual(sent.map(({ downloadMode, audioFormat, captionFormat }) => [downloadMode, audioFormat, captionFormat]), [
        ["audio", "best", undefined], ["audio", "mp3", undefined], ["captions", undefined, "srt"],
    ]);
});
