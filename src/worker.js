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
  const key = new Request(`https://spindle.internal/token/${blob}`);
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
const PAGE_CSS = `
:root { color-scheme: dark; font-family: system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
body { margin: 0; background: #0f0c0a; color: #f4ece4; line-height: 1.5; }
main { max-width: 560px; margin: 0 auto; padding: 48px 20px; }
h1 { font-size: 28px; margin: 0 0 12px; color: #f2a43a; }
a { color: #f2a43a; }
code, textarea { font-family: Consolas, Menlo, monospace; font-size: 13px; }
ol { padding-left: 20px; color: #b8a99b; }
form { display: grid; gap: 14px; margin: 24px 0; }
label { display: grid; gap: 6px; font-size: 14px; color: #b8a99b; }
input, select, textarea { background: #1c1613; color: #f4ece4; border: 1px solid #3a2f28; border-radius: 8px; padding: 10px 12px; font: inherit; box-sizing: border-box; width: 100%; }
button { background: #f2a43a; color: #0f0c0a; border: 0; border-radius: 8px; padding: 11px 16px; font: inherit; font-weight: 600; cursor: pointer; justify-self: start; }
.preview { display: block; max-width: 100%; height: auto; margin: 20px 0; }
textarea { font-size: 13px; margin-bottom: 12px; }
.note { font-size: 13px; color: #8a7b6f; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function setupPage(origin) {
  const options = THEME_NAMES.map((n) => `<option value="${n}">${n}</option>`).join("");
  return layout(
    "Spindle",
    `<h1>Spindle</h1>
<p>A vinyl card that shows what you are listening to on Spotify, for your GitHub README.</p>
<ol>
  <li>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify developer dashboard</a> and create an app.</li>
  <li>Add this Redirect URI: <code>${esc(origin)}/callback</code></li>
  <li>Select Web API, save, then copy the Client ID and Client secret.</li>
</ol>
<form method="post" action="/connect">
  <label>Client ID <input name="client_id" required autocomplete="off" spellcheck="false"></label>
  <label>Client secret <input name="client_secret" type="password" required autocomplete="off" spellcheck="false"></label>
  <label>Theme <select name="theme">${options}</select></label>
  <button type="submit">Connect Spotify</button>
</form>
<p class="note">No database. Your credentials live only inside the encrypted card URL.</p>`
  );
}

function resultPage(origin, blob, theme) {
  const card = `${origin}/c/${blob}.svg?theme=${theme}`;
  const md = `![Spotify now playing](${card})`;
  return layout(
    "Spindle: your card",
    `<h1>Your card is ready</h1>
<img class="preview" src="${esc(card)}" alt="Now playing card preview" width="495" height="170">
<textarea id="md" rows="3" readonly>${esc(md)}</textarea>
<button type="button" id="copy">Copy Markdown</button>
<p class="note">Anyone with this link can see your card. To stop it, rotate the client secret in your Spotify app.</p>
<p><a href="/">Make another</a></p>
<script>
document.getElementById("copy").addEventListener("click", async () => {
  const el = document.getElementById("md");
  try { await navigator.clipboard.writeText(el.value); } catch { el.select(); document.execCommand("copy"); }
});
</script>`
  );
}

function errorPage(message) {
  return layout("Spindle", `<h1>Spindle</h1><p>${esc(message)}</p><p><a href="/">Back to setup</a></p>`);
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
