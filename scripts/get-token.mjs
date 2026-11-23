// Gets a Spotify refresh token. Run: SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node scripts/get-token.mjs
import http from "node:http";
import { exec } from "node:child_process";

const id = process.env.SPOTIFY_CLIENT_ID;
const secret = process.env.SPOTIFY_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.");
  process.exit(1);
}
const redirect = "http://127.0.0.1:8888/callback";
const scope = "user-read-currently-playing user-read-recently-played";
const auth =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({ client_id: id, response_type: "code", redirect_uri: redirect, scope });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8888");
  if (url.pathname !== "/callback") return res.end();
  const code = url.searchParams.get("code");
  if (!code) {
    res.end("No code returned: " + (url.searchParams.get("error") || "unknown"));
    return server.close();
  }
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }),
  });
  const data = await r.json();
  res.end(data.refresh_token ? "Done. You can close this tab." : "Failed. See the terminal.");
  console.log(data.refresh_token ? `\nRefresh token:\n${data.refresh_token}\n` : data);
  server.close();
});

server.listen(8888, "127.0.0.1", () => {
  console.log("Opening browser. If nothing opens, visit:\n" + auth);
  const open = process.platform === "win32" ? `start "" "${auth}"` : process.platform === "darwin" ? `open "${auth}"` : `xdg-open "${auth}"`;
  exec(open);
});
