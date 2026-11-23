---
title: Hosted setup site plan
author: Basel
date: 2026-11-23
branch: main
id: l-4afb11c8
scope: repo
status: active
src: agent
touches:
  - src/worker.js
---

Plan for src/worker.js: add a setup page and a /c/<encrypted-blob>.svg route so users need no self-hosting. Visitor creates own Spotify app, pastes client id and secret, signs in, gets an AES-GCM encrypted URL (key in a Worker secret, no database). Runs on the Cloudflare Workers free plan. Self-hosting stays supported. Spotify dev-mode apps cap at 25 users, bring-your-own-app avoids it. Altare and the VPS are not needed.
