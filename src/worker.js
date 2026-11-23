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
const themeFrom = (v) => (Object.hasOwn(THEMES, v) ? v : "paper");

// Card palettes. Keys map to the colour roles used in render().
// bg: card, edge: 1px border, ink: title, sub: artist, dim: times, tick: unplayed ticks,
// accent: played ticks, bars and pill, onAccent: text on the pill, cover: empty cover tile.
const THEMES = {
  paper: {
    bg: "#f7f1e5", edge: "#dccfb8", ink: "#2a1710", sub: "#6b5546", dim: "#85705f", tick: "#d9ccb4",
    accent: "#c8321c", onAccent: "#fff6ea", cover: "#e9dcc4", note: "#b8a487",
  },
  ink: {
    bg: "#18120f", edge: "#33291f", ink: "#f8f0e4", sub: "#bcab98", dim: "#9a8a79", tick: "#3a2f27",
    accent: "#ff5a3c", onAccent: "#18120f", cover: "#2a211b", note: "#5a4a3d",
  },
  signal: {
    bg: "#c8281a", edge: "#a81f13", ink: "#fff4e6", sub: "#ffe3d4", dim: "#ffe3d4", tick: "#e0584a",
    accent: "#fff4e6", onAccent: "#c8281a", cover: "#a81f13", note: "#e0584a",
  },
};
const THEME_NAMES = Object.keys(THEMES);

// Setup, result and error pages. Markup, copy and styles live here, apart from the card.
const THEME_LABELS = { paper: "Paper", ink: "Ink", signal: "Signal" };
const SAMPLE_TRACK = { title: "Midnight City", artist: "M83", duration: 243000, progress: 96000, live: true, playing: true };
const SAMPLE_COVER =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5f6d"/><stop offset=".55" stop-color="#7b2ff7"/><stop offset="1" stop-color="#0f2b5b"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="84" cy="36" r="18" fill="#ffd07a" opacity=".9"/><path d="M0 92 L28 60 L52 84 L80 52 L120 96 L120 120 L0 120Z" fill="#0b1230" opacity=".8"/></svg>'
  );
const sampleCard = (theme) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(render(SAMPLE_TRACK, SAMPLE_COVER, theme));

const REPO_URL = "https://github.com/BaselAshraf81/spinreadme";

const PAGE_CSS = `
:root {
  color-scheme: light;
  --paper: oklch(0.968 0.014 85);
  --sunk: oklch(0.935 0.02 85);
  --field: oklch(0.99 0.006 85);
  --ink: oklch(0.2 0.02 55);
  --ink-2: oklch(0.4 0.02 55);
  --ink-3: oklch(0.5 0.02 55);
  --rule: oklch(0.86 0.02 85);
  --rule-strong: oklch(0.7 0.025 70);
  --accent: oklch(0.5 0.19 35);
  --accent-hi: oklch(0.43 0.17 35);
  --display: 'Bricolage Grotesque', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif;
  --body: 'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, Menlo, monospace;
  --out: cubic-bezier(0.16, 1, 0.3, 1);
  --shadow: 0 1px 2px oklch(0.2 0.02 55 / 0.12), 0 12px 28px -8px oklch(0.2 0.02 55 / 0.35);
}
* { box-sizing: border-box; }
html { background: var(--paper); scrollbar-color: var(--rule-strong) var(--paper); accent-color: var(--accent); -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; display: flex; flex-direction: column; color: var(--ink);
  font: 400 1rem/1.6 var(--body); font-optical-sizing: auto; -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums; overflow-x: hidden;
}
::selection { background: var(--accent); color: var(--paper); }
a { color: inherit; text-decoration-color: var(--accent); text-decoration-thickness: 1.5px; text-underline-offset: 0.2em; }
a:hover { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
p, h1, h2, dl, dd, ol, fieldset { margin: 0; padding: 0; }
.skip { position: absolute; left: 1rem; top: -4rem; background: var(--ink); color: var(--paper); padding: 0.6rem 1rem; border-radius: 8px; z-index: 5; }
.skip:focus { top: 1rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

:root { --gutter: clamp(1.25rem, 4vw, 2.5rem); }
.bar, main { width: 100%; max-width: 70rem; margin-inline: auto; padding-inline: var(--gutter); }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-block: 1.25rem; }
.brand { display: inline-flex; align-items: center; gap: 0.6rem; font: 700 1.25rem/1 var(--display); letter-spacing: -0.02em; text-decoration: none; }
.brand:hover { color: var(--ink); }
.brand svg { width: 1.75rem; height: 1.75rem; transition: rotate 0.9s var(--out); }
.brand:hover svg, .brand:focus-visible svg { rotate: 200deg; }
.bar nav a { font-size: 0.9375rem; color: var(--ink-2); padding: 0.5rem 0; }
main { flex: 1; padding-block: clamp(1.5rem, 5vw, 3.5rem) 3rem; }

h1 { font: 800 clamp(2.5rem, 6.4vw, 4.75rem)/0.98 var(--display); letter-spacing: -0.04em; text-wrap: balance; }
h2 { font: 700 1.5rem/1.15 var(--display); letter-spacing: -0.025em; text-wrap: balance; }
.lede { margin-top: 1.5rem; font-size: 1.1875rem; line-height: 1.55; color: var(--ink-2); max-width: 36ch; text-wrap: pretty; }
.text { color: var(--ink-2); max-width: 62ch; text-wrap: pretty; }
.text + .text { margin-top: 0.75rem; }
.text a { color: var(--ink); }
.text a:hover { color: var(--accent); }
.fine { font-size: 0.875rem; line-height: 1.55; color: var(--ink-3); max-width: 60ch; text-wrap: pretty; }

/* hero: record sliding out of a sleeve */
.hero { display: grid; gap: 2.5rem; align-items: center; }
.stage { position: relative; overflow: hidden; background: var(--sunk); border-radius: 20px; padding: clamp(1rem, 3vw, 2rem); display: grid; gap: 1.25rem; }
.sleeve { position: relative; min-height: 0; }
.sleeve .rec { position: absolute; z-index: 0; right: -7%; top: 50%; width: 62%; max-width: 300px; translate: 0 -50%; animation: slide 1.1s 0.15s var(--out) both; }
.sleeve .rec svg { display: block; width: 100%; height: auto; }
.pv { position: relative; z-index: 1; display: none; width: 100%; max-width: 495px; height: auto; border-radius: 14px; box-shadow: var(--shadow); animation: lift 0.8s var(--out) both; }
.stage:has(input[value=paper]:checked) .pv-paper,
.stage:has(input[value=ink]:checked) .pv-ink,
.stage:has(input[value=signal]:checked) .pv-signal { display: block; }
@keyframes lift { from { opacity: 0; translate: 0 14px; filter: blur(6px); } }
@keyframes slide { from { translate: -42% -50%; rotate: -50deg; opacity: 0; } }

/* theme picker */
.picker { border: 0; min-width: 0; }
.picker legend { padding: 0; margin-bottom: 0.5rem; font-size: 0.875rem; color: var(--ink-2); }
.opts { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.opt { position: relative; cursor: pointer; }
.opt input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.opt span { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding: 0 1rem 0 0.75rem; border-radius: 999px; background: var(--field); box-shadow: inset 0 0 0 1px var(--rule-strong); font-size: 0.9375rem; font-weight: 600; color: var(--ink-2); transition: background-color 0.2s var(--out), color 0.2s var(--out), box-shadow 0.2s var(--out), scale 0.15s var(--out); }
.opt:hover span { box-shadow: inset 0 0 0 1px var(--ink); color: var(--ink); }
.opt:active span { scale: 0.96; }
.opt input:checked + span { background: var(--ink); color: var(--paper); box-shadow: inset 0 0 0 1px var(--ink); }
.opt input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 3px; }
.dot { width: 1.125rem; height: 1.125rem; border-radius: 50%; box-shadow: 0 0 0 1px oklch(1 0 0 / 0.35); }

/* steps */
.steps { list-style: none; margin-top: clamp(3rem, 8vw, 6rem); border-bottom: 1px solid var(--rule); }
.step { display: grid; gap: 1.25rem; padding-block: 2.25rem; border-top: 1px solid var(--rule); }
.step-head { display: flex; align-items: baseline; gap: 0.75rem; }
.n { font: 800 1.5rem/1 var(--display); color: var(--accent); min-width: 1.25rem; }
.step-body { display: grid; gap: 1.25rem; align-content: start; min-width: 0; }

.vals { display: grid; gap: 0.5rem; max-width: 40rem; }
.val { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr) auto; align-items: center; column-gap: 0.75rem; row-gap: 0.25rem; padding: 0.5rem 0.5rem 0.5rem 1rem; background: var(--field); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--rule); }
.val dt { font-size: 0.875rem; color: var(--ink-3); }
.val dd { font: 500 0.8125rem/1.5 var(--mono); overflow-wrap: normal; word-break: normal; user-select: all; }
.val.key { box-shadow: inset 0 0 0 1.5px var(--accent); }

.btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; min-height: 2.75rem; padding: 0 1rem; font: 600 0.9375rem/1 var(--body); color: var(--ink); background: var(--sunk); border: 0; border-radius: 9px; cursor: pointer; text-decoration: none; white-space: nowrap; transition: background-color 0.2s var(--out), color 0.2s var(--out), scale 0.15s var(--out); }
.btn:hover { background: var(--rule); color: var(--ink); }
.btn:active { scale: 0.96; }
.btn.done, .btn.done:hover { background: var(--ink); color: var(--paper); }
.btn.big { min-height: 3.25rem; padding: 0 1.5rem; font-size: 1rem; border-radius: 12px; background: var(--ink); color: var(--paper); }
.btn.big:hover { background: var(--accent); color: var(--paper); }
.btn.big.done { background: var(--accent); }

form { display: grid; gap: 1.25rem; max-width: 40rem; }
.field { display: grid; gap: 0.4rem; font-size: 0.9375rem; font-weight: 600; }
input[type=text], input[type=password] { width: 100%; min-height: 3rem; padding: 0 1rem; font: 500 0.9375rem/1 var(--mono); color: var(--ink); background: var(--field); border: 0; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--rule-strong); caret-color: var(--accent); transition: box-shadow 0.2s var(--out); }
input::placeholder { color: var(--ink-3); font-family: var(--body); font-weight: 400; opacity: 1; }
input[type=text]:hover, input[type=password]:hover { box-shadow: inset 0 0 0 1px var(--ink-3); }
input[type=text]:focus, input[type=password]:focus { outline: 0; box-shadow: inset 0 0 0 2px var(--accent); }
.go { display: flex; align-items: center; gap: 1rem 1.25rem; flex-wrap: wrap; }
.go .fine { flex: 1 1 16rem; }
.privacy { max-width: 40rem; padding-top: 0.25rem; }

/* result */
.done-grid { display: grid; gap: 2.5rem; margin-top: 2.5rem; align-items: start; }
.md { display: grid; gap: 0.75rem; }
.md label { font-size: 0.875rem; color: var(--ink-2); font-weight: 600; }
.md textarea { width: 100%; resize: none; min-height: 9rem; field-sizing: content; padding: 0.875rem 1rem; font: 500 0.8125rem/1.6 var(--mono); color: var(--ink); background: var(--field); border: 0; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--rule-strong); caret-color: var(--accent); overflow-wrap: anywhere; }
.md textarea:focus { outline: 0; box-shadow: inset 0 0 0 2px var(--accent); }
.after { display: grid; gap: 1.25rem; margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--rule); max-width: 44rem; }
.after h2 { font-size: 1.125rem; }
.after section { display: grid; gap: 0.4rem; }

/* error */
.err { position: relative; max-width: 34rem; padding-block: clamp(1rem, 6vw, 4rem); }
.err .lede { max-width: 40ch; }
.err .btn { margin-top: 2rem; }
.err-rec { position: absolute; z-index: -1; right: -14rem; top: -2rem; width: 26rem; opacity: 0.08; pointer-events: none; }
.err-rec svg { display: block; width: 100%; height: auto; }

.foot { width: calc(100% - 2 * var(--gutter)); max-width: calc(70rem - 2 * var(--gutter)); margin-inline: auto; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 2rem; padding-block: 1.5rem 2rem; border-top: 1px solid var(--rule); font-size: 0.875rem; color: var(--ink-3); }
.foot p { max-width: 52ch; }
.foot a { color: var(--ink-2); }
.foot a:hover { color: var(--accent); }

@media (min-width: 60rem) {
  .hero { grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 3.5rem; }
  .step { grid-template-columns: 15rem minmax(0, 1fr); gap: 3rem; }
  .done-grid { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 3rem; }
  .err-rec { left: calc(100% + 2rem); right: auto; top: -3rem; width: 30rem; opacity: 0.1; }
}
@media (max-width: 40rem) {
  .sleeve .rec { display: none; }
  .val { grid-template-columns: minmax(0, 1fr) auto; padding-block: 0.75rem 0.5rem; }
  .val dt { grid-column: 1 / -1; }
  .go .btn.big { width: 100%; }
}
@media (max-width: 26rem) {
  .val { grid-template-columns: minmax(0, 1fr); }
  .val .btn { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

const COPY_JS = `
const live = document.getElementById("live");
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const src = b.dataset.copy;
  const text = src.startsWith("#") ? document.querySelector(src).value : src;
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  const was = b.textContent; b.textContent = "Copied"; b.classList.add("done");
  if (live) live.textContent = "Copied to clipboard";
  setTimeout(() => { b.textContent = was; b.classList.remove("done"); if (live) live.textContent = ""; }, 1600);
});
`;

// A record drawn once and reused: header mark, hero sleeve, error page.
const RECORD_SVG = (grooves = true) =>
  `<svg viewBox="0 0 200 200" aria-hidden="true" focusable="false"><circle cx="100" cy="100" r="99" fill="var(--ink)"/>${
    grooves
      ? [90, 82, 74, 66, 58, 50].map((r) => `<circle cx="100" cy="100" r="${r}" fill="none" stroke="oklch(1 0 0 / 0.1)" stroke-width="1"/>`).join("")
      : ""
  }<path d="M100 100 L100 1 A99 99 0 0 1 169 29 Z" fill="oklch(1 0 0 / 0.1)"/><path d="M100 100 L100 199 A99 99 0 0 1 31 171 Z" fill="oklch(1 0 0 / 0.1)"/><circle cx="100" cy="100" r="32" fill="var(--accent)"/><circle cx="100" cy="100" r="4" fill="var(--paper)"/></svg>`;

function layout(title, body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f6f1e7">
<meta name="description" content="A now playing card for your GitHub README that shows what you are playing on Spotify.">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
  <a class="brand" href="/">${RECORD_SVG(false)}<span>spinreadme</span></a>
  <nav aria-label="Project"><a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></nav>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <p>Made by <a href="https://baselashraf.com" target="_blank" rel="noopener">Basel Ashraf</a>. Not affiliated with Spotify.</p>
  <a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a>
</footer>
<div id="live" class="sr" role="status" aria-live="polite"></div>
<script>${COPY_JS}${script}</script>
</body>
</html>`;
}

const copyBtn = (v, name) => `<button type="button" class="btn" data-copy="${esc(v)}" aria-label="Copy ${esc(name)}">Copy</button>`;
// Break only at slashes, never inside a word, so long URLs stay readable.
const breakable = (s) => esc(s).replace(/(:\/\/|\/)/g, "$1<wbr>");
const val = (name, v, cls = "") =>
  `<div class="val ${cls}"><dt>${esc(name)}</dt><dd>${breakable(v)}</dd>${copyBtn(v, name)}</div>`;

const themeSwatch = (n) =>
  `<i class="dot" style="background:linear-gradient(135deg,${THEMES[n].bg} 50%,${THEMES[n].accent} 50%)"></i>`;

function setupPage(origin) {
  const redirect = `${origin}/callback`;
  const previews = THEME_NAMES.map(
    (n) => `<img class="pv pv-${n}" src="${sampleCard(n)}" alt="Sample ${THEME_LABELS[n] || n} card: Midnight City by M83" width="495" height="150">`
  ).join("");
  const opts = THEME_NAMES.map(
    (n, i) =>
      `<label class="opt"><input type="radio" name="theme" form="setup" value="${n}"${i === 0 ? " checked" : ""}><span>${themeSwatch(n)}${THEME_LABELS[n] || n}</span></label>`
  ).join("");
  return layout(
    "spinreadme: a now playing card for your GitHub README",
    `<section class="hero" aria-labelledby="top">
  <div>
    <h1 id="top">Show what you are playing on your GitHub profile.</h1>
    <p class="lede">A now playing card for your README. It shows the Spotify track you are playing and keeps the last one when you stop.</p>
  </div>
  <div class="stage">
    <div class="sleeve">
      <div class="rec">${RECORD_SVG()}</div>
      ${previews}
    </div>
    <fieldset class="picker">
      <legend>Theme</legend>
      <div class="opts">${opts}</div>
    </fieldset>
  </div>
</section>
<ol class="steps">
  <li class="step">
    <div class="step-head"><span class="n" aria-hidden="true">1</span><h2>Create a Spotify app</h2></div>
    <div class="step-body">
      <p class="text">The card reads your playback through a Spotify app that you own. Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify developer dashboard</a>, choose Create app, and enter these values. Under APIs used, tick Web API.</p>
      <dl class="vals">
        ${val("App name", "spinreadme")}
        ${val("App description", "Now playing card for my GitHub README")}
        ${val("Redirect URI", redirect, "key")}
      </dl>
      <p class="fine">Add the redirect URI with the Add button, then save the app. It has to match exactly, with no trailing slash.</p>
    </div>
  </li>
  <li class="step">
    <div class="step-head"><span class="n" aria-hidden="true">2</span><h2>Paste the credentials</h2></div>
    <div class="step-body">
      <p class="text">In your new app, open Settings. Copy the Client ID, then choose View client secret and copy that too.</p>
      <form id="setup" method="post" action="/connect" autocomplete="off">
        <label class="field">Client ID<input type="text" name="client_id" required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Paste the Client ID" pattern="[A-Za-z0-9]{8,128}" title="Letters and numbers only"></label>
        <label class="field">Client secret<input type="password" name="client_secret" required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Paste the client secret" pattern="[A-Za-z0-9]{8,128}" title="Letters and numbers only"></label>
        <div class="go">
          <button type="submit" class="btn big">Connect Spotify</button>
          <p class="fine">Spotify will ask you to allow read access to your currently playing and recently played tracks. Nothing else is requested.</p>
        </div>
      </form>
      <p class="fine privacy">Your client ID, client secret and refresh token are encrypted (AES-256-GCM) into your card URL. spinreadme has no database. It does cache Spotify access tokens for about 50 minutes, so each view of your card does not call Spotify again.</p>
    </div>
  </li>
  <li class="step">
    <div class="step-head"><span class="n" aria-hidden="true">3</span><h2>Add it to your README</h2></div>
    <div class="step-body">
      <p class="text">After you approve access, you get one line of Markdown. Paste it into the README of your profile repository, the one named after your GitHub username, and commit.</p>
    </div>
  </li>
</ol>`
  );
}

function resultPage(origin, blob, theme) {
  const cardUrl = (t) => `${origin}/c/${blob}.svg?theme=${t}`;
  const md = (t) => `![Spotify now playing](${cardUrl(t)})`;
  const opts = THEME_NAMES.map(
    (n) =>
      `<label class="opt"><input type="radio" name="theme" value="${n}"${n === theme ? " checked" : ""}><span>${themeSwatch(n)}${THEME_LABELS[n] || n}</span></label>`
  ).join("");
  const script = `
const base = ${JSON.stringify(`${origin}/c/${blob}.svg?theme=`)};
const pv = document.getElementById("pv"), md = document.getElementById("md");
document.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener("change", () => {
  pv.src = base + r.value; md.value = "![Spotify now playing](" + base + r.value + ")";
}));`;
  return layout(
    "spinreadme: your card is ready",
    `<h1>Your card is ready.</h1>
<p class="lede">Pick a theme, copy the Markdown and paste it into your profile README.</p>
<div class="done-grid">
  <div class="stage">
    <div class="sleeve">
      <div class="rec">${RECORD_SVG()}</div>
      <img id="pv" class="pv" style="display:block" src="${esc(cardUrl(theme))}" alt="Your now playing card" width="495" height="150">
    </div>
    <fieldset class="picker">
      <legend>Theme</legend>
      <div class="opts">${opts}</div>
    </fieldset>
  </div>
  <div class="md">
    <label for="md">Markdown for your README</label>
    <textarea id="md" rows="5" readonly spellcheck="false">${esc(md(theme))}</textarea>
    <button type="button" class="btn big" data-copy="#md">Copy Markdown</button>
  </div>
</div>
<div class="after">
  <section>
    <h2>Where it goes</h2>
    <p class="text">Add the line to the README of your profile repository, the one named after your GitHub username, and commit. GitHub can take a minute or so to refresh the image.</p>
  </section>
  <section>
    <h2>Keep the URL to yourself</h2>
    <p class="text">The URL contains your Spotify credentials in encrypted form. Anyone who has it can see what you are playing. To switch the card off, delete the app in your Spotify developer dashboard.</p>
  </section>
  <p class="text"><a href="/">Make another card</a></p>
</div>`,
    script
  );
}

function errorPage(message) {
  return layout(
    "spinreadme: something went wrong",
    `<section class="err">
  <div class="err-rec" aria-hidden="true">${RECORD_SVG()}</div>
  <h1>That did not work.</h1>
  <p class="lede">${esc(message)}</p>
  <a class="btn big" href="/">Back to setup</a>
</section>`
  );
}
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "â€¦" : s);
const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function render(track, cover, theme = "paper") {
  const c = THEMES[theme] || THEMES.paper;
  const live = !!(track && track.playing);
  const label = !track ? "NO DATA" : track.playing ? "NOW PLAYING" : track.live ? "PAUSED" : "LAST PLAYED";
  const title = track ? clip(track.title, 26) : "Nothing playing";
  const artist = track ? clip(track.artist, 40) : "Check back later";
  const X = 150, W = 327; // text column and its width
  const frac = track && track.duration ? Math.min(track.progress / track.duration, 1) : 0;
  const startW = (W * frac).toFixed(1);
  const remain = track ? Math.max((track.duration - track.progress) / 1000, 0) : 0;
  const fill = live
    ? `<animate attributeName="width" from="${startW}" to="${W}" dur="${remain.toFixed(1)}s" fill="freeze"/>`
    : "";
  const pillW = Math.round((live ? 38 : 28) + label.length * 7.2);
  const pill = live
    ? `<rect x="${X}" y="18" width="${pillW}" height="20" rx="10" fill="${c.accent}"/>
  <circle class="dot" cx="${X + 11}" cy="28" r="2.5" fill="${c.onAccent}"/>
  <text x="${X + 20}" y="31.5" class="tag" fill="${c.onAccent}">${label}</text>`
    : `<rect x="${X + 0.5}" y="18.5" width="${pillW - 1}" height="19" rx="9.5" fill="none" stroke="${c.dim}"/>
  <text x="${X + 10}" y="31.5" class="tag" fill="${c.dim}">${label}</text>`;
  const art = cover
    ? `<image href="${cover}" x="18" y="18" width="114" height="114" clip-path="url(#round)" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="18" y="18" width="114" height="114" rx="10" fill="${c.cover}"/>
  <g fill="${c.note}"><ellipse cx="68" cy="99" rx="11" ry="8" transform="rotate(-18 68 99)"/><rect x="77" y="52" width="4.5" height="46"/><path d="M81 52 Q101 58 98 80 Q92 68 81 68Z"/></g>`;
  const bars = [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<rect class="eq${live ? " on" : ""}" x="${445 + i * 7.5}" y="18" width="4" height="20" rx="2" fill="${c.accent}" style="animation-delay:-${(i * 0.23).toFixed(2)}s;animation-duration:${(0.62 + i * 0.11).toFixed(2)}s"/>`
    )
    .join("");
  const ticks = `<line x1="${X + 1.5}" y1="106" x2="${X + W}" y2="106" stroke-width="16" stroke-dasharray="3 4.4"`;
  const progress = track
    ? `<clipPath id="done"><rect x="${X}" y="96" width="${startW}" height="20">${fill}</rect></clipPath>
  ${ticks} stroke="${c.tick}"/>
  <g clip-path="url(#done)">${ticks} stroke="${c.accent}"/></g>
  <text x="${X}" y="132" class="time" fill="${c.dim}">${mmss(track.progress)}</text>
  <text x="${X + W}" y="132" class="time" fill="${c.dim}" text-anchor="end">${mmss(track.duration)}</text>`
    : `${ticks} stroke="${c.tick}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="150" viewBox="0 0 495 150" role="img" aria-label="${esc(label)}: ${esc(title)} by ${esc(artist)}">
  <defs>
    <clipPath id="round"><rect x="18" y="18" width="114" height="114" rx="10"/></clipPath>
    <clipPath id="col"><rect x="${X}" y="0" width="${W}" height="150"/></clipPath>
  </defs>
  <style>
    text { font-family: 'Helvetica Neue', 'Segoe UI', Arial, sans-serif; }
    .tag { font-size: 9.5px; font-weight: 800; letter-spacing: 1.5px; }
    .title { font-size: 22px; font-weight: 800; letter-spacing: -0.6px; fill: ${c.ink}; }
    .artist { font-size: 14px; font-weight: 500; fill: ${c.sub}; }
    .time { font-family: 'SF Mono', Consolas, Menlo, monospace; font-size: 10px; font-weight: 600; }
    .eq { transform-box: fill-box; transform-origin: 50% 100%; transform: scaleY(0.2); }
    .eq.on { animation: bounce 0.8s ease-in-out infinite alternate; }
    @keyframes bounce { from { transform: scaleY(0.2); } to { transform: scaleY(1); } }
    .dot { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.3; } }
  </style>
  <rect width="495" height="150" rx="16" fill="${c.bg}"/>
  <rect x="0.5" y="0.5" width="494" height="149" rx="15.5" fill="none" stroke="${c.edge}"/>
  ${art}
  ${pill}
  ${bars}
  <g clip-path="url(#col)">
    <text x="${X}" y="66" class="title">${esc(title)}</text>
    <text x="${X}" y="86" class="artist">${esc(artist)}</text>
  </g>
  ${progress}
</svg>`;
}
