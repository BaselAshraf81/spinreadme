const SCOPES = "user-read-currently-playing user-read-recently-played";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const API = "https://api.spotify.com/v1/me/player";
const FORM = "application/x-www-form-urlencoded";
const BLOB_VERSION = 1;
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_CACHE_S = 3000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const SVG_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "public, max-age=0, s-maxage=0, no-cache",
};
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const theme = themeFrom(url.searchParams.get("theme"));
    try {
      if (request.method === "GET" && pathname === "/") return htmlRes(setupPage(url.origin));
      if (request.method === "POST" && pathname === "/connect") return await connect(request, env, url);
      if (request.method === "GET" && pathname === "/callback") return await callback(url, env);
      if (request.method === "GET" && pathname === "/card.svg") {
        const creds = {
          id: env.SPOTIFY_CLIENT_ID,
          secret: env.SPOTIFY_CLIENT_SECRET,
          refresh: env.SPOTIFY_REFRESH_TOKEN,
        };
        return svgRes(await cardFor(() => refreshAccessToken(creds), theme));
      }
      const m = /^\/c\/([A-Za-z0-9_-]+)\.svg$/.exec(pathname);
      if (request.method === "GET" && m) return svgRes(await hostedCard(m[1], theme, env));
    } catch {
      return htmlRes(errorPage("Something went wrong. Try again in a minute."), 500);
    }
    return new Response("Not found", { status: 404 });
  },
};

const htmlRes = (body, status = 200) => new Response(body, { status, headers: HTML_HEADERS });
const svgRes = (svg) => new Response(svg, { headers: SVG_HEADERS });

// Hosted flow: the Spotify app credentials travel inside encrypted tokens.
// SPINDLE_KEY is a Worker secret holding base64 of 32 random bytes (AES-256).
// Generate one with: openssl rand -base64 32
async function connect(request, env, url) {
  const form = await request.formData();
  const id = clean(form.get("client_id"));
  const secret = clean(form.get("client_secret"));
  const theme = themeFrom(clean(form.get("theme")));
  if (!validCredential(id) || !validCredential(secret)) {
    return htmlRes(errorPage("Client ID and client secret look wrong. Copy them again from Spotify."), 400);
  }
  const state = await seal("state", { id, secret, theme, exp: Date.now() + STATE_TTL_MS }, env);
  const auth =
    AUTH_URL +
    "?" +
    new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: `${url.origin}/callback`,
      scope: SCOPES,
      state,
    });
  return Response.redirect(auth, 303);
}

async function callback(url, env) {
  if (url.searchParams.get("error")) {
    return htmlRes(errorPage("Spotify sign-in was cancelled. Start again from the setup page."), 400);
  }
  const state = await open("state", url.searchParams.get("state") || "", env);
  if (!state || typeof state.id !== "string" || typeof state.secret !== "string" || !(state.exp > Date.now())) {
    return htmlRes(errorPage("This sign-in could not be verified or has expired. Start again from the setup page."), 400);
  }
  const code = url.searchParams.get("code");
  const refresh = code ? await exchangeCode(url, state, code) : null;
  if (!refresh) {
    return htmlRes(errorPage("Spotify did not accept the sign-in. Check the client ID and secret, then try again."), 400);
  }
  const blob = await seal("blob", { id: state.id, secret: state.secret, refresh }, env);
  return htmlRes(resultPage(url.origin, blob, themeFrom(state.theme)));
}

async function exchangeCode(url, state, code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basic(state.id, state.secret), "Content-Type": FORM },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).refresh_token || null;
}

async function hostedCard(blob, theme, env) {
  const creds = await open("blob", blob, env);
  if (!creds || typeof creds.id !== "string" || typeof creds.secret !== "string" || typeof creds.refresh !== "string") {
    return render(null, null, theme);
  }
  return cardFor(() => cachedToken(blob, creds), theme);
}

// Access tokens last about an hour. Cache them per blob so each card view
// does not spend a token request. The cache key is the encrypted blob.
async function cachedToken(blob, creds) {
  const key = new Request(`https://spinreadme.internal/token/${blob}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.text();
  const token = await refreshAccessToken(creds);
  await caches.default.put(key, new Response(token, { headers: { "Cache-Control": `max-age=${TOKEN_CACHE_S}` } }));
  return token;
}

async function cardFor(getToken, theme) {
  let track = null;
  try {
    track = await getTrack(await getToken());
  } catch {
    track = null;
  }
  return render(track, await coverData(track), theme);
}

async function refreshAccessToken({ id, secret, refresh }) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basic(id, secret), "Content-Type": FORM },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!res.ok) throw new Error("token");
  return (await res.json()).access_token;
}

const basic = (id, secret) => "Basic " + btoa(`${id}:${secret}`);

async function getTrack(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const now = await fetch(`${API}/currently-playing`, { headers });
  if (now.status === 200) {
    const d = await now.json();
    if (d.item && d.currently_playing_type === "track") {
      return pick(d.item, true, d.is_playing, d.progress_ms);
    }
  }
  const recent = await fetch(`${API}/recently-played?limit=1`, { headers });
  if (recent.ok) {
    const d = await recent.json();
    if (d.items && d.items[0]) return pick(d.items[0].track, false, false, 0);
  }
  return null;
}

function pick(t, live, playing, progress) {
  const imgs = t.album.images || [];
  const img = imgs.find((i) => i.width <= 300) || imgs[imgs.length - 1];
  return {
    title: t.name,
    artist: t.artists.map((a) => a.name).join(", "),
    cover: img ? img.url : null,
    duration: t.duration_ms,
    progress: progress || 0,
    live,
    playing,
  };
}

async function coverData(track) {
  if (!track || !track.cover) return null;
  try {
    const res = await fetch(track.cover);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return "data:image/jpeg;base64," + btoa(bin);
  } catch {
    return null;
  }
}

// AES-GCM. Token layout: base64url(version byte + 12-byte IV + ciphertext).
// The purpose ("state" or "blob") is bound as additional data, so a token of
// one kind cannot be replayed as the other.
async function aesKey(env, usage) {
  const raw = b64Decode(env.SPINDLE_KEY || "");
  if (raw.length !== 32) throw new Error("SPINDLE_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

async function seal(purpose, data, env) {
  const key = await aesKey(env, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(purpose) }, key, enc.encode(JSON.stringify(data)))
  );
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = BLOB_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return b64urlEncode(out);
}

// Returns the payload, or null for any token that is malformed, tampered,
// wrong-version, or sealed with another key. Never throws.
async function open(purpose, token, env) {
  try {
    const bytes = b64Decode(token);
    if (bytes.length < 14 || bytes[0] !== BLOB_VERSION) return null;
    const key = await aesKey(env, "decrypt");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 13), additionalData: enc.encode(purpose) },
      key,
      bytes.slice(13)
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Accepts standard base64 (the SPINDLE_KEY format) and base64url (blobs).
function b64Decode(str) {
  const std = str.replace(/-/g, "+").replace(/_/g, "/");
  const s = std + "=".repeat((4 - (std.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const validCredential = (v) => /^[A-Za-z0-9]{8,128}$/.test(v);
const themeFrom = (v) => (Object.hasOwn(THEMES, v) ? v : "vinyl");

// Card palettes. Keys map to the colour roles used in render().
const THEMES = {
  vinyl: {
    bgFrom: "#1c1613", bgTo: "#0f0c0a", accent: "#f2a43a", ring: "#c9822a", ink: "#f4ece4", sub: "#b8a99b",
    dim: "#8a7b6f", track: "#2e2621", line: "#3a2f28", groove: "#1d1815", disc: "#0a0807", hole: "#0f0c0a",
    note: "#4a3d35", coverBg: "#241d19",
  },
  ice: {
    bgFrom: "#15202b", bgTo: "#070b10", accent: "#7dd3fc", ring: "#38bdf8", ink: "#eef8ff", sub: "#9fb9cc",
    dim: "#607a8c", track: "#1b2a37", line: "#243746", groove: "#132029", disc: "#070d13", hole: "#070b10",
    note: "#2d4558", coverBg: "#172530",
  },
  paper: {
    bgFrom: "#fbf6ec", bgTo: "#ebe1cc", accent: "#c2410c", ring: "#9a3412", ink: "#2a1e16", sub: "#6b5646",
    dim: "#9a8878", track: "#d8cbb4", line: "#cdbfa6", groove: "#d9ccb5", disc: "#2a211b", hole: "#fbf6ec",
    note: "#8a7a68", coverBg: "#e4d8c3",
  },
};
const THEME_NAMES = Object.keys(THEMES);

// Setup and result pages. Markup and copy live here, apart from the card.
const THEME_LABELS = { vinyl: "Vinyl", ice: "Ice", paper: "Paper" };
const SAMPLE_TRACK = { title: "Midnight City", artist: "M83", duration: 243000, progress: 96000, live: true, playing: true };
const SAMPLE_COVER =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5f6d"/><stop offset=".55" stop-color="#7b2ff7"/><stop offset="1" stop-color="#0f2b5b"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="84" cy="36" r="18" fill="#ffd07a" opacity=".9"/><path d="M0 92 L28 60 L52 84 L80 52 L120 96 L120 120 L0 120Z" fill="#0b1230" opacity=".8"/></svg>'
  );
const sampleCard = (theme) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(render(SAMPLE_TRACK, SAMPLE_COVER, theme));

const PAGE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0f0c0a; --panel: #1a1411; --raise: #231c18; --line: #34291f; --line-soft: #271f19;
  --amber: #f2a43a; --amber-deep: #c9822a; --ink: #f4ece4; --sub: #b8a99b; --dim: #9b8b7e;
  --display: 'Fraunces', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
  --body: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, 'SF Mono', Consolas, Menlo, monospace;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
* { box-sizing: border-box; }
html { background: var(--bg); scrollbar-color: var(--line) var(--bg); }
body {
  margin: 0; min-height: 100vh; color: var(--ink); font: 16px/1.6 var(--body);
  background:
    radial-gradient(ellipse 70% 50% at 85% 0%, rgba(242, 164, 58, 0.09), transparent 70%),
    var(--bg);
  overflow-x: hidden; -webkit-font-smoothing: antialiased;
}
::selection { background: var(--amber); color: #0f0c0a; }
a { color: var(--amber); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { color: #ffc069; }
:focus-visible { outline: 2px solid var(--amber); outline-offset: 3px; border-radius: 4px; }
.disc {
  position: fixed; z-index: 0; right: -190px; top: -150px; width: 560px; aspect-ratio: 1; border-radius: 50%;
  pointer-events: none; opacity: 0.9;
  background:
    radial-gradient(circle, #0f0c0a 0 2.4%, var(--amber) 2.5% 15%, var(--amber-deep) 15.2% 15.8%, transparent 16%),
    conic-gradient(from 20deg, transparent 0 8%, rgba(255,255,255,0.07) 12%, transparent 17% 58%, rgba(255,255,255,0.06) 63%, transparent 68%),
    repeating-radial-gradient(circle, #0a0807 0 3px, #1d1815 3px 4px);
  box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px var(--line-soft);
  animation: spin 24s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.wrap { position: relative; z-index: 1; max-width: 1040px; margin: 0 auto; padding: 28px 24px 40px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mark { font: 600 20px/1 var(--display); color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
.mark:hover { color: var(--amber); }
.by { font-size: 13px; color: var(--dim); }
h1 { font: 600 clamp(40px, 7vw, 72px)/1.02 var(--display); letter-spacing: -0.03em; margin: 0; text-wrap: balance; }
h1 em { font-style: italic; font-weight: 500; color: var(--amber); }
h2 { font: 600 24px/1.2 var(--display); letter-spacing: -0.01em; margin: 0 0 6px; text-wrap: balance; }
p { margin: 0; }
.lede { color: var(--sub); font-size: 18px; max-width: 46ch; margin-top: 20px; text-wrap: pretty; }
.hero { padding: 72px 0 40px; max-width: 640px; }
.hero-card { display: block; width: 495px; max-width: 100%; height: auto; margin-top: 40px; border-radius: 14px; box-shadow: 0 24px 48px -12px rgba(0,0,0,0.6); }
.steps { list-style: none; counter-reset: step; margin: 24px 0 0; padding: 0; display: grid; gap: 0; max-width: 720px; }
.steps > li { counter-increment: step; position: relative; padding: 0 0 44px 64px; }
.steps > li::before {
  content: counter(step); position: absolute; left: 0; top: -2px; width: 40px; height: 40px; display: grid; place-items: center;
  border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--amber); font: 600 18px/1 var(--display);
}
.steps > li::after { content: ''; position: absolute; left: 19.5px; top: 46px; bottom: 6px; width: 1px; background: var(--line-soft); }
.steps > li:last-child { padding-bottom: 0; }
.steps > li:last-child::after { display: none; }
.step-body { color: var(--sub); max-width: 58ch; }
.step-body a { color: var(--ink); text-decoration-color: var(--amber); }
.step-body a:hover { color: var(--amber); }
.vals { margin: 16px 0 0; display: grid; gap: 8px; max-width: 600px; }
.val { display: grid; grid-template-columns: 112px 1fr auto; align-items: center; gap: 12px; padding: 8px 8px 8px 14px; background: var(--panel); border: 1px solid var(--line-soft); border-radius: 10px; }
.val dt { font-size: 13px; color: var(--dim); }
.val dd { margin: 0; font: 14px/1.4 var(--mono); color: var(--ink); overflow-wrap: anywhere; user-select: all; }
.val.key { border-color: #5a3f1c; background: #1f1710; }
.val.key dd { color: #ffd9a0; }
.val.plain dd { font-family: var(--body); user-select: auto; color: var(--sub); }
.btn {
  appearance: none; font: 600 14px/1 var(--body); color: var(--ink); background: var(--raise); border: 1px solid var(--line);
  border-radius: 8px; padding: 9px 13px; cursor: pointer; min-height: 36px; white-space: nowrap;
  transition: background-color .2s var(--ease), border-color .2s var(--ease), transform .15s var(--ease), color .2s var(--ease);
}
.btn:hover { background: #2d231d; border-color: #4a3a2c; }
.btn:active { transform: scale(0.97); }
.btn.done { color: #0f0c0a; background: var(--amber); border-color: var(--amber); }
.btn.primary { color: #0f0c0a; background: var(--amber); border-color: var(--amber); font-size: 16px; padding: 14px 22px; min-height: 48px; border-radius: 10px; }
.btn.primary:hover { background: #ffb44f; border-color: #ffb44f; }
form { margin-top: 18px; display: grid; gap: 16px; max-width: 600px; }
label.field { display: grid; gap: 6px; font-size: 14px; color: var(--sub); }
input[type=text], input[type=password] {
  font: 15px/1.4 var(--mono); color: var(--ink); background: #0b0907; border: 1px solid var(--line); border-radius: 10px;
  padding: 12px 14px; width: 100%; caret-color: var(--amber); transition: border-color .2s var(--ease), box-shadow .2s var(--ease);
}
input::placeholder { color: #6f6256; }
input[type=text]:focus, input[type=password]:focus { outline: none; border-color: var(--amber); box-shadow: 0 0 0 3px rgba(242, 164, 58, 0.18); }
fieldset { border: 0; margin: 4px 0 0; padding: 0; min-width: 0; }
legend { font-size: 14px; color: var(--sub); padding: 0; margin-bottom: 8px; }
.themes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.theme { position: relative; display: grid; gap: 8px; padding: 8px 8px 10px; background: var(--panel); border: 1px solid var(--line-soft); border-radius: 12px; cursor: pointer; transition: border-color .2s var(--ease), background-color .2s var(--ease), transform .2s var(--ease); }
.theme:hover { border-color: #4a3a2c; }
.theme input { position: absolute; opacity: 0; pointer-events: none; }
.theme img { display: block; width: 100%; height: auto; border-radius: 8px; }
.theme span { font-size: 14px; font-weight: 600; text-align: center; color: var(--sub); }
.theme:has(input:checked) { border-color: var(--amber); background: #211810; }
.theme:has(input:checked) span { color: var(--amber); }
.theme:has(input:focus-visible) { outline: 2px solid var(--amber); outline-offset: 3px; }
.fine { font-size: 14px; color: var(--dim); max-width: 58ch; }
.submit { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 4px; }
.foot { margin-top: 72px; padding-top: 20px; border-top: 1px solid var(--line-soft); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 14px; color: var(--dim); }
.foot a { color: var(--sub); }
.foot a:hover { color: var(--amber); }
.result { padding: 64px 0 0; max-width: 700px; }
.result .preview { display: block; width: 495px; max-width: 100%; height: auto; margin: 36px 0 28px; border-radius: 14px; box-shadow: 0 24px 48px -12px rgba(0,0,0,0.6); background: var(--panel); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
.chip { position: relative; cursor: pointer; }
.chip input { position: absolute; opacity: 0; pointer-events: none; }
.chip span { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 99px; font-size: 14px; font-weight: 600; color: var(--sub); border: 1px solid var(--line); background: var(--panel); transition: border-color .2s var(--ease), color .2s var(--ease); }
.chip i { width: 10px; height: 10px; border-radius: 50%; display: block; }
.chip:has(input:checked) span { color: var(--amber); border-color: var(--amber); }
.chip:has(input:focus-visible) span { outline: 2px solid var(--amber); outline-offset: 3px; }
.code { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; padding: 14px; background: #0b0907; border: 1px solid var(--line); border-radius: 12px; }
.code textarea { width: 100%; resize: none; border: 0; background: transparent; color: #ffd9a0; font: 13px/1.6 var(--mono); padding: 0; margin: 0; caret-color: var(--amber); overflow-wrap: anywhere; }
.code textarea:focus { outline: none; }
.next { margin-top: 28px; color: var(--sub); max-width: 58ch; display: grid; gap: 12px; }
.next p:last-child { color: var(--dim); font-size: 14px; }
.err { padding-top: 96px; max-width: 560px; }
.err .lede { margin-bottom: 28px; }
@media (max-width: 720px) {
  .disc { width: 340px; right: -170px; top: -110px; opacity: 0.55; }
  .hero { padding: 48px 0 24px; }
  .steps > li { padding-left: 52px; }
  .steps > li::before { width: 34px; height: 34px; font-size: 16px; }
  .steps > li::after { left: 16.5px; top: 40px; }
  .val { grid-template-columns: 1fr auto; }
  .val dt { grid-column: 1 / -1; margin-bottom: -6px; }
  .themes { grid-template-columns: 1fr; }
  .code { grid-template-columns: 1fr; }
  .result { padding-top: 40px; }
}
@media (prefers-reduced-motion: reduce) { .disc { animation: none; } .btn, .theme, input { transition: none; } }
@media (max-width: 720px) { .theme { grid-template-columns: 1fr; } }
.rise { animation: rise .8s var(--ease) both; }
@keyframes rise { from { opacity: 0; transform: translateY(14px); } }
@media (prefers-reduced-motion: reduce) { .rise { animation: none; } }
`;

const COPY_JS = `
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const src = b.dataset.copy;
  const text = src.startsWith("#") ? document.querySelector(src).value : src;
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  const was = b.textContent; b.textContent = "Copied"; b.classList.add("done");
  setTimeout(() => { b.textContent = was; b.classList.remove("done"); }, 1600);
});
`;

function layout(title, body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0f0c0a">
<meta name="description" content="A vinyl card for your GitHub README that shows what you are playing on Spotify.">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500..700;1,9..144,500&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="disc" aria-hidden="true"></div>
<div class="wrap">
<header class="top"><a class="mark" href="/">spinreadme</a><span class="by">Made by <a href="https://baselashraf.com" target="_blank" rel="noopener">Basel Ashraf</a></span></header>
${body}
<footer class="foot"><span>Nothing is stored on a server.</span><a href="https://github.com/BaselAshraf81/spinreadme" target="_blank" rel="noopener">Source on GitHub</a></footer>
</div>
<script>${COPY_JS}${script}</script>
</body>
</html>`;
}

const copyBtn = (v, label = "Copy") => `<button type="button" class="btn" data-copy="${esc(v)}" aria-label="${esc(label)} ${esc(v)}">Copy</button>`;
const val = (name, v, cls = "") =>
  `<div class="val ${cls}"><dt>${name}</dt><dd>${esc(v)}</dd>${copyBtn(v)}</div>`;

function setupPage(origin) {
  const redirect = `${origin}/callback`;
  const themes = THEME_NAMES.map(
    (n, i) =>
      `<label class="theme"><input type="radio" name="theme" value="${n}"${i === 0 ? " checked" : ""}><img src="${sampleCard(n)}" alt="" width="495" height="170"><span>${THEME_LABELS[n] || n}</span></label>`
  ).join("");
  return layout(
    "spinreadme: a now playing card for your GitHub README",
    `<section class="hero rise">
  <h1>Your music, <em>spinning</em> on your profile.</h1>
  <p class="lede">Put a vinyl card in your GitHub README. The record turns while a track plays, and the card shows your last track when you stop.</p>
  <img class="hero-card" src="${sampleCard("vinyl")}" alt="spinreadme card showing Midnight City by M83 on a spinning record" width="495" height="170">
</section>
<ol class="steps">
  <li>
    <h2>Create a Spotify app</h2>
    <div class="step-body">
      <p>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify developer dashboard</a>, click Create app, and fill it in with these values. Under "Which API/SDKs are you planning to use?" tick Web API.</p>
      <dl class="vals">
        ${val("App name", "spinreadme")}
        ${val("App description", "Now playing card for my GitHub README")}
        ${val("Redirect URI", redirect, "key")}
      </dl>
      <p class="fine" style="margin-top:12px">Add the redirect URI with the Add button, then save. It has to match exactly, with no trailing slash.</p>
    </div>
  </li>
  <li>
    <h2>Paste your credentials</h2>
    <div class="step-body">
      <p>Open the app, then Settings. Copy the Client ID, then click View client secret and copy that too.</p>
      <form method="post" action="/connect" autocomplete="off">
        <label class="field">Client ID<input type="text" name="client_id" required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="32 characters" pattern="[A-Za-z0-9]{8,128}"></label>
        <label class="field">Client secret<input type="password" name="client_secret" required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="32 characters" pattern="[A-Za-z0-9]{8,128}"></label>
        <fieldset>
          <legend>Card theme</legend>
          <div class="themes">${themes}</div>
        </fieldset>
        <div class="submit">
          <button type="submit" class="btn primary">Connect Spotify</button>
          <p class="fine">Spotify will ask you to approve read-only access to what you are playing.</p>
        </div>
      </form>
    </div>
  </li>
  <li>
    <h2>Paste the Markdown</h2>
    <div class="step-body">
      <p>You get a card URL and a line of Markdown. Put it in the README of your profile repository, the one named after your username. The app is yours, so Spotify's 25-user limit does not apply.</p>
    </div>
  </li>
</ol>`
  );
}

function resultPage(origin, blob, theme) {
  const cardUrl = (t) => `${origin}/c/${blob}.svg?theme=${t}`;
  const md = (t) => `![Spotify now playing](${cardUrl(t)})`;
  const chips = THEME_NAMES.map(
    (n) =>
      `<label class="chip"><input type="radio" name="theme" value="${n}"${n === theme ? " checked" : ""}><span><i style="background:${THEMES[n].accent};box-shadow:0 0 0 2px ${THEMES[n].bgTo}"></i>${THEME_LABELS[n] || n}</span></label>`
  ).join("");
  const script = `
const base = ${JSON.stringify(`${origin}/c/${blob}.svg?theme=`)};
const pv = document.getElementById("pv"), md = document.getElementById("md");
document.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener("change", () => {
  pv.src = base + r.value; md.value = "![Spotify now playing](" + base + r.value + ")";
}));`;
  return layout(
    "spinreadme: your card is ready",
    `<section class="result rise">
  <h1>Your card is <em>ready</em>.</h1>
  <img id="pv" class="preview" src="${esc(cardUrl(theme))}" alt="Your now playing card" width="495" height="170">
  <div class="chips" role="radiogroup" aria-label="Theme">${chips}</div>
  <div class="code">
    <textarea id="md" rows="3" readonly aria-label="Markdown for your README" spellcheck="false">${esc(md(theme))}</textarea>
    <button type="button" class="btn primary" data-copy="#md">Copy Markdown</button>
  </div>
  <div class="next">
    <p>Paste it into the README of your profile repository and commit. GitHub can take a minute to refresh the image.</p>
    <p>The URL holds your encrypted credentials, so anyone who has it can see what you play. Keep it out of places you would not share. To shut it off, reset the client secret in your Spotify app.</p>
    <p><a href="/">Make another card</a></p>
  </div>
</section>`,
    script
  );
}

function errorPage(message) {
  return layout(
    "spinreadme: something went wrong",
    `<section class="err rise"><h1>That did not <em>work</em>.</h1><p class="lede">${esc(message)}</p><a class="btn primary" style="display:inline-flex;align-items:center;text-decoration:none" href="/">Back to setup</a></section>`
  );
}
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function render(track, cover, theme = "vinyl") {
  const c = THEMES[theme] || THEMES.vinyl;
  const spinning = !!(track && track.playing);
  const label = !track ? "SILENCE" : track.playing ? "NOW PLAYING" : track.live ? "PAUSED" : "LAST PLAYED";
  const title = track ? clip(track.title, 25) : "Nothing on the turntable";
  const artist = track ? clip(track.artist, 34) : "Check back later";
  const BAR = 240;
  const frac = track && track.duration ? Math.min(track.progress / track.duration, 1) : 0;
  const startW = (BAR * frac).toFixed(1);
  const remain = track ? Math.max((track.duration - track.progress) / 1000, 0) : 0;
  const progressAnim = spinning
    ? `<animate attributeName="width" from="${startW}" to="${BAR}" dur="${remain.toFixed(1)}s" fill="freeze"/>`
    : "";
  const art = cover
    ? `<image href="${cover}" x="20" y="25" width="120" height="120" clip-path="url(#round)" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="20" y="25" width="120" height="120" rx="8" fill="${c.coverBg}"/>
       <text x="80" y="95" font-size="40" text-anchor="middle" fill="${c.note}">♪</text>`;
  const bars = [0, 1, 2, 3]
    .map(
      (i) =>
        `<rect class="eq${spinning ? " on" : ""}" x="${446 + i * 8}" y="24" width="4" height="16" rx="2" fill="${c.accent}" style="animation-delay:${i * 0.17}s;animation-duration:${(0.7 + i * 0.13).toFixed(2)}s"/>`
    )
    .join("");
  const progress = track
    ? `<rect x="215" y="124" width="${BAR}" height="4" rx="2" fill="${c.track}"/>
       <rect x="215" y="124" width="${startW}" height="4" rx="2" fill="${c.accent}">${progressAnim}</rect>
       <text x="215" y="148" class="mono dim">${mmss(track.progress)}</text>
       <text x="455" y="148" class="mono dim" text-anchor="end">${mmss(track.duration)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="170" viewBox="0 0 495 170" role="img" aria-label="${esc(label)}: ${esc(title)} by ${esc(artist)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c.bgFrom}"/><stop offset="1" stop-color="${c.bgTo}"/>
    </linearGradient>
    <clipPath id="round"><rect x="20" y="25" width="120" height="120" rx="8"/></clipPath>
    <radialGradient id="glow" cx="0.2" cy="0.5" r="0.8">
      <stop offset="0" stop-color="${c.accent}" stop-opacity="0.12"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <style>
    text { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
    .mono { font-family: 'SF Mono', Consolas, Menlo, monospace; font-size: 10px; }
    .dim { fill: ${c.dim}; }
    .tag { font-size: 10px; font-weight: 600; letter-spacing: 2.4px; fill: ${c.accent}; }
    .title { font-size: 19px; font-weight: 700; fill: ${c.ink}; }
    .artist { font-size: 13px; fill: ${c.sub}; }
    .spin { transform-origin: 140px 85px; animation: spin 3.2s linear infinite; animation-play-state: ${spinning ? "running" : "paused"}; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .eq { transform-box: fill-box; transform-origin: 50% 100%; transform: scaleY(0.25); }
    .eq.on { animation: bounce 0.9s ease-in-out infinite alternate; }
    @keyframes bounce { from { transform: scaleY(0.2); } to { transform: scaleY(1); } }
    .dot { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.25; } }
  </style>
  <rect width="495" height="170" rx="14" fill="url(#bg)"/>
  <rect width="495" height="170" rx="14" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="494" height="169" rx="13.5" fill="none" stroke="${c.line}"/>
  <g class="spin">
    <circle cx="140" cy="85" r="64" fill="${c.disc}"/>
    <circle cx="140" cy="85" r="58" fill="none" stroke="${c.groove}" stroke-width="1"/>
    <circle cx="140" cy="85" r="52" fill="none" stroke="${c.groove}" stroke-width="1"/>
    <circle cx="140" cy="85" r="46" fill="none" stroke="${c.groove}" stroke-width="1"/>
    <circle cx="140" cy="85" r="40" fill="none" stroke="${c.groove}" stroke-width="1"/>
    <circle cx="140" cy="85" r="34" fill="none" stroke="${c.groove}" stroke-width="1"/>
    <path d="M140 85 L140 21 A64 64 0 0 1 185 40 Z" fill="#fff" opacity="0.05"/>
    <path d="M140 85 L140 149 A64 64 0 0 1 95 130 Z" fill="#fff" opacity="0.05"/>
    <circle cx="140" cy="85" r="21" fill="${c.accent}"/>
    <circle cx="140" cy="85" r="15" fill="none" stroke="${c.ring}" stroke-width="1"/>
    <circle cx="140" cy="85" r="3.5" fill="${c.hole}"/>
  </g>
  ${art}
  <rect x="20" y="25" width="120" height="120" rx="8" fill="none" stroke="#fff" stroke-opacity="0.08"/>
  <circle class="${spinning ? "dot" : ""}" cx="219" cy="35" r="3" fill="${c.accent}"/>
  <text x="228" y="39" class="tag">${label}</text>
  ${bars}
  <text x="215" y="76" class="title">${esc(title)}</text>
  <text x="215" y="98" class="artist">${esc(artist)}</text>
  ${progress}
</svg>`;
}
