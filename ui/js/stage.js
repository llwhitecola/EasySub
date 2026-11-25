/* The screen: subtitle overlay, demo backdrops, safe-area guides, focus mode. */

import { $, $$, byId, clamp, prefersReducedMotion } from "./util.js";
import { cueAt, emit, invalidate, on, registerDraw, state, trimmed } from "./store.js";
import { drawCue, fitCanvas } from "./subs-render.js";
import { initScenes, setScene, setScenesActive } from "./scenes.js";
import { startHero } from "./hero.js";
import { initMotion } from "./motion.js";
import { isMotion, motionAt, pictureRect } from "./motion-path.js";
import { setStageMargin, stageMargin } from "./styles.js";
import { cueNeedsTick, resolveCueStyle } from "./cue-style.js";

const overlay = byId("subCanvas");
const sceneCanvas = byId("scene");

const SAMPLE = { zh: "字幕样式预览 这里显示中文", en: "Subtitle preview: English goes here" };
let showSample = false;
let lastKey = "";
let motionCues = [];
const activeMotion = (cue) => cue.start_ms <= state.currentTimeMs && state.currentTimeMs < cue.end_ms;

/* ---------- subtitle overlay ---------- */
function paintOverlay() {
  const { ctx, W, H } = fitCanvas(overlay);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const topIdx = cueAt(state.currentTimeMs, true);
  const idx = cueAt(state.currentTimeMs, false);
  const opts = { W, H, style: state.style, langMode: state.langMode, timeMs: state.currentTimeMs };
  const showMotion = state.hasRealVideo && state.langMode !== "en_only" && motionCues.some(activeMotion);
  if (topIdx >= 0) drawCue(ctx, { ...opts, cue: state.subtitles[topIdx] });

  const cue = idx >= 0 ? state.subtitles[idx] : null;
  let box = null;
  if (cue && (trimmed(cue.zh) || trimmed(cue.en))) {
    box = drawCue(ctx, { ...opts, cue });
  } else if (showSample && topIdx < 0 && !showMotion) {
    ctx.globalAlpha = 0.9;
    box = drawCue(ctx, { ...opts, cue: SAMPLE, timeMs: undefined });
    ctx.globalAlpha = 1;
  }
  if (showMotion) {
    const p = pictureRect(byId("video"), W, H);
    if (p) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      ctx.translate(p.x, p.y);
      for (const note of motionCues) {
        if (!activeMotion(note)) continue;
        const anchor = motionAt(note.motion, state.currentTimeMs);
        if (anchor) drawCue(ctx, { ...opts, W: p.w, H: p.h, cue: note, anchor });
      }
      ctx.restore();
    }
  }
  placeFrame(box, W / Math.max(1, overlay.clientWidth), idx);
  const key = `${idx}|${topIdx}`;
  if (key !== lastKey) {
    lastKey = key;
    overlay.setAttribute("aria-label", cue ? `${trimmed(cue.zh)} ${trimmed(cue.en)}` : "");
  }
}

/* ---------- grab the subtitle right on the picture ----------
   Drag up or down to set the bottom margin, double-click to edit the words. */
const frame = byId("subFrame");
const MARGIN_MAX = 400;
let frameIdx = -1;
let grab = null;

function placeFrame(box, dpr, idx) {
  frameIdx = idx;
  frame.hidden = !box;
  if (!box) return;
  const pad = 5;
  frame.style.left = `${box.x1 / dpr - pad - 4}px`;
  frame.style.top = `${box.y1 / dpr - pad + 2}px`;
  frame.style.width = `${(box.x2 - box.x1) / dpr + (pad + 4) * 2}px`;
  frame.style.height = `${(box.y2 - box.y1) / dpr + pad * 2 - 2}px`;
}

function bindFrame() {
  const label = $("b", frame);
  const paint = () => {
    const margin = stageMargin(frameIdx);
    label.textContent = margin === null ? "" : `距底 ${margin}`;
  };
  frame.addEventListener("pointerenter", paint);
  frame.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const margin = stageMargin(frameIdx);
    if (margin === null) return;
    e.preventDefault();
    grab = { y: e.clientY, from: margin, idx: frameIdx, moved: false };
    frame.setPointerCapture(e.pointerId);
    frame.classList.add("drag");
  });
  frame.addEventListener("pointermove", (e) => {
    if (grab && (!(e.buttons & 1) || grab.idx !== frameIdx)) end();
    if (!grab) return;
    const unit = 1080 / Math.max(1, overlay.clientHeight);
    const dy = grab.y - e.clientY;
    if (!grab.moved && Math.abs(dy) < 3) return;
    grab.moved = true;
    let v = clamp(Math.round(grab.from + dy * unit), 0, MARGIN_MAX);
    // A light magnet at the 5 % title-safe line.
    const safe = Math.abs(v - 54) < 5 && !e.altKey;
    if (safe) v = 54;
    frame.classList.toggle("snap", safe);
    if (v === stageMargin(frameIdx)) return;
    setStageMargin(frameIdx, v);
    label.textContent = safe ? "距底 54 · 安全框" : `距底 ${v}`;
  });
  const end = () => {
    grab = null;
    frame.classList.remove("drag", "snap");
  };
  frame.addEventListener("pointerup", end);
  frame.addEventListener("pointercancel", end);
  frame.addEventListener("lostpointercapture", end);
  frame.addEventListener("dblclick", () => frameIdx >= 0 && emit("edit-cue", frameIdx));
}

/** While the style tab is open, an empty frame still shows a sample line. */
export function setSample(on) {
  showSample = on;
  invalidate("overlay");
}

// Static cues redraw on a change. Motion, fades, and kinetic animations redraw as the playhead moves.
let activeKey = "";
function onTime() {
  const time = state.currentTimeMs;
  const bottom = cueAt(time, false);
  const top = cueAt(time, true);
  const animating = [bottom, top].some((idx) => {
    const cue = state.subtitles[idx];
    return cue && cueNeedsTick(resolveCueStyle(state.style, cue), cue, time);
  });
  const moving = motionCues.some(activeMotion);
  const key = `${bottom}|${top}|${moving}|${animating}`;
  if (moving || animating || key !== activeKey) {
    activeKey = key;
    invalidate("overlay");
  }
}

export function setGuides(on) {
  byId("btnGuides").setAttribute("aria-pressed", String(on));
  byId("guides").classList.toggle("on", on);
}

/* ---------- which backdrop is showing ---------- */
export function syncBackdrop() {
  const root = document.documentElement;
  const picture = state.hasRealVideo && !root.classList.contains("audio-only");
  root.classList.toggle("has-video", picture);
  root.classList.toggle("has-media", state.mediaLoaded);
  setScenesActive(!picture);
  invalidate("overlay");
}

/* ---------- loading curtain on the stage ---------- */
export function stageBusy(text) {
  const node = byId("stageBusy");
  node.classList.toggle("on", Boolean(text));
  if (text) $("span", node).textContent = text;
}

export function initStage() {
  bindFrame();
  initMotion();
  startHero();
  initScenes(sceneCanvas);
  setScenesActive(true);

  for (const b of $$("#sceneSwitch button")) {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const other of $$("#sceneSwitch button")) other.setAttribute("aria-checked", String(other === b));
      emit("pref", { scene: b.dataset.scene });
      const swap = () => setScene(b.dataset.scene);
      if (prefersReducedMotion()) return swap();
      sceneCanvas.animate([{ opacity: 1 }, { opacity: 0.15 }], { duration: 130, easing: "ease-in" }).onfinish = () => {
        swap();
        sceneCanvas.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
      };
    });
  }
  byId("btnGuides").addEventListener("click", () => {
    const next = byId("btnGuides").getAttribute("aria-pressed") !== "true";
    setGuides(next);
    emit("pref", { guides: next });
  });
  byId("btnFullStage").addEventListener("click", toggleTheatre);

  registerDraw("overlay", paintOverlay);
  on("time", onTime);
  on("cues", () => {
    motionCues = state.subtitles.filter(isMotion);
    invalidate("overlay");
  });
  on("cue", () => invalidate("overlay"));
  on("style", () => invalidate("overlay"));
  on("dpr", () => invalidate("overlay"));
  on("select", () => invalidate("overlay"));
  on("media-ready", syncBackdrop);
  on("media-unplayable", syncBackdrop);
  new ResizeObserver(() => invalidate("overlay")).observe(byId("stage"));

  syncBackdrop();
}

/* ---------- theatre mode: the screen fills the window ---------- */
export function toggleTheatre() {
  const root = document.documentElement;
  const next = !root.classList.contains("theatre");
  root.classList.toggle("theatre", next);
  byId("btnFullStage").setAttribute("aria-pressed", String(next));
}
export const inTheatre = () => document.documentElement.classList.contains("theatre");
