import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import express from "express";
import ffmpeg from "ffmpeg-static";
import { Innertube } from "youtubei.js";
import { request } from "undici";

const api = "http://127.0.0.1:9900";
const nativeFetch = globalThis.fetch;
const caption = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA fixture &amp; a check\n";
const media = Buffer.alloc(8000021, 42);
const aac = mkdtempSync(join(tmpdir(), "cobalt-hls-"));
let source, env, createStream, createInternalStream, probeInternalTunnel, chooseSoundcloud;
const instagramGraphQL = [];

const get = (url, options) => nativeFetch(url, { signal: AbortSignal.timeout(15000), ...options });
const submit = async (url, data) => {
    const res = await get(api, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url, ...data }),
    });
    return { status: res.status, body: await res.json() };
};

before(async () => {
    const generated = spawnSync(ffmpeg, [
        "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000",
        "-t", "2", "-c:a", "aac", "-f", "hls", join(aac, "audio.m3u8"),
    ]);
    assert.equal(generated.status, 0, generated.stderr?.toString() || String(generated.error));

    const sourceServer = createServer((req, res) => {
        const url = new URL(req.url, "http://fixture");
        switch (url.pathname) {
            case "/audio.m3u8":
                res.setHeader("content-type", "application/vnd.apple.mpegurl");
                return res.end(readFileSync(join(aac, "audio.m3u8")));
            case "/audio0.ts": {
                const bytes = readFileSync(join(aac, "audio0.ts"));
                res.setHeader("content-length", bytes.length);
                return res.end(bytes);
            }
            case "/video.mp4":
                res.setHeader("content-type", "video/mp4");
                if (req.method === "HEAD" || !req.headers.range) {
                    res.setHeader("content-length", media.length);
                    return res.end(req.method === "HEAD" ? undefined : media);
                } else {
                    const [, start, end] = req.headers.range.match(/^bytes=(\d+)-(\d+)$/);
                    const part = media.subarray(Number(start), Number(end) + 1);
                    res.writeHead(206, {
                        "content-length": part.length,
                        "content-range": "bytes " + start + "-" + end + "/" + media.length,
                    });
                    return res.end(part);
                }
            case "/empty":
                res.setHeader("content-length", "0");
                return res.end();
            case "/403":
                res.writeHead(403);
                return res.end();
            case "/probe-rejected.m3u8":
                res.setHeader("content-type", "application/vnd.apple.mpegurl");
                return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n403\n#EXT-X-ENDLIST\n");
            case "/rejected-range":
                if (req.method === "HEAD") {
                    res.setHeader("content-length", media.length);
                    return res.end();
                }
                res.writeHead(403);
                return res.end();
            case "/wrong-type.m3u8":
                res.writeHead(206, {
                    "content-type": "application/octet-stream",
                    "content-range": "bytes 0-59/60",
                    "etag": '"old-etag"',
                });
                return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttps://example.com/video.mp4\n#EXT-X-ENDLIST\n");
            case "/caption.vtt":
                res.setHeader("content-type", "text/vtt");
                return res.end(caption);
            case "/image.jpg":
                res.setHeader("content-type", "image/jpeg");
                return res.end("fixture-image");
            default:
                res.writeHead(404);
                return res.end();
        }
    });
    await new Promise(resolve => sourceServer.listen(0, resolve));
    source = "http://127.0.0.1:" + sourceServer.address().port;

    globalThis.fetch = async (input, init) => {
        const url = new URL(input?.url || input);
        if (url.hostname === "i.instagram.com" && url.pathname === "/api/v1/oembed/")
            return Response.json({}, { status: 400 });
        if (url.hostname === "www.instagram.com") {
            if (url.pathname.endsWith("/embed/captioned/")) return new Response('["init",[],[{}]],');
            if (url.pathname.startsWith("/p/")) return new Response("");
            if (url.pathname === "/graphql/query") {
                const authenticated = Boolean(init.headers.cookie);
                instagramGraphQL.push(authenticated);
                if (!authenticated) return Response.json({ errors: [{ message: "Login required" }] }, { status: 401 });
                return Response.json({ data: { xdt_shortcode_media: { video_url: source + "/video.mp4" } } });
            }
        }
        if (url.hostname === "api-http2.tumblr.com") return Response.json({
            response: { timeline: { elements: [{
                content: [{ type: "image", media: [{ url: source + "/image.jpg", width: 900 }] }],
                trail: [{ content: [{ type: "video", provider: "tumblr", media: { url: source + "/video.mp4" } }] }],
            }] } },
        });
        if (url.hostname === "web.facebook.com") return new Response(
            '{"__isNode":"Photo","id":"1234567890","image":{"uri":"' + source + '/image.jpg"}}',
        );
        if (url.hostname === "soundcloud.com") return new Response(
            '<script>window.__sc_version="1234567890"</script>{"hydratable":"apiClient","data":{"id":"fake-client"}}',
        );
        if (url.hostname === "api-v2.soundcloud.com") {
            if (url.pathname === "/resolve") return Response.json({
                id: 123, duration: 2000, title: "Sound fixture", user: { username: "Fixture" },
                media: { transcodings: [
                    { preset: "aac_160k", format: { protocol: "hls" }, url: "https://api-v2.soundcloud.com/high" },
                    { preset: "aac_96k", format: { protocol: "hls" }, url: "https://api-v2.soundcloud.com/low" },
                ] },
            });
            chooseSoundcloud = url.pathname;
            return Response.json({ url: source.replace("127.0.0.1", "localhost") + "/audio.m3u8" });
        }
        assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "unexpected live network request");
        return nativeFetch(input, init);
    };

    Innertube.create = async () => ({ session: { context: { client: {} } } });
    Innertube.prototype.getBasicInfo = async (id, { client }) => {
        assert.equal(client, "IOS");
        return {
            basic_info: { id, title: "Test caption", author: "Test author", duration: 2 },
            playability_status: { status: "OK" },
            captions: { caption_tracks: [{ base_url: source + "/caption.vtt", language_code: "en" }] },
        };
    };

    ({ env } = await import("./src/config.js"));
    ({ createStream, createInternalStream } = await import("./src/stream/manage.js"));
    ({ probeInternalTunnel } = await import("./src/stream/internal.js"));
    const { runAPI } = await import("./src/core/api.js");
    await runAPI(express, express(), process.cwd());
    for (let i = 0; i < 30 && +env.tunnelPort === 9900; i++) await sleep(25);
    assert.notEqual(+env.tunnelPort, 9900);
});

test("HLS rewrite serves a fresh playlist; a failed size probe is optional", async () => {
    const tunnel = createInternalStream(source + "/wrong-type.m3u8", { service: "bsky" });
    const res = await get(tunnel, { redirect: "manual" });
    assert.equal(res.status, 200, JSON.stringify({ tunnel, response: res.url, headers: [...res.headers] }));
    const body = await res.text();
    assert.match(res.headers.get("content-type"), /^application\/vnd\.apple\.mpegurl/, body.slice(0, 300));
    assert.equal(res.headers.get("content-range"), null);
    assert.notEqual(res.headers.get("etag"), '"old-etag"');
    assert.match(body, /127\.0\.0\.1:\d+\/itunnel\?id=/);
    assert.equal(await probeInternalTunnel({ service: "bsky", url: source + "/probe-rejected.m3u8", isHLS: true }), -1);
});

test("chunked media streams all bytes and rejects empty media", async () => {
    const url = createInternalStream(source + "/video.mp4", { service: "youtube" });
    const res = await get(url);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), media);
    assert.equal((await get(createInternalStream(source + "/empty", { service: "vk" }))).status, 500);
    assert.equal((await get(createInternalStream(source + "/rejected-range", { service: "youtube" }))).status, 500);
});

test("FFmpeg empty output is a 500 without a download attachment", async () => {
    const url = createStream({
        url: source + "/empty", service: "youtube", type: "audio",
        filename: "empty.m4a", audioFormat: "m4a", audioCopy: true,
    });
    const res = await get(url);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("content-disposition"), null);
    await res.text();
});

test("proxy downloads omit attachments on failure and preserve byte ranges", async () => {
    const tunnel = path => createStream({
        url: source + path, service: "threads", type: "proxy", filename: "sample.mp4",
    });
    for (const [path, status] of [["/403", 403], ["/empty", 502]]) {
        const res = await get(tunnel(path));
        assert.equal(res.status, status);
        assert.equal(res.headers.get("content-disposition"), null);
        assert.match(await res.text(), /did not return a downloadable file/);
    }
    const res = await get(tunnel("/video.mp4"), { headers: { Range: "bytes=0-3" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 0-3/${media.length}`);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), media.subarray(0, 4));
});

test("Tumblr carousel items honor alwaysProxy and download as attachments", async () => {
    const link = "https://example.tumblr.com/post/1234567890";
    const proxied = await submit(link, { alwaysProxy: true });
    assert.equal(proxied.body.status, "picker", JSON.stringify(proxied.body));
    assert.deepEqual(proxied.body.picker.map(item => item.type), ["photo", "video"]);
    for (const [item, extension] of proxied.body.picker.map((item, i) => [item, ["jpg", "mp4"][i]])) {
        assert.equal(new URL(item.url).pathname, "/tunnel");
        assert.match((await get(item.url, { method: "HEAD" })).headers.get("content-disposition"), new RegExp('^attachment; .*\\.' + extension));
    }
    assert.equal(await (await get(proxied.body.picker[0].url)).text(), "fixture-image");
    const direct = await submit(link, { alwaysProxy: false });
    assert.equal(direct.body.picker[0].url, source + "/image.jpg");
});

test("Facebook photo permalink returns a downloadable image", async () => {
    const { body } = await submit("https://www.facebook.com/photo.php?fbid=1234567890&story_fbid=999", {});
    assert.equal(body.status, "tunnel", JSON.stringify(body));
    assert.equal(body.filename, "facebook_1234567890.jpg");
    assert.equal(await (await get(body.url)).text(), "fixture-image");
});

test("Instagram retries GraphQL with its configured session when the anonymous reply has no media", async () => {
    const { loadFromFile } = await import("./src/processing/cookie/manager.js");
    const cookieFile = join(aac, "instagram-fixture.json");
    writeFileSync(cookieFile, JSON.stringify({ instagram: ["sessionid=fixture"] }));
    await loadFromFile(cookieFile);

    const { status, body } = await submit("https://www.instagram.com/reel/Fallback123/", { alwaysProxy: true });
    assert.deepEqual(instagramGraphQL, [false, true]);
    assert.equal(status, 200);
    assert.equal(body.status, "tunnel");
    assert.match(body.filename, /\.mp4$/);
    const res = await get(body.url, { headers: { Range: "bytes=0-3" } });
    assert.equal(res.status, 206);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), media.subarray(0, 4));
});

test("SoundCloud prefers the highest AAC bitrate and saves decodable M4A or MP3", async () => {
    for (const [audioFormat, extension] of [["best", ".m4a"], ["mp3", ".mp3"]]) {
        const { body } = await submit("https://soundcloud.com/fixture/test", { downloadMode: "audio", audioFormat });
        assert.equal(body.status, "tunnel", JSON.stringify(body));
        assert.equal(chooseSoundcloud, "/high");
        assert.ok(body.filename.endsWith(extension));
        const res = await get(body.url);
        assert.equal(res.status, 200);
        const bytes = Buffer.from(await res.arrayBuffer());
        const decoded = spawnSync(ffmpeg, ["-v", "error", "-i", "pipe:0", "-f", "s16le", "pipe:1"], { input: bytes });
        assert.equal(decoded.status, 0, decoded.stderr?.toString());
        assert.ok(decoded.stdout.length >= 150000);
    }
});

test("YouTube caption requests download only TXT or SRT and report missing languages", async () => {
    const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    for (const captionFormat of ["txt", "srt"]) {
        const { body } = await submit(link, { downloadMode: "captions", captionFormat });
        assert.equal(body.status, "tunnel", JSON.stringify(body));
        assert.match(body.filename, new RegExp('\\.' + captionFormat + '$'));
        const res = await get(body.url);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-disposition"), /^attachment;/);
        assert.match(res.headers.get("content-type"), captionFormat === "txt"
            ? /^text\/plain/ : /^application\/x-subrip/);
        const text = captionFormat === "txt"
            ? "A fixture & a check\n"
            : "1\n00:00:00,000 --> 00:00:02,000\nA fixture & a check\n";
        assert.equal(await res.text(), text);

        const navigation = await request(body.url, {
            headers: { "Sec-Fetch-Mode": "navigate" },
            signal: AbortSignal.timeout(15000),
        });
        assert.equal(navigation.statusCode, 200);
        assert.match(navigation.headers["content-type"], /^application\/octet-stream/);
        assert.match(navigation.headers.vary, /sec-fetch-mode/i);
        assert.equal(await navigation.body.text(), text);
    }
    const missing = await submit(link, { downloadMode: "captions", captionLanguage: "bg" });
    assert.equal(missing.body.error.code, "error.api.captions.language_unavailable");
    const unsupported = await submit("https://example.tumblr.com/post/1234567890", { downloadMode: "captions" });
    assert.equal(unsupported.body.error.code, "error.api.service.captions_not_supported");
});
