/**
 * Timeline: ruler, bar waveform, bilingual cue blocks.
 *
 * Both canvases are only as large as the viewport; `view.x` is a float scroll
 * offset, so following the playhead never snaps to whole pixels.
 */

import { byId, clamp, fmtDur, fmtRuler, fmtTime } from "./util.js";
import { addTicker, capture, cueAt, emit, invalidate, isTop, on, pushHistory, registerDraw, requestFrame, state, syncDuration, trimmed } from "./store.js";
import { isPlaying, seekTo } from "./player.js";
import { addCueAt, selectCue } from "./cues.js";
import { paintRange } from "./controls.js";
import { isMotion, trimMotionTime } from "./motion-path.js";

const strip = byId("strip");
const scroller = byId("stripScroll");
const spacer = byId("stripSpacer");
const base = byId("stripBase");
const head = byId("stripHead");

const MAX_PPS = 420;
const LEAD = 20;
const TAIL = 140;
const GATE = 0.38;
const MIN_CUE_MS = 200;

const FONT_NUM = '"Segoe UI Variable Text", "Segoe UI", sans-serif';
const FONT_ZH = '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const FONT_EN = '"Segoe UI Variable Text", "Segoe UI", sans-serif';
let P = {}; // palette, read from CSS so both themes share one source

const view = { x: 0, pps: 72, W: 0, H: 0, dpr: 1 };
let geo = null;
let mips = [];
let follow = true;
let glide = null;
let zoomTarget = null;
let suspendFollowUntil = 0;
let hover = null; // { x, hit }
let drag = null;
let flashes = [];
let lastTick = 0;

/* ---------- geometry ---------- */
const totalSec = () => Math.max(state.durationMs, 10000) / 1000;
const contentW = () => Math.max(view.W, LEAD + totalSec() * view.pps + TAIL);
const maxX = () => Math.max(0, contentW() - view.W);
const minPps = () => Math.max(0.05, (view.W - LEAD - 30) / totalSec());
const pxOf = (ms) => LEAD + (ms / 1000) * view.pps; // in content space
const xOf = (ms) => pxOf(ms) - view.x;
const msAt = (x) => ((x + view.x - LEAD) / view.pps) * 1000;

function layout() {
  const H = view.H;
  const y0 = 28;
  const y1 = H - 9;
  const ph = Math.max(20, y1 - y0);
  const lanes = ph >= 62;
  const lanesH = lanes ? 40 : 0;
  const waveH = ph - lanesH;
  geo = { H, y0, y1, ph, waveMid: y0 + waveH / 2 + 3, waveAmp: Math.max(6, waveH / 2 - 5) };
}

function measure() {
  const W = scroller.clientWidth;
  const H = scroller.clientHeight;
  if (!W || !H) return;
  view.W = W;
  view.H = H;
  view.dpr = Math.min(2.5, window.devicePixelRatio || 1);
  for (const c of [base, head]) {
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    const w = Math.round(W * view.dpr);
    const hh = Math.round(H * view.dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== hh) c.height = hh;
  }
  layout();
  syncSpacer();
  setView(view.x);
}

function syncSpacer() {
  spacer.style.width = `${Math.round(contentW())}px`;
  paintZoom();
}

function setView(x) {
  view.x = clamp(x, 0, maxX());
  if (Math.abs(scroller.scrollLeft - view.x) >= 1) scroller.scrollLeft = view.x;
  invalidate("strip", "head");
}

/* ---------- tracks: cues that overlap in time are stacked, never drawn over each other ---------- */
let tracks = new Map(); // cue → { track, of, clash }
let tracksDirty = true;
const SOLO = { track: 0, of: 1, clash: false };

function layoutTracks() {
  tracksDirty = false;
  tracks = new Map();
  const order = state.subtitles.map((c) => c).sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  let cluster = [];
  let end = -1;
  const flush = () => {
    if (cluster.length > 1) packCluster(cluster);
    cluster = [];
  };
  for (const c of order) {
    if (cluster.length && c.start_ms >= end) {
      flush();
      end = -1;
    }
    cluster.push(c);
    end = Math.max(end, c.end_ms);
  }
  flush();
}

function packCluster(list) {
  // Notes at the top of the picture keep the upper tracks; dialogue goes below.
  const place = (items, offset) => {
    const ends = [];
    for (const c of items) {
      let t = ends.findIndex((e) => e <= c.start_ms);
      if (t < 0) t = ends.length;
      ends[t] = c.end_ms;
      tracks.set(c, { track: offset + t, of: 1, clash: false });
    }
    return ends.length;
  };
  const notes = list.filter(isTop);
  const lines = list.filter((c) => !isTop(c));
  const n = place(notes, 0);
  const m = place(lines, n);
  let last = null;
  for (const c of lines) {
    // a real conflict: two lines of dialogue on screen at once
    if (last && c.start_ms < last.end_ms) tracks.get(c).clash = tracks.get(last).clash = true;
    if (!last || c.end_ms > last.end_ms) last = c;
  }
  for (const c of list) tracks.get(c).of = n + m;
}

const trackOf = (cue) => tracks.get(cue) || SOLO;

/** Where a cue sits, in canvas pixels. */
function cueBox(cue) {
  const x1 = xOf(cue.start_ms);
  const x2 = Math.max(x1 + 3, xOf(cue.end_ms));
  const { track, of } = trackOf(cue);
  if (of === 1) return { x1, x2, y: geo.y0, h: geo.ph };
  // Karaoke files can have dozens of simultaneous lines: never thinner than 3 px.
  const n = Math.min(of, Math.max(1, Math.floor((geo.ph + 1) / 4)));
  const gap = n > 5 ? 1 : 3;
  const h = Math.max(3, (geo.ph - gap * (n - 1)) / n);
  return { x1, x2, y: geo.y0 + (track % n) * (h + gap), h };
}

/* ---------- waveform pyramid ---------- */
export function setWaveform(wf) {
  state.waveform = wf;
  mips = [];
  grownAt = performance.now();
  requestFrame();
  if (wf?.peaks?.length) {
    let level = Float32Array.from(wf.peaks, (v) => clamp(v / 100, 0, 1));
    mips.push(level);
    while (level.length > 64) {
      const next = new Float32Array(Math.ceil(level.length / 2));
      for (let i = 0; i < next.length; i++) next[i] = Math.max(level[i * 2], level[i * 2 + 1] ?? 0);
      mips.push(next);
      level = next;
    }
  }
  invalidate("strip");
}

const BAR = 2;
const PITCH = 4;

const GROW_MS = 900;
let grownAt = -1e9;
let swell = 0; // 0..1, eases in while playing

/** Rounded bars on a grid fixed to the content, so they travel with the scroll. */
function wavePath(now) {
  if (!mips.length) return null;
  const rate = state.waveform.peaks_per_sec || 25;
  const perBar = (rate * PITCH) / view.pps;
  const lv = clamp(Math.floor(Math.log2(Math.max(1, perBar))), 0, mips.length - 1);
  const data = mips[lv];
  const r = rate / 2 ** lv;
  const { waveMid, waveAmp } = geo;
  const path = new Path2D();
  const playX = xOf(state.currentTimeMs);
  const mouseX = hover && !drag ? hover.x : -1e6;
  const age = now - grownAt;
  const first = Math.max(0, Math.floor((view.x - LEAD) / PITCH) - 1);
  const last = Math.min(Math.ceil((view.x - LEAD + view.W) / PITCH) + 1, Math.ceil(((data.length / r) * view.pps) / PITCH));
  for (let n = first; n <= last; n++) {
    const f = ((n * PITCH + BAR / 2) / view.pps) * r;
    const i = Math.floor(f);
    const t = f - i;
    const a = data[i] ?? 0;
    const b = data[i + 1] ?? a;
    const v = perBar > 1 ? Math.max(a, b * t) : a + (b - a) * t * t * (3 - 2 * t);
    const x = LEAD + n * PITCH - view.x;
    let k = 1;
    if (age < GROW_MS) {
      // New soundtracks grow in from the left.
      const p = clamp((age - (x / Math.max(1, view.W)) * 420) / 460, 0, 1);
      k = 1 - (1 - p) ** 3;
    }
    const dp = (x - playX) / 34;
    const dm = (x - mouseX) / 26;
    if (dp * dp < 9) k *= 1 + 0.34 * swell * Math.exp(-dp * dp);
    if (dm * dm < 9) k *= 1 + 0.26 * Math.exp(-dm * dm);
    const h = Math.max(1, Math.min(waveAmp + 4, v * waveAmp * k));
    path.roundRect(x, waveMid - h, BAR, h * 2, 1);
  }
  return path;
}

/* ---------- base layer ---------- */
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function paintBase(now = performance.now()) {
  if (!geo) return;
  const ctx = base.getContext("2d");
  const { W, H, dpr, pps } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);

  // ruler
  const stepSec = TICKS.find((s) => s * pps >= 92) ?? 3600;
  const minor = stepSec / 5;
  const first = Math.max(0, Math.floor((view.x - LEAD) / pps / minor));
  const last = Math.ceil((view.x - LEAD + W) / pps / minor);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = `400 11px ${FONT_NUM}`;
  for (let n = first; n <= last; n++) {
    const sec = n * minor;
    const x = Math.round(xOf(sec * 1000));
    if (n % 5) {
      ctx.fillStyle = P.grid;
      ctx.fillRect(x, 20, 1, 4);
      continue;
    }
    ctx.fillStyle = P.grid;
    ctx.fillRect(x, 8, 1, H);
    ctx.fillStyle = P.ruler;
    ctx.fillText(fmtRuler(sec, stepSec < 1), x + 5, 17);
  }

  if (tracksDirty) layoutTracks();
  const playing = cueAt(state.currentTimeMs, false);
  const hovered = hover?.hit?.idx ?? -1;
  const order = visibleCues();

  // Full-height cues sit behind the waveform; stacked ones cover it so their text stays readable.
  const stacked = (i) => trackOf(state.subtitles[i]).of > 1;
  const body = (i) => paintCueBody(ctx, i, { selected: i === state.selectedIdx, hovered: i === hovered, solid: stacked(i) });
  for (const i of order) if (!stacked(i)) body(i);

  // waveform: solid up to the playhead, faint after it
  const path = wavePath(now);
  if (path) {
    const playX = clamp(xOf(state.currentTimeMs), 0, W);
    const lit = ctx.createLinearGradient(0, geo.waveMid - geo.waveAmp, 0, geo.waveMid + geo.waveAmp);
    lit.addColorStop(0, P.c1);
    lit.addColorStop(0.5, P.waveOn);
    lit.addColorStop(1, P.c2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playX, H);
    ctx.clip();
    ctx.fillStyle = lit;
    ctx.fill(path);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(playX, 0, W - playX, H);
    ctx.clip();
    ctx.fillStyle = P.wave;
    ctx.fill(path);
    ctx.restore();
  } else if (state.waveformLoading) {
    ctx.fillStyle = P.ruler;
    ctx.font = `400 12px ${FONT_ZH}`;
    ctx.textAlign = "center";
    ctx.fillText("正在提取声轨…", W / 2, geo.waveMid + 4);
    ctx.textAlign = "left";
  } else {
    ctx.fillStyle = P.grid;
    ctx.fillRect(0, geo.waveMid, W, 1);
  }

  for (const i of order) if (stacked(i)) body(i);
  for (const i of order) paintCueInk(ctx, i, { selected: i === state.selectedIdx, playing: i === playing, hovered: i === hovered });
}

/** Cues on screen, the selected one last so it sits on top. */
function visibleCues() {
  const out = [];
  let sel = -1;
  for (let i = 0; i < state.subtitles.length; i++) {
    const c = state.subtitles[i];
    if (xOf(c.end_ms) < -8 || xOf(c.start_ms) > view.W + 8) continue;
    if (i === state.selectedIdx) sel = i;
    else out.push(i);
  }
  if (sel >= 0) out.push(sel);
  return out;
}

function paintCueBody(ctx, i, { selected, hovered, solid }) {
  const { x1, x2, y, h } = cueBox(state.subtitles[i]);
  ctx.save();
  if (selected) {
    ctx.shadowColor = P.shade;
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 5;
  }
  ctx.beginPath();
  ctx.roundRect(x1, y, x2 - x1, h, Math.min(10, (x2 - x1) / 2, h / 2));
  if (solid) {
    ctx.fillStyle = P.solid;
    ctx.fill();
    ctx.shadowColor = "transparent";
  }
  ctx.fillStyle = selected ? P.cueSel : hovered ? P.cueHover : P.cue;
  ctx.fill();
  ctx.restore();
}

function paintCueInk(ctx, i, { selected, playing, hovered }) {
  const cue = state.subtitles[i];
  const { x1, x2, y: y0, h: ph } = cueBox(cue);
  const { clash } = trackOf(cue);
  const w = x2 - x1;
  const top = isTop(cue);
  // two text lines when there is room, then one, then just the number
  const rows = ph >= 62 ? 2 : ph >= 22 ? 1 : 0;
  const slim = rows < 2;

  const lw = selected ? 1.5 : 1;
  ctx.beginPath();
  ctx.roundRect(x1 + lw / 2, y0 + lw / 2, Math.max(1, w - lw), ph - lw, Math.min(10, w / 2, ph / 2));
  ctx.lineWidth = lw;
  ctx.strokeStyle = selected ? P.lineSel : clash ? P.clash : top ? P.top : hovered ? P.ruler : P.line;
  ctx.stroke();

  if ((selected || hovered) && w > 16) {
    // grips sit on the border itself
    ctx.fillStyle = selected ? P.lineSel : P.ruler;
    ctx.beginPath();
    const gh = Math.min(22, ph * 0.5);
    ctx.roundRect(x1 - 1.5, y0 + (ph - gh) / 2, 4, gh, 2);
    ctx.roundRect(x2 - 2.5, y0 + (ph - gh) / 2, 4, gh, 2);
    ctx.fill();
  }
  if (w < 18) return;

  const pad = 11;
  const textX = Math.max(x1 + pad, 8);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x1 + 4, y0, w - 10, ph);
  ctx.clip();
  let numW = 0;
  if (w > 30) {
    ctx.font = `500 11px ${FONT_NUM}`;
    ctx.fillStyle = playing ? P.nowTx : P.tx2;
    const label = top ? `${cue.id} · 顶部` : String(cue.id);
    ctx.fillText(label, textX, slim ? y0 + ph / 2 + 4 : y0 + 16);
    numW = ctx.measureText(label).width + 9;
  }
  if (rows) {
    ctx.textBaseline = "middle";
    const lines = slim
      ? [[trimmed(cue.zh) || trimmed(cue.en), y0 + ph / 2 + 0.5, `400 12px ${FONT_ZH}`, P.tx]]
      : [
          [trimmed(cue.zh), y0 + ph - 30, `400 12.5px ${FONT_ZH}`, P.tx],
          [trimmed(cue.en), y0 + ph - 12, `400 12px ${FONT_EN}`, P.tx2],
        ];
    for (const [text, y, font, color] of lines) {
      const tx = slim ? textX + numW : textX;
      if (text) {
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.fillText(text, tx, y);
        if (playing) {
          // The spoken part inks in, like a sing-along.
          ctx.save();
          ctx.beginPath();
          ctx.rect(tx, y - 10, ((state.currentTimeMs - cue.start_ms) / Math.max(1, cue.end_ms - cue.start_ms)) * Math.min(ctx.measureText(text).width, w - pad - 8), 20);
          ctx.clip();
          ctx.fillStyle = P.nowTx;
          ctx.fillText(text, tx, y);
          ctx.restore();
        }
      } else if (!top) {
        ctx.fillStyle = P.hatch;
        ctx.beginPath();
        ctx.roundRect(tx, y - 4, Math.max(0, Math.min(64, x2 - tx - 14)), 8, 4);
        ctx.fill();
      }
    }
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

/* ---------- head layer ---------- */
function pill(ctx, text, cx, y, bg, fg) {
  ctx.font = `500 11px ${FONT_NUM}`;
  const w = ctx.measureText(text).width + 14;
  const x = clamp(cx - w / 2, 3, view.W - w - 3);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 18, 9);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 7, y + 9.5);
  ctx.textBaseline = "alphabetic";
}

function paintHead(now) {
  if (!geo) return;
  const ctx = head.getContext("2d");
  const { W, H, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const x = xOf(state.currentTimeMs);

  if (hover && !drag && Math.abs(hover.x - x) > 4) {
    ctx.fillStyle = P.line;
    ctx.fillRect(Math.round(hover.x), 22, 1, H);
    pill(ctx, fmtTime(Math.max(0, msAt(hover.x))), hover.x, 3, P.pill, P.pillTx);
  }
  if (drag?.snapX !== undefined && drag.snapX !== null) {
    ctx.fillStyle = P.lineSel;
    ctx.fillRect(Math.round(drag.snapX), 22, 1, H);
  }

  // F3 / F4 feedback: the marked edge lights up once
  flashes = flashes.filter((f) => now - f.at < 480);
  for (const f of flashes) {
    const cue = state.subtitles[f.idx];
    if (!cue) continue;
    const fx = xOf(f.edge === "start" ? cue.start_ms : cue.end_ms);
    const p = (now - f.at) / 480;
    const spread = 8 + p * 30;
    ctx.globalAlpha = (1 - p) ** 2 * 0.5;
    ctx.fillStyle = P.now;
    ctx.beginPath();
    const box = cueBox(cue);
    ctx.roundRect(fx - spread / 2, box.y, spread, box.h, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (flashes.length) invalidate("head");

  if (x > -60 && x < W + 60) {
    ctx.fillStyle = P.now;
    ctx.beginPath();
    ctx.roundRect(x - 0.75, 14, 1.5, H - 14, 0.75);
    ctx.fill();
    pill(ctx, fmtTime(state.currentTimeMs), x, 3, P.now, "#fff");
  }

  if (drag && drag.type !== "scrub" && drag.moved) {
    const cue = state.subtitles[drag.idx];
    if (cue) {
      const mid = (xOf(cue.start_ms) + xOf(cue.end_ms)) / 2;
      const text = `${fmtTime(cue.start_ms)}  –  ${fmtTime(cue.end_ms)}   ${fmtDur(cue.end_ms - cue.start_ms)}`;
      pill(ctx, text, mid, cueBox(cue).y + 5, P.pill, P.pillTx);
    }
  }
}

/* ---------- view motion ---------- */
function tick(now) {
  const dt = clamp(now - lastTick, 0, 64);
  lastTick = now;
  let keep = false;

  const want = isPlaying() ? 1 : 0;
  if (Math.abs(want - swell) > 0.004) {
    swell += (want - swell) * (1 - Math.exp(-dt / 110));
    invalidate("strip");
    keep = true;
  } else swell = want;
  if (now - grownAt < GROW_MS) {
    invalidate("strip");
    keep = true;
  }

  if (drag?.pointerX !== undefined && drag.moved) {
    const margin = 26;
    const over = drag.pointerX < margin ? drag.pointerX - margin : drag.pointerX > view.W - margin ? drag.pointerX - (view.W - margin) : 0;
    if (over && !(over < 0 && view.x <= 0)) {
      setView(view.x + clamp(over, -60, 60) * dt * 0.012);
      moveDrag(drag.pointerX, drag.alt);
      keep = true;
    }
  }
  if (zoomTarget) {
    const ratio = Math.log(zoomTarget.pps / view.pps);
    if (Math.abs(ratio) < 0.004) {
      applyZoom(zoomTarget.pps, zoomTarget.ms, zoomTarget.x);
      zoomTarget = null;
    } else {
      applyZoom(view.pps * Math.exp(ratio * (1 - Math.exp(-dt / 62))), zoomTarget.ms, zoomTarget.x);
      keep = true;
    }
  }
  if (glide !== null) {
    const target = clamp(glide, 0, maxX());
    const diff = target - view.x;
    if (Math.abs(diff) < 0.5) {
      setView(target);
      glide = null;
    } else {
      setView(view.x + diff * (1 - Math.exp(-dt / 72)));
      keep = true;
    }
  }
  return keep;
}

function glideTo(x) {
  const target = clamp(x, 0, maxX());
  // Far jumps start close to the destination instead of scrolling past everything.
  if (Math.abs(target - view.x) > view.W * 2.5) setView(target + Math.sign(view.x - target) * view.W * 0.6);
  glide = target;
  requestFrame();
}

function revealPlayhead() {
  const px = pxOf(state.currentTimeMs);
  if (px < view.x + 40 || px > view.x + view.W - 70) glideTo(px - view.W * GATE);
}

function onTime(info) {
  invalidate("head");
  // The played part of the waveform moves with time.
  invalidate("strip");
  if (drag) return;
  if (info?.tick) {
    if (!follow || performance.now() < suspendFollowUntil) return;
    const px = pxOf(state.currentTimeMs);
    const want = px - view.W * GATE;
    if (want > view.x && view.x < maxX()) {
      if (want - view.x > view.W) glideTo(want);
      else glide = want;
    } else if (px < view.x) glideTo(want);
  } else if (info?.seek && info.reveal !== false) {
    revealPlayhead();
  }
}

/* ---------- zoom ---------- */
const zoomToSlider = (pps) => {
  const lo = minPps();
  return clamp((Math.log(pps / lo) / Math.log(MAX_PPS / lo)) * 1000, 0, 1000);
};
const sliderToZoom = (v) => {
  const lo = minPps();
  return lo * (MAX_PPS / lo) ** (v / 1000);
};
function paintZoom() {
  const rng = byId("rngZoom");
  if (document.activeElement !== rng || zoomTarget) rng.value = String(Math.round(zoomToSlider(view.pps)));
  paintRange(rng);
}
function applyZoom(pps, anchorMs, anchorX) {
  view.pps = clamp(pps, minPps(), MAX_PPS);
  syncSpacer();
  setView(pxOf(anchorMs) - anchorX);
}
function zoomAnchor() {
  const x = xOf(state.currentTimeMs);
  return x > 0 && x < view.W ? { ms: state.currentTimeMs, x } : { ms: msAt(view.W / 2), x: view.W / 2 };
}
function zoomTo(pps, anchor = zoomAnchor()) {
  glide = null;
  zoomTarget = { pps: clamp(pps, minPps(), MAX_PPS), ...anchor };
  requestFrame();
}
export function zoomFit() {
  zoomTo(minPps(), { ms: 0, x: LEAD });
}
export function zoomCue() {
  const cue = state.subtitles[state.selectedIdx];
  if (!cue) return;
  const dur = Math.max(400, cue.end_ms - cue.start_ms) / 1000;
  const pps = clamp((view.W * 0.36) / dur, minPps(), MAX_PPS);
  const mid = (cue.start_ms + cue.end_ms) / 2;
  zoomTo(pps, { ms: mid, x: view.W / 2 });
}

/* ---------- pointer ---------- */
function hitTest(x, y) {
  if (y < geo.y0) return { type: "scrub", idx: -1 };
  const grab = 6;
  const test = (i) => {
    const { x1, x2, y: top, h } = cueBox(state.subtitles[i]);
    if (x < x1 - grab || x > x2 + grab || y < top - 2 || y > top + h + 2) return null;
    const inner = Math.min(grab, (x2 - x1) / 3);
    if (x <= x1 + inner) return { type: "resize-start", idx: i };
    if (x >= x2 - inner) return { type: "resize-end", idx: i };
    return { type: "move", idx: i };
  };
  if (state.subtitles[state.selectedIdx]) {
    const hit = test(state.selectedIdx);
    if (hit) return hit;
  }
  for (let i = state.subtitles.length - 1; i >= 0; i--) {
    const hit = test(i);
    if (hit) return hit;
  }
  return { type: "scrub", idx: -1 };
}

const CURSOR = { "resize-start": "ew-resize", "resize-end": "ew-resize", move: "grab", scrub: "default" };

function snap(ms, ignoreIdx, alt) {
  drag.snapX = null;
  if (alt) return ms;
  const reach = (6 / view.pps) * 1000;
  let best = null;
  let bestD = reach;
  const consider = (t) => {
    const d = Math.abs(t - ms);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  };
  consider(state.currentTimeMs);
  const lo = ms - reach;
  const hi = ms + reach;
  for (let i = 0; i < state.subtitles.length; i++) {
    if (i === ignoreIdx) continue;
    const c = state.subtitles[i];
    if (c.start_ms >= lo && c.start_ms <= hi) consider(c.start_ms);
    if (c.end_ms >= lo && c.end_ms <= hi) consider(c.end_ms);
  }
  if (best === null) return ms;
  drag.snapX = xOf(best);
  return best;
}

function moveDrag(x, alt) {
  const ms = Math.max(0, msAt(x));
  if (drag.type === "scrub") {
    seekTo(ms, { reveal: false });
    return;
  }
  const cue = drag.cue;
  if (drag.type === "move" && isMotion(cue)) return;
  if (state.subtitles[drag.idx] !== cue) return endDrag(); // the list changed under the pointer
  if (!drag.moved) {
    if (Math.abs(x - drag.downX) < 3) return;
    drag.moved = true;
    pushHistory(drag.type === "move" ? "拖动字幕" : "拖动边缘", drag.before);
    scroller.style.cursor = drag.type === "move" ? "grabbing" : "ew-resize";
  }
  if (drag.type === "resize-start") {
    const t = snap(ms - drag.grabDelta, drag.idx, alt);
    cue.start_ms = isMotion(cue) ? trimMotionTime(cue, "start", Math.round(t)) : Math.round(clamp(t, 0, Math.max(0, cue.end_ms - MIN_CUE_MS)));
  } else if (drag.type === "resize-end") {
    const t = snap(ms - drag.grabDelta, drag.idx, alt);
    cue.end_ms = isMotion(cue) ? trimMotionTime(cue, "end", Math.round(t)) : Math.round(Math.max(t, cue.start_ms + MIN_CUE_MS));
  } else {
    const dur = drag.origEnd - drag.origStart;
    const raw = Math.max(0, drag.origStart + (ms - drag.startMs));
    const byStart = snap(raw, drag.idx, alt);
    const snapStartX = drag.snapX;
    const byEnd = snap(raw + dur, drag.idx, alt) - dur;
    if (snapStartX !== null && Math.abs(byStart - raw) <= Math.abs(byEnd - raw || 1e9)) {
      drag.snapX = snapStartX;
      cue.start_ms = Math.round(Math.max(0, byStart));
    } else {
      cue.start_ms = Math.round(Math.max(0, byEnd));
    }
    cue.end_ms = cue.start_ms + dur;
  }
  emit("cue", { idx: drag.idx, what: "time", live: true });
}

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  strip.classList.remove("dragging");
  scroller.style.cursor = "";
  if (d.type !== "scrub" && d.moved && state.subtitles[d.idx] === d.cue) {
    syncDuration();
    syncSpacer();
    emit("cue", { idx: d.idx, what: "time" });
  }
  invalidate("strip", "head");
}

function bindPointer() {
  const local = (e) => {
    const r = scroller.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onScrollbar = (y) => y >= scroller.clientHeight;

  scroller.addEventListener("pointerdown", (e) => {
    const { x, y } = local(e);
    if (e.button !== 0 || onScrollbar(y) || !geo) return;
    glide = null;
    const hit = hitTest(x, y);
    scroller.setPointerCapture(e.pointerId);
    const ms = Math.max(0, msAt(x));
    if (hit.type === "scrub") {
      drag = { type: "scrub", moved: true, pointerX: x };
      seekTo(ms, { reveal: false });
    } else {
      const before = capture();
      selectCue(hit.idx);
      const cue = state.subtitles[hit.idx];
      drag = {
        type: hit.type,
        idx: hit.idx,
        cue,
        before,
        downX: x,
        startMs: ms,
        grabDelta: hit.type === "resize-start" ? ms - cue.start_ms : hit.type === "resize-end" ? ms - cue.end_ms : 0,
        origStart: cue.start_ms,
        origEnd: cue.end_ms,
        moved: false,
        pointerX: x,
        snapX: null,
      };
    }
    strip.classList.add("dragging");
  });

  scroller.addEventListener("pointermove", (e) => {
    if (!geo) return;
    const { x, y } = local(e);
    if (drag && !(e.buttons & 1)) endDrag(); // released somewhere we could not see
    if (drag) {
      drag.pointerX = x;
      drag.alt = e.altKey;
      moveDrag(x, e.altKey);
      requestFrame();
      invalidate("head");
      return;
    }
    if (onScrollbar(y)) {
      hover = null;
    } else {
      const hit = hitTest(x, y);
      hover = { x, hit };
      scroller.style.cursor = CURSOR[hit.type];
    }
    invalidate("strip", "head");
  });

  scroller.addEventListener("pointerup", () => {
    const d = drag;
    endDrag();
    // A plain click inside a cue seeks to that spot.
    if (d && d.type === "move" && !d.moved) seekTo(d.startMs, { reveal: false });
  });
  scroller.addEventListener("pointercancel", endDrag);
  scroller.addEventListener("lostpointercapture", endDrag);
  scroller.addEventListener("pointerleave", () => {
    hover = null;
    invalidate("strip", "head");
  });

  scroller.addEventListener("dblclick", (e) => {
    const { x, y } = local(e);
    if (!geo || onScrollbar(y) || y < geo.y0) return;
    const hit = hitTest(x, y);
    if (hit.idx >= 0) selectCue(hit.idx, { focus: "zh" });
    else addCueAt(Math.max(0, msAt(x)));
  });

  scroller.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      glide = null;
      const { x } = local(e);
      const from = zoomTarget?.pps ?? view.pps;
      zoomTo(from * Math.exp(-e.deltaY * 0.0016), { ms: msAt(x), x });
      return;
    }
    suspendFollowUntil = performance.now() + 2600;
    const unit = e.deltaMode === 1 ? 16 : 1;
    const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    glideTo((glide ?? view.x) + delta * 1.15);
  }, { passive: false });

  scroller.addEventListener("scroll", () => {
    // Our own writes land within a pixel of view.x; anything else is the user's scrollbar.
    if (Math.abs(scroller.scrollLeft - view.x) < 1.01) return;
    if (scroller.scrollLeft >= scroller.scrollWidth - scroller.clientWidth - 1 && view.x >= maxX() - 1) return;
    suspendFollowUntil = performance.now() + 2600;
    glide = null;
    view.x = clamp(scroller.scrollLeft, 0, maxX());
    invalidate("strip", "head");
  });
}

/* ---------- public ---------- */
export function setFollow(onOff) {
  follow = onOff;
  byId("btnFollow").setAttribute("aria-pressed", String(onOff));
  if (onOff) {
    suspendFollowUntil = 0;
    revealPlayhead();
  }
}
export function refreshTimelineColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  P = {
    bg: v("--tl-bg"), ruler: v("--tl-ruler"), grid: v("--tl-grid"), wave: v("--tl-wave"), waveOn: v("--tl-wave-on"),
    cue: v("--tl-cue"), cueHover: v("--tl-cue-hover"), cueSel: v("--tl-cue-sel"), line: v("--tl-cue-line"), lineSel: v("--tl-cue-line-sel"),
    tx: v("--tl-tx"), tx2: v("--tl-tx-2"), top: v("--tl-top"), hatch: v("--tl-hatch"), pill: v("--tl-pill"), pillTx: v("--tl-pill-tx"),
    now: v("--now"), nowTx: v("--now-tx"), clash: v("--tl-clash"), solid: v("--tl-solid"), c1: v("--c1"), c2: v("--c2"), shade: v("--tl-shade"),
  };
  // Inside a view transition the new look must be on the canvas before it is captured.
  if (geo) {
    paintBase();
    paintHead(performance.now());
  }
}

export function initTimeline() {
  registerDraw("strip", paintBase);
  registerDraw("head", paintHead);
  setWaveform(state.waveform);
  refreshTimelineColors();
  bindPointer();
  addTicker(tick);

  byId("rngZoom").addEventListener("input", (e) => {
    zoomTarget = null;
    glide = null;
    const a = zoomAnchor();
    applyZoom(sliderToZoom(Number(e.target.value)), a.ms, a.x);
  });
  byId("btnZoomFit").addEventListener("click", zoomFit);
  byId("btnZoomCue").addEventListener("click", zoomCue);
  byId("btnFollow").addEventListener("click", () => {
    setFollow(!follow);
    emit("pref", { follow });
  });

  on("time", onTime);
  on("play", () => invalidate("head", "strip"));
  on("cues", () => {
    endDrag();
    tracksDirty = true;
    syncSpacer();
    setView(view.x);
  });
  on("cue", ({ live, what }) => {
    if (what !== "text") tracksDirty = true;
    if (!live) syncSpacer();
    invalidate("strip", "head");
  });
  on("select", ({ idx, reveal }) => {
    invalidate("strip");
    const cue = state.subtitles[idx];
    if (!cue || reveal === false || drag || isPlaying()) return;
    const x1 = xOf(cue.start_ms);
    const x2 = xOf(cue.end_ms);
    if (x2 < 40 || x1 > view.W - 60) glideTo(pxOf(cue.start_ms) - view.W * GATE);
  });
  on("media-ready", () => {
    syncSpacer();
    setView(view.x);
  });
  on("palette", refreshTimelineColors);
  on("media-changed", () => {
    view.x = 0;
    syncSpacer();
    setView(0);
  });
  on("mark", (m) => {
    flashes.push({ ...m, at: performance.now() });
    invalidate("head");
  });
  on("dpr", measure);
  new ResizeObserver(measure).observe(scroller);
  measure();
}
