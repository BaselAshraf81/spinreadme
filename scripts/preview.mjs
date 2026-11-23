// Writes sample cards to assets/ so you can see the design without Spotify.
import { writeFileSync } from "node:fs";
import { render } from "../src/worker.js";

const cover = "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5f6d"/><stop offset="0.55" stop-color="#7b2ff7"/><stop offset="1" stop-color="#0f2b5b"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="210" cy="90" r="45" fill="#ffd07a" opacity="0.9"/><path d="M0 230 L70 150 L130 210 L200 130 L300 240 L300 300 L0 300Z" fill="#0b1230" opacity="0.8"/></svg>`).toString("base64");
const t = { title: "Midnight City", artist: "M83", duration: 243000, progress: 96000, live: true, playing: true };
const themes = ["paper", "ink", "signal"];
const states = {
  playing: t,
  paused: { ...t, playing: false },
  last: { ...t, playing: false, live: false, progress: 0 },
};
for (const theme of themes) {
  for (const [name, track] of Object.entries(states)) writeFileSync(`assets/${theme}-${name}.svg`, render(track, cover, theme));
  writeFileSync(`assets/${theme}-empty.svg`, render(null, null, theme));
  writeFileSync(`assets/${theme}-nocover.svg`, render(t, null, theme));
}
