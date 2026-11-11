"use strict";

// Win98-style front end for a cobalt API instance.
// The API origin comes from config.js, written at container start.

const API = (window.WIZARD_CONFIG && window.WIZARD_CONFIG.apiUrl || "").replace(/\/+$/, "");

const $ = (id) => document.getElementById(id);
const form = $("form");
const urlInput = $("url");
const goButton = $("go-button");
const statusField = $("status");
const picker = $("picker");
const pickerList = $("picker-list");
const pickerAudio = $("picker-audio");

let sitekey = null;
let widgetId = null;
let session = null; // { token, exp } with exp as a unix timestamp
let busy = false;

const MESSAGES = {
    "error.api.link.invalid": "That doesn't look like a link cobalt can read.",
    "error.api.link.unsupported": "This site or link type isn't supported.",
    "error.api.service.unsupported": "This site isn't supported.",
    "error.api.service.disabled": "Downloads from this site are turned off on this server.",
    "error.api.content.video.unavailable": "That video isn't available. It may be private, deleted or region locked.",
    "error.api.content.post.unavailable": "That post isn't available. It may be private or deleted.",
    "error.api.content.post.private": "That post is private.",
    "error.api.content.post.age": "That post is age restricted.",
    "error.api.content.too_long": "That video is longer than this server allows.",
    "error.api.content.region": "That content is blocked in this server's region.",
    "error.api.content.paid": "That content is behind a paywall.",
    "error.api.fetch.fail": "The site didn't answer properly. Try again in a bit.",
    "error.api.fetch.critical": "The site changed something and this download broke.",
    "error.api.fetch.empty": "The site returned nothing to download.",
    "error.api.fetch.rate": "The site is rate limiting this server. Try again later.",
    "error.api.fetch.short_link": "Couldn't open that short link. Try the full link.",
    "error.api.rate_exceeded": "Too many downloads in a short time. Wait a minute.",
    "error.api.auth.jwt.missing": "The bot check didn't finish. Try again.",
    "error.api.auth.jwt.invalid": "The bot check expired. Try again.",
    "error.api.auth.turnstile.missing": "The bot check didn't finish. Try again.",
    "error.api.auth.turnstile.invalid": "The bot check failed. Reload the page.",
    "error.api.timed_out": "The server took too long to answer.",
    "error.api.unreachable": "Can't reach the server.",
    "error.api.youtube.login": "YouTube wants a login for this video.",
};

const setStatus = (text) => { statusField.textContent = text; };

const describeError = (code, context) => {
    let text = MESSAGES[code] || `Something went wrong (${code || "unknown error"}).`;
    if (context && context.service) text += ` [${context.service}]`;
    return text;
};

const setBusy = (state) => {
    busy = state;
    goButton.disabled = state;
    document.body.style.cursor = state ? "progress" : "";
};

// ---------- Turnstile ----------

let solvedResolvers = [];

const onSolved = () => {
    const resolvers = solvedResolvers;
    solvedResolvers = [];
    resolvers.forEach((resolve) => resolve());
    if (!busy) setStatus("Ready");
};

const waitForTurnstile = (timeoutMs = 20000) => new Promise((resolve, reject) => {
    if (!window.turnstile || widgetId === null) {
        return reject(new Error("error.api.auth.turnstile.missing"));
    }
    if (window.turnstile.getResponse(widgetId)) return resolve();
    const timer = setTimeout(() => reject(new Error("error.api.auth.turnstile.missing")), timeoutMs);
    solvedResolvers.push(() => { clearTimeout(timer); resolve(); });
});

const setupTurnstile = () => {
    if (!sitekey) return;
    const render = () => {
        widgetId = window.turnstile.render("#turnstile-widget", {
            sitekey,
            "refresh-expired": "auto",
            "retry-interval": 800,
            callback: onSolved,
            "error-callback": () => true,
        });
    };
    if (window.turnstile) {
        render();
    } else {
        const wait = setInterval(() => {
            if (window.turnstile) { clearInterval(wait); render(); }
        }, 100);
    }
};

const getSession = async () => {
    const now = Math.floor(Date.now() / 1000);
    if (session && session.exp - 5 > now) return session.token;

    setStatus("Checking you're not a bot...");
    await waitForTurnstile();
    const res = await fetch(`${API}/session`, {
        method: "POST",
        headers: { "cf-turnstile-response": window.turnstile.getResponse(widgetId) },
        signal: AbortSignal.timeout(10000),
    });
    window.turnstile.reset(widgetId);

    const data = await res.json();
    if (data.status === "error" || !data.token) {
        throw new Error(data.error && data.error.code || "error.api.auth.jwt.missing");
    }
    session = { token: data.token, exp: now + data.exp };
    return session.token;
};

// ---------- API ----------

const requestMedia = async (url, mode, retried = false) => {
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    };
    if (sitekey) headers["Authorization"] = `Bearer ${await getSession()}`;

    setStatus("Fetching...");
    const res = await fetch(`${API}/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            url,
            downloadMode: mode,
            alwaysProxy: true,
            filenameStyle: "pretty",
            videoQuality: "1080",
        }),
        signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();

    if (!retried && data.status === "error" && /^error\.api\.auth\.jwt/.test(data.error && data.error.code)) {
        session = null;
        return requestMedia(url, mode, true);
    }
    return data;
};

const download = (fileUrl) => {
    // Tunnel responses carry Content-Disposition: attachment, so the
    // browser saves the file and stays on this page.
    const a = document.createElement("a");
    a.href = fileUrl;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// ---------- Picker ----------

const closePicker = () => {
    picker.hidden = true;
    pickerList.textContent = "";
    pickerAudio.hidden = true;
    pickerAudio.onclick = null;
    form.hidden = false;
};

const showPicker = (data) => {
    form.hidden = true;
    pickerList.textContent = "";
    data.picker.forEach((item, i) => {
        const li = document.createElement("li");
        const label = { photo: "Photo", video: "Video", gif: "GIF" }[item.type] || "Item";
        if (item.thumb) {
            const img = document.createElement("img");
            img.src = item.thumb;
            img.alt = "";
            img.loading = "lazy";
            img.referrerPolicy = "no-referrer";
            li.appendChild(img);
        } else {
            const blank = document.createElement("div");
            blank.className = "thumb-blank";
            li.appendChild(blank);
        }
        const span = document.createElement("span");
        span.textContent = `${label} ${i + 1}`;
        li.appendChild(span);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Save";
        button.onclick = () => { download(item.url); setStatus(`Saving ${label.toLowerCase()} ${i + 1}`); };
        li.appendChild(button);
        pickerList.appendChild(li);
    });
    if (data.audio) {
        pickerAudio.hidden = false;
        pickerAudio.onclick = () => { download(data.audio); setStatus("Saving audio"); };
    }
    picker.hidden = false;
    setStatus(`${data.picker.length} items`);
};

// ---------- UI ----------

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const url = urlInput.value.trim();
    if (!url) return;
    const mode = form.querySelector("input[name=mode]:checked").value;

    setBusy(true);
    try {
        const data = await requestMedia(url, mode);
        switch (data.status) {
            case "tunnel":
            case "redirect":
                download(data.url);
                setStatus(`Saving ${data.filename || "file"}`);
                break;
            case "picker":
                showPicker(data);
                break;
            case "local-processing":
                setStatus("This one needs in-browser processing, which this page doesn't do.");
                break;
            case "error":
                setStatus(describeError(data.error && data.error.code, data.error && data.error.context));
                break;
            default:
                setStatus("Unexpected answer from the server.");
        }
    } catch (e) {
        const code = e && e.name === "TimeoutError" ? "error.api.timed_out"
            : e && /^error\./.test(e.message) ? e.message
            : "error.api.unreachable";
        setStatus(describeError(code));
    } finally {
        setBusy(false);
    }
});

$("paste-button").addEventListener("click", async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) urlInput.value = text.trim();
    } catch {
        urlInput.focus();
        setStatus("Paste blocked by the browser. Long-press the box instead.");
    }
});

$("picker-close").addEventListener("click", () => { closePicker(); setStatus("Ready"); });
$("help-button").addEventListener("click", () => { $("help-window").hidden = false; });
$("help-close").addEventListener("click", () => { $("help-window").hidden = true; });

// Allow https://dl.example/#<link> to prefill, like cobalt's own page.
if (location.hash.length > 1) {
    try { urlInput.value = decodeURIComponent(location.hash.slice(1)); } catch {}
}

(async () => {
    if (!API) { setStatus("No API configured."); return; }
    try {
        const res = await fetch(`${API}/`, { signal: AbortSignal.timeout(10000) });
        const info = await res.json();
        sitekey = info && info.cobalt && info.cobalt.turnstileSitekey || null;
        $("server").textContent = `cobalt ${info.cobalt && info.cobalt.version || ""}`.trim();
        setupTurnstile();
        setStatus(sitekey ? "Getting ready..." : "Ready");
    } catch {
        setStatus(describeError("error.api.unreachable"));
    }
})();
