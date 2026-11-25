/**
 * The light in the room: a faint, slow gradient behind the window, and the colour
 * tokens derived from the chosen mood. Each mood stays within one family of hues.
 */

import { byId, mulberry32, prefersReducedMotion } from "./util.js";
import { emit, on } from "./store.js";
import { setSceneHues } from "./scenes.js";

/* main hue first; the rest are close neighbours */
const MOODS = {
  mist: [254, 274, 238, 292],
  salt: [214, 232, 194, 246],
  heather: [316, 336, 296, 350],
  moss: [164, 182, 148, 200],
};

const W = 160;
const H = 100;
const FRAME_MS = 1000 / 15;

const canvas = byId("aura");
const ctx = canvas.getContext("2d", { alpha: false });

let mood = "mist";
let blobs = [];
let base = { cur: null, to: null };
let rafId = 0;
let last = 0;

const isDark = () => document.documentElement.dataset.theme === "dark";
const tone = (hue) => (isDark() ? [0.262, 0.042, hue] : [0.912, 0.032, hue]);
const ground = (hue) => (isDark() ? [0.186, 0.024, hue] : [0.957, 0.012, hue]);
const css = ([l, c, h], alpha = 1) => `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(1)} / ${alpha})`;
const mixHue = (a, b, t) => (a + ((((b - a + 540) % 360) - 180) * t) + 360) % 360;

function retarget() {
  const hues = MOODS[mood];
  blobs.forEach((b, i) => {
    b.to = tone(hues[i % hues.length]);
  });
  base.to = ground(hues[0]);
}
function settle() {
  for (const b of [base, ...blobs]) b.cur = [...b.to];
}

export function setMood(name) {
  mood = MOODS[name] ? name : "mist";
  const hues = MOODS[mood];
  const root = document.documentElement.style;
  root.setProperty("--h", String(hues[0]));
  // Orb, progress and the primary button: a little more colour than the room itself.
  [hues[0], hues[1], hues[3], hues[2]].forEach((hue, i) => root.setProperty(`--c${i + 1}`, css([0.72, 0.105, hue])));
  for (const b of document.querySelectorAll("#moodList button")) b.setAttribute("aria-checked", String(b.dataset.mood === mood));
  setSceneHues(hues);
  retarget();
  wake();
  // Canvases read the tokens once, so tell them while and after the tokens ease over.
  emit("palette");
  setTimeout(() => emit("palette"), 450);
  setTimeout(() => emit("palette"), 950);
}

function build() {
  const rnd = mulberry32(41);
  const spots = [[0.08, 0.06], [0.9, 0.1], [0.92, 0.88], [0.12, 0.94], [0.52, 0.4]];
  blobs = spots.map(([x, y]) => ({
    x, y,
    r: 0.4 + rnd() * 0.18,
    ax: 0.04 + rnd() * 0.05, ay: 0.05 + rnd() * 0.06,
    fx: 0.012 + rnd() * 0.012, fy: 0.01 + rnd() * 0.012,
    p: rnd() * 7, q: rnd() * 7,
    cur: null, to: null,
  }));
  retarget();
  settle();
}

function ease(pair, k) {
  const { cur, to } = pair;
  cur[0] += (to[0] - cur[0]) * k;
  cur[1] += (to[1] - cur[1]) * k;
  cur[2] = mixHue(cur[2], to[2], k);
}

function render(now, dt) {
  const k = dt ? 1 - Math.exp(-dt / 420) : 0;
  ease(base, k);
  const t = now / 1000;
  ctx.fillStyle = css(base.cur);
  ctx.fillRect(0, 0, W, H);
  for (const b of blobs) {
    ease(b, k);
    const x = (b.x + Math.sin(t * b.fx * 6.28 + b.p) * b.ax) * W;
    const y = (b.y + Math.cos(t * b.fy * 6.28 + b.q) * b.ay) * H;
    const g = ctx.createRadialGradient(x, y, 0, x, y, b.r * W);
    g.addColorStop(0, css(b.cur, 0.9));
    g.addColorStop(0.5, css(b.cur, 0.4));
    g.addColorStop(1, css(b.cur, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function wake() {
  if (prefersReducedMotion()) {
    settle();
    render(0, 0);
    return;
  }
  if (rafId || document.hidden) return;
  const loop = (now) => {
    rafId = document.hidden ? 0 : requestAnimationFrame(loop);
    if (now - last < FRAME_MS - 2) return;
    const dt = Math.min(200, now - last);
    last = now;
    render(now, dt);
  };
  rafId = requestAnimationFrame(loop);
}

/** "#rrggbb" of the backdrop's top edge, so the native title bar can continue it. */
export function titleBarColor() {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const p = probe.getContext("2d", { willReadFrequently: true });
  p.drawImage(canvas, 0, 0, W, 3, 0, 0, 1, 1);
  return `#${[...p.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function initAura() {
  canvas.width = W;
  canvas.height = H;
  build();
  on("theme", () => {
    // Snap instead of easing: the theme transition captures the new look immediately.
    retarget();
    settle();
    render(performance.now(), 0);
  });
  document.addEventListener("visibilitychange", () => !document.hidden && wake());
  setMood("mist");
  settle();
  render(performance.now(), 0);
}
