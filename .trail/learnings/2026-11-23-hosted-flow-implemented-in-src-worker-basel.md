---
title: Hosted flow implemented in src/worker.js
author: Basel
date: 2026-11-23
branch: main
id: l-2d643021
scope: repo
status: active
src: agent
touches:
  - src/worker.js
---

src/worker.js now serves the hosted flow: GET / setup page, POST /connect (state sealed with purpose 'state', 10 min TTL), GET /callback (exchanges code, seals {id, secret, refresh} as purpose 'blob', shows result page), GET /c/<blob>.svg?theme= (decrypts, caches access token per blob via caches.default for 3000s, falls back to an empty card on bad blobs). Self-hosted GET /card.svg still reads SPOTIFY_* env. SPINDLE_KEY format: standard base64 of exactly 32 random bytes (AES-256), generate with: openssl rand -base64 32. Token layout: base64url(version byte 0x01 + 12-byte IV + AES-GCM ciphertext). Themes: vinyl (default), ice, paper; render() takes a theme palette.
