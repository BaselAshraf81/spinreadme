# Spindle: plan

Live "now playing" vinyl card for GitHub READMEs. Hosted at `spindle.baselashraf.com`. No self-hosting needed; self-hosting still works.

## Stack
- One Cloudflare Worker (free plan), no framework, no database, no runtime deps.
- Custom domain `spindle.baselashraf.com` (zone already on Cloudflare).
- Static setup page served by the same Worker (inline HTML/CSS/JS).

## Why bring-your-own Spotify app
Spotify dev-mode apps allow 25 users, added by email by hand. Extended quota is rarely granted. So each user makes their own free app (2 min) and pastes client id + secret. Their app's cap never matters.

## Flow
1. `/` setup page: steps to create a Spotify app (exact values to paste, redirect URI `https://spindle.baselashraf.com/callback`), form for client id + secret, theme pick.
2. `POST /connect`: encrypt {id, secret} into a short-lived `state`, redirect to Spotify authorize (scopes: `user-read-currently-playing user-read-recently-played`).
3. `/callback`: decrypt state, exchange code for refresh token, encrypt {id, secret, refresh} into a blob, show the result page: card preview + copy-ready Markdown.
4. `/c/<blob>.svg?theme=`: decrypt, refresh access token, fetch track, inline cover, render SVG.

## Security
- AES-GCM, 256-bit key in Worker secret `SPINDLE_KEY`. Blob = base64url(iv + ciphertext). Includes a version byte for key rotation.
- Nothing stored server-side. Revoke = rotate secret in Spotify dashboard.
- Never log credentials or blobs. `state` expires after 10 min.

## Card
- Existing vinyl design (`render()`), plus 2-3 themes via `?theme=`.
- Access token cached per blob in memory/Cache API for ~50 min to save Spotify calls.
- `Cache-Control: no-cache` so GitHub's camo refetches.

## Out of scope
Tests, accounts, database, analytics.
