"use strict";

// Win98-style front end for a cobalt API instance.
// The API origin comes from config.js, written at container start.

const API = (window.WIZARD_CONFIG && window.WIZARD_CONFIG.apiUrl || "").replace(/\/+$/, "");

const $ = (id) => document.getElementById(id);
const form = $("form");
const urlInput = $("url");
const goButton = $("go-button");
const statusField = $("status");
const result = $("result");
const saveFile = $("save-file");
const picker = $("picker");
const pickerList = $("picker-list");
const pickerAudio = $("picker-audio");
const captionOptions = $("caption-options");
const captionFormat = $("caption-format");
const audioOptions = $("audio-options");
const audioFormat = $("audio-format");
const refreshPicker = $("picker-refresh");
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let metadataRequest = null;
let pickerRequest = null;
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
    "error.api.auth.turnstile.invalid": "The bot check failed. Try again.",
    "error.api.auth.turnstile.unavailable": "The bot check could not load. Check if your browser blocks Cloudflare and try again.",
    "error.api.no_config": "No API configured.",
    "error.api.bad_response": "Unexpected answer from the server.",
    "error.api.timed_out": "The server took too long to answer.",
    "error.api.unreachable": "Can't reach the server.",
    "error.api.youtube.login": "YouTube wants a login for this video.",
    "error.api.service.captions_not_supported": "Transcript downloads are available for YouTube links.",
    "error.api.captions.unavailable": "This video has no downloadable captions.",
};

const setStatus = (text) => { statusField.textContent = text; };

const describeError = (code, context) => {
    let text = MESSAGES[code] || `Something went wrong (${code || "unknown error"}).`;
    if (context?.httpStatus >= 500) text = `The server returned an error (${context.httpStatus}). Try again.`;
    else if (context?.httpStatus) text = `The server rejected the request (${context.httpStatus}).`;
    if (context?.service) text += ` [${context.service}]`;
    return text;
};

const setBusy = (state) => {
    busy = state;
    goButton.disabled = state;
    urlInput.readOnly = state;
    $("modes").disabled = state;
    $("paste-button").disabled = state;
    refreshPicker.disabled = state;
    $("picker-close").disabled = state;
};

const showError = (error) => {
    const code = error.name === "TimeoutError" ? "error.api.timed_out"
        : error.code || "error.api.unreachable";
    setStatus(describeError(code, error.context));
};

const apiError = (code, context) => Object.assign(new Error(code), { code, context });

const fetchJSON = async (path, options = {}, timeout = 10000) => {
    if (!API) throw apiError("error.api.no_config");
    const signal = AbortSignal.timeout(timeout);
    const response = await fetch(API + path, { ...options, signal });
    const data = response.headers.get("content-type")?.includes("application/json")
        ? await response.json().catch(() => { signal.throwIfAborted(); return null; })
        : null;
    if (data?.status === "error") {
        throw apiError(data.error?.code || "error.api.bad_response", data.error?.context);
    }
    if (response.status === 429) throw apiError("error.api.rate_exceeded");
    if (!response.ok) throw apiError("error.api.bad_response", { httpStatus: response.status });
    if (!data) throw apiError("error.api.bad_response");
    return data;
};

const getMetadata = () => {
    metadataRequest ??= fetchJSON("/").then(({ cobalt }) => {
        if (!cobalt?.version) throw apiError("error.api.bad_response");
        $("server").textContent = `cobalt ${cobalt.version}`;
        return cobalt;
    }).catch(error => {
        metadataRequest = null;
        throw error;
    });
    return metadataRequest;
};

// ---------- Turnstile ----------

const loadTurnstile = async () => {
    if (window.turnstile?.render) return window.turnstile;
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    try {
        return await new Promise((resolve, reject) => {
            const fail = () => reject(apiError("error.api.auth.turnstile.unavailable"));
            const timer = setTimeout(fail, 10000);
            script.onload = () => {
                clearTimeout(timer);
                if (window.turnstile?.render) resolve(window.turnstile);
                else fail();
            };
            script.onerror = () => { clearTimeout(timer); fail(); };
            document.head.append(script);
        });
    } catch (error) {
        script.remove();
        throw error;
    }
};

const getSession = async (sitekey) => {
    if (session && session.exp - 5 > Date.now() / 1000) return session.token;

    setStatus("Checking you're not a bot...");
    const turnstile = await loadTurnstile();
    let widgetId, timer;
    try {
        const token = await new Promise((resolve, reject) => {
            const fail = () => reject(apiError("error.api.auth.turnstile.missing"));
            timer = setTimeout(fail, 20000);
            widgetId = turnstile.render("#turnstile-widget", {
                sitekey,
                retry: "never",
                "response-field": false,
                callback: resolve,
                "timeout-callback": fail,
                "unsupported-callback": fail,
                "error-callback": () => { fail(); return true; },
            });
        });
        clearTimeout(timer);
        const data = await fetchJSON("/session", {
            method: "POST",
            headers: { "cf-turnstile-response": token },
        });
        if (!data.token || !Number.isFinite(data.exp)) throw apiError("error.api.auth.jwt.missing");
        session = { token: data.token, exp: Date.now() / 1000 + data.exp };
        return session.token;
    } finally {
        clearTimeout(timer);
        // Each attempt has its own widget and token, even if the exchange timed out.
        if (widgetId != null) turnstile.remove(widgetId);
    }
};

// ---------- Downloads ----------

const requestMedia = async (request, retried = false) => {
    const { turnstileSitekey } = await getMetadata();
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    };
    if (turnstileSitekey) headers["Authorization"] = `Bearer ${await getSession(turnstileSitekey)}`;

    setStatus("Fetching...");
    try {
        return await fetchJSON("/", {
            method: "POST",
            headers,
            body: JSON.stringify({
                ...request,
                alwaysProxy: true,
                filenameStyle: "pretty",
                videoQuality: "1080",
            }),
        }, 30000);
    } catch (error) {
        if (!retried && turnstileSitekey && /^error\.api\.auth\.jwt\./.test(error.code)) {
            session = null;
            return requestMedia(request, true);
        }
        throw error;
    }
};

const mediaURL = (value) => {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {}
    throw apiError("error.api.bad_response");
};

const setSaveLink = (link, url, expiredMessage) => {
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const expiry = url.origin === API && url.pathname === "/tunnel"
        ? Number(url.searchParams.get("exp")) : 0;
    link.onclick = (event) => {
        if (expiry && expiry <= Date.now()) {
            event.preventDefault();
            setStatus(expiredMessage);
        }
    };
};

// ---------- Picker ----------

const closePicker = () => {
    picker.hidden = true;
    pickerList.textContent = "";
    pickerAudio.hidden = true;
    pickerRequest = null;
    form.hidden = false;
    urlInput.focus();
};

const showPicker = (data, request) => {
    if (!Array.isArray(data.picker) || !data.picker.length) throw apiError("error.api.bad_response");
    const urls = data.picker.map(item => mediaURL(item.url));
    const audio = data.audio && mediaURL(data.audio);
    const expired = "This link expired. Refresh the list and try again.";
    pickerRequest = request;
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
        const save = document.createElement("a");
        save.textContent = "Save";
        save.setAttribute("aria-label", `Save ${label.toLowerCase()} ${i + 1}`);
        setSaveLink(save, urls[i], expired);
        li.appendChild(save);
        pickerList.appendChild(li);
    });
    pickerAudio.hidden = !audio;
    if (audio) setSaveLink(pickerAudio, audio, expired);
    picker.hidden = false;
    $("picker-title").focus();
    const count = data.picker.length;
    setStatus(count === 1 ? "1 item" : `${count} items`);
};

// ---------- UI ----------

const selectedMode = () => form.querySelector("input[name=mode]:checked").value;

const updateFormatOptions = () => {
    const mode = selectedMode();
    captionOptions.hidden = captionFormat.disabled = mode !== "captions";
    audioOptions.hidden = audioFormat.disabled = mode !== "audio";
};

form.addEventListener("change", updateFormatOptions);
window.addEventListener("pageshow", updateFormatOptions);
updateFormatOptions();

const prepareDownload = async (request) => {
    if (busy) return;
    result.hidden = true;
    setBusy(true);
    setStatus("Connecting...");
    try {
        const data = await requestMedia(request);
        switch (data.status) {
            case "tunnel":
            case "redirect":
                if (!picker.hidden) closePicker();
                setSaveLink(saveFile, mediaURL(data.url), "This link expired. Choose Download to get a new link.");
                result.hidden = false;
                setStatus(data.filename ? `File ready: ${data.filename}` : "File ready. Select Save file.");
                if (navigator.userActivation?.isActive) saveFile.click();
                break;
            case "picker":
                showPicker(data, request);
                break;
            case "local-processing":
                setStatus("This download needs in-browser processing.");
                break;
            default:
                throw apiError("error.api.bad_response");
        }
    } catch (error) {
        showError(error);
    } finally {
        setBusy(false);
    }
};

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    const mode = selectedMode();
    prepareDownload({
        url,
        downloadMode: mode,
        ...(mode === "captions" && { captionFormat: captionFormat.value }),
        ...(mode === "audio" && { audioFormat: audioFormat.value }),
    });
});

refreshPicker.addEventListener("click", () => {
    if (pickerRequest) prepareDownload(pickerRequest);
});

form.addEventListener("input", () => {
    result.hidden = true;
});

$("paste-button").addEventListener("click", async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text && !busy) {
            urlInput.value = text.trim();
            result.hidden = true;
        }
    } catch {
        urlInput.focus();
        setStatus("Paste blocked by the browser. Long-press the box instead.");
    }
});

$("picker-close").addEventListener("click", () => { closePicker(); setStatus("Ready"); });

// ---------- Help window ----------

const helpWindow = $("help-window");
const helpButton = $("help-button");

helpButton.addEventListener("click", () => {
    document.body.classList.add("help-open");
    helpWindow.showModal();
});
$("help-close").addEventListener("click", () => helpWindow.close());
$("help-ok").addEventListener("click", () => helpWindow.close());
helpWindow.addEventListener("close", () => {
    document.body.classList.remove("help-open");
    helpButton.focus();
});

// Allow https://dl.example/#<link> to prefill, like cobalt's own page.
if (location.hash.length > 1) {
    try { urlInput.value = decodeURIComponent(location.hash.slice(1)); } catch {}
}

getMetadata().then(() => {
    if (!busy) setStatus("Ready");
}, (error) => {
    if (!busy) showError(error);
});
