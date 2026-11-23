# spindle

A vinyl-style "now playing" card for your GitHub profile README, fed by the Spotify API.

![now playing](assets/playing.svg)

The record spins while a track plays, the bars bounce, and the progress bar fills in real time. When nothing is playing it shows your last played track with a still record.

![idle](assets/idle.svg)

It runs as a single Cloudflare Worker with no dependencies. The Worker asks Spotify what you are listening to, embeds the album cover in an SVG and returns it. GitHub only displays images, so the cover has to be inlined; that is why this is rendered server side.

## Setup

You need a Spotify account, a Cloudflare account (the free plan is enough) and Node 18 or newer.

1. Create an app at https://developer.spotify.com/dashboard. Add `http://127.0.0.1:8888/callback` as a redirect URI.
2. Get a refresh token:

   ```
   npm install
   SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy npm run token
   ```

   On PowerShell, set the variables with `$env:SPOTIFY_CLIENT_ID="xxx"` first. Approve the access request in the browser and copy the token printed in the terminal.
3. Store the secrets in the Worker:

   ```
   npx wrangler secret put SPOTIFY_CLIENT_ID
   npx wrangler secret put SPOTIFY_CLIENT_SECRET
   npx wrangler secret put SPOTIFY_REFRESH_TOKEN
   ```
4. Deploy:

   ```
   npm run deploy
   ```

   Wrangler prints the URL of your Worker, for example `https://spindle.your-name.workers.dev`.
5. Add it to your profile README:

   ```markdown
   ![now playing](https://spindle.your-name.workers.dev/card.svg)
   ```

   To link the card to your Spotify profile, wrap it:

   ```markdown
   [![now playing](https://spindle.your-name.workers.dev/card.svg)](https://open.spotify.com/user/your-id)
   ```

## Local development

`npm run dev` serves the card at http://localhost:8787 using secrets from a `.dev.vars` file:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
```

`npm run preview` regenerates the sample cards in `assets/` without calling Spotify.

## Notes

- The card needs the scopes `user-read-currently-playing` and `user-read-recently-played`. Nothing else is requested.
- GitHub proxies images through its own cache, so the card can lag by a minute or so when you load the profile. The progress bar and spinning record animate on their own between loads.
- Podcasts and ads are not shown as tracks. In those cases the card falls back to your last played track.
- Colors, sizes and layout are all in `render()` in `src/worker.js`.

## License

MIT
