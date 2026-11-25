/**
 * The empty stage: threads of sound. Two bundles of fine lines drift across a soft
 * ground and swell with the voice. Three tones double as a legibility test for
 * subtitles: a dark frame, a mid-tone frame and a near-white one.
 */

import { clamp, prefersReducedMotion } from "./util.js";

const FRAME_MS = 1000 / 30;

/* l/c for ground top, ground bottom, glow; thread colour; hero text tone */
const TONES = {
  dark: { tone: "dark", top: [0.245, 0.042], bottom: [0.165, 0.03], glow: [0.46, 0.085, 0.75], thread: [0.86, 0.075], alpha: 0.4, mode: "lighter" },
  mid: { tone: "light", top: [0.8, 0.052], bottom: [0.69, 0.062], glow: [0.88, 0.045, 0.8], thread: [0.99, 0.015], alpha: 0.5, mode: "source-over" },
  light: { tone: "light", top: [0.975, 0.008], bottom: [0.93, 0.02], glow: [0.995, 0.006, 0.9], thread: [0.6, 0.11], alpha: 0.24, mode: "source-over" },
};

/* each bundle: where it sits, how tall it swings, how it is woven */
const BUNDLES = [
  { y: 0.57, amp: 0.19, spread: 0.26, lines: 38, f1: 1.15, f2: 2.3, s1: 0.11, s2: -0.07, twist: 2.5, hue: [0, 1] },
  { y: 0.66, amp: 0.14, spread: 0.2, lines: 30, f1: 0.85, f2: 1.9, s1: -0.08, s2: 0.095, twist: -2.1, hue: [3, 2] },
];

let canvas = null;
let ctx = null;
let scene = "dark";
let hues = [254, 274, 238, 292];
let W = 0;
let H = 0;
let running = false;
let rafId = 0;
let lastDraw = 0;
let bornAt = 0;
const lean = { x: 0, y: 0, tx: 0, ty: 0 };
let breath = 0;
let swell = 0;

export const sceneHues = () => hues;

export function initScenes(node) {
  canvas = node;
  ctx = canvas.getContext("2d", { alpha: false });
  bornAt = performance.now();
  new ResizeObserver(resize).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  const stage = canvas.parentElement;
  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    lean.tx = (e.clientX - r.left) / r.width - 0.5;
    lean.ty = (e.clientY - r.top) / r.height - 0.5;
  });
  stage.addEventListener("pointerleave", () => {
    lean.tx = lean.ty = 0;
  });
  resize();
}

/** 0..1 loudness: the threads swell with the voice. */
export function setBreath(v) {
  breath = v;
}

/** The backdrop follows the window's mood. */
export function setSceneHues(next) {
  hues = next;
  if (canvas) render(performance.now());
}

export function setScene(name) {
  if (!TONES[name]) return;
  scene = name;
  canvas.parentElement.dataset.tone = TONES[name].tone;
  render(performance.now());
}

export function setScenesActive(on) {
  running = on;
  if (on) {
    resize();
    start();
  } else {
    stop();
  }
}

function resize() {
  if (!canvas?.clientWidth) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr);
  const hh = Math.round(canvas.clientHeight * dpr);
  if (w === W && hh === H) return;
  W = canvas.width = w;
  H = canvas.height = hh;
  render(performance.now());
}

function start() {
  if (!running || document.hidden || rafId) return;
  if (prefersReducedMotion()) return render(0);
  const loop = (now) => {
    rafId = running && !document.hidden ? requestAnimationFrame(loop) : 0;
    if (now - lastDraw < FRAME_MS - 2) return;
    lastDraw = now;
    render(now);
  };
  rafId = requestAnimationFrame(loop);
}
function stop() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

const ok = (l, c, h, a = 1) => `oklch(${l} ${c} ${h} / ${a})`;

function render(now) {
  if (!W || !H) return;
  const t = now / 1000;
  const q = TONES[scene];
  lean.x += (lean.tx - lean.x) * 0.06;
  lean.y += (lean.ty - lean.y) * 0.06;
  swell += (breath - swell) * 0.22;

  ctx.globalCompositeOperation = "source-over";
  const g = ctx.createLinearGradient(0, 0, W * 0.25, H);
  g.addColorStop(0, ok(q.top[0], q.top[1], hues[0]));
  g.addColorStop(1, ok(q.bottom[0], q.bottom[1], hues[1]));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // two pools of light behind the threads
  const pools = [
    [0.3 + Math.sin(t * 0.07) * 0.05 - lean.x * 0.08, 0.72, 0.55, hues[2], q.glow[2]],
    [0.78 + Math.cos(t * 0.06) * 0.05 - lean.x * 0.12, 0.46, 0.48, hues[3], q.glow[2] * 0.7],
  ];
  for (const [x, y, r, hue, a] of pools) {
    const p = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * W * (1 + swell * 0.16));
    p.addColorStop(0, ok(q.glow[0], q.glow[1], hue, a));
    p.addColorStop(1, ok(q.glow[0], q.glow[1], hue, 0));
    ctx.fillStyle = p;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.globalCompositeOperation = q.mode;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(0.7, W / 1500);
  const intro = clamp((now - bornAt) / 1800, 0, 1);
  const reach = 1 - (1 - intro) ** 3;
  for (const b of BUNDLES) paintBundle(b, q, t, reach);
  ctx.globalCompositeOperation = "source-over";

  // settle the frame's edges
  const v = ctx.createRadialGradient(W / 2, H * 0.46, H * 0.3, W / 2, H * 0.5, W * 0.66);
  const edge = scene === "dark" ? 0.42 : scene === "mid" ? 0.14 : 0.05;
  v.addColorStop(0, ok(0.1, 0.03, hues[0], 0));
  v.addColorStop(1, ok(0.1, 0.03, hues[0], edge));
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function paintBundle(b, q, t, reach) {
  const steps = 96;
  const amp = H * b.amp * (0.72 + swell * 0.62) * reach;
  const spread = H * b.spread * (0.82 + swell * 0.3);
  const cy = H * (b.y + lean.y * 0.05);
  const stroke = ctx.createLinearGradient(0, 0, W, 0);
  const [l, c] = q.thread;
  const [h1, h2] = [hues[b.hue[0]], hues[b.hue[1]]];
  stroke.addColorStop(0, ok(l, c, h1, 0));
  stroke.addColorStop(0.16, ok(l, c, h1, 0.55));
  stroke.addColorStop(0.5, ok(l, c, h2, 1));
  stroke.addColorStop(0.84, ok(l, c, h1, 0.55));
  stroke.addColorStop(1, ok(l, c, h2, 0));
  ctx.strokeStyle = stroke;
  for (let n = 0; n < b.lines; n++) {
    const u = n / (b.lines - 1) - 0.5; // −.5 … .5 across the ribbon
    ctx.globalAlpha = q.alpha * (0.2 + 0.8 * (1 - Math.abs(u) * 2) ** 1.4);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      // the ribbon turns over itself, so lines converge and fan out
      const turn = Math.cos(x * b.twist + t * b.s1 * 1.3 + lean.x * 0.9);
      const env = Math.sin(Math.PI * x) ** 0.8;
      const y =
        cy +
        Math.sin(x * b.f1 * 6.283 + t * b.s1 * 6.283) * amp * 0.62 +
        Math.sin(x * b.f2 * 6.283 + t * b.s2 * 6.283 + u * 1.5) * amp * 0.38 * env +
        u * spread * turn;
      if (i) ctx.lineTo(x * W, y);
      else ctx.moveTo(0, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
