const SCOPES = "user-read-currently-playing user-read-recently-played";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1/me/player";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/card.svg") {
      return new Response("Not found", { status: 404 });
    }
    let track;
    try {
      const token = await getAccessToken(env);
      track = await getTrack(token);
    } catch (e) {
      track = null;
    }
    const svg = render(track, await coverData(track));
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=0, s-maxage=0, no-cache",
      },
    });
  },
};

async function getAccessToken(env) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.SPOTIFY_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) throw new Error("token");
  return (await res.json()).access_token;
}

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

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function render(track, cover) {
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
    : `<rect x="20" y="25" width="120" height="120" rx="8" fill="#241d19"/>
       <text x="80" y="95" font-size="40" text-anchor="middle" fill="#4a3d35">♪</text>`;
  const bars = [0, 1, 2, 3]
    .map(
      (i) =>
        `<rect class="eq${spinning ? " on" : ""}" x="${446 + i * 8}" y="24" width="4" height="16" rx="2" fill="#f2a43a" style="animation-delay:${i * 0.17}s;animation-duration:${(0.7 + i * 0.13).toFixed(2)}s"/>`
    )
    .join("");
  const progress = track
    ? `<rect x="215" y="124" width="${BAR}" height="4" rx="2" fill="#2e2621"/>
       <rect x="215" y="124" width="${startW}" height="4" rx="2" fill="#f2a43a">${progressAnim}</rect>
       <text x="215" y="148" class="mono dim">${mmss(track.progress)}</text>
       <text x="455" y="148" class="mono dim" text-anchor="end">${mmss(track.duration)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="170" viewBox="0 0 495 170" role="img" aria-label="${esc(label)}: ${esc(title)} by ${esc(artist)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1c1613"/><stop offset="1" stop-color="#0f0c0a"/>
    </linearGradient>
    <clipPath id="round"><rect x="20" y="25" width="120" height="120" rx="8"/></clipPath>
    <radialGradient id="glow" cx="0.2" cy="0.5" r="0.8">
      <stop offset="0" stop-color="#f2a43a" stop-opacity="0.12"/><stop offset="1" stop-color="#f2a43a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <style>
    text { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
    .mono { font-family: 'SF Mono', Consolas, Menlo, monospace; font-size: 10px; }
    .dim { fill: #8a7b6f; }
    .tag { font-size: 10px; font-weight: 600; letter-spacing: 2.4px; fill: #f2a43a; }
    .title { font-size: 19px; font-weight: 700; fill: #f4ece4; }
    .artist { font-size: 13px; fill: #b8a99b; }
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
  <rect x="0.5" y="0.5" width="494" height="169" rx="13.5" fill="none" stroke="#3a2f28"/>

  <g class="spin">
    <circle cx="140" cy="85" r="64" fill="#0a0807"/>
    <circle cx="140" cy="85" r="58" fill="none" stroke="#1d1815" stroke-width="1"/>
    <circle cx="140" cy="85" r="52" fill="none" stroke="#1d1815" stroke-width="1"/>
    <circle cx="140" cy="85" r="46" fill="none" stroke="#1d1815" stroke-width="1"/>
    <circle cx="140" cy="85" r="40" fill="none" stroke="#1d1815" stroke-width="1"/>
    <circle cx="140" cy="85" r="34" fill="none" stroke="#1d1815" stroke-width="1"/>
    <path d="M140 85 L140 21 A64 64 0 0 1 185 40 Z" fill="#fff" opacity="0.05"/>
    <path d="M140 85 L140 149 A64 64 0 0 1 95 130 Z" fill="#fff" opacity="0.05"/>
    <circle cx="140" cy="85" r="21" fill="#f2a43a"/>
    <circle cx="140" cy="85" r="15" fill="none" stroke="#c9822a" stroke-width="1"/>
    <circle cx="140" cy="85" r="3.5" fill="#0f0c0a"/>
  </g>
  ${art}
  <rect x="20" y="25" width="120" height="120" rx="8" fill="none" stroke="#fff" stroke-opacity="0.08"/>

  <circle class="${spinning ? "dot" : ""}" cx="219" cy="35" r="3" fill="#f2a43a"/>
  <text x="228" y="39" class="tag">${label}</text>
  ${bars}
  <text x="215" y="76" class="title">${esc(title)}</text>
  <text x="215" y="98" class="artist">${esc(artist)}</text>
  ${progress}
</svg>`;
}
