/* Application state, events, frame scheduler and undo history. */

import { isMotion, normalizeMotion } from "./motion-path.js";
import { normalizeCueStyle } from "./cue-style.js";

export const DEMO_SUBTITLES = [
  { id: 1, start_ms: 600, end_ms: 3800, zh: "以前做双语字幕总要记一堆复杂代码", en: "Making bilingual subs used to mean complex tags" },
  { id: 2, start_ms: 4200, end_ms: 7800, zh: "现在点一下右侧卡片 就能切换电影级双语样式", en: "Now one click switches to cinema-grade bilingual styles" },
  { id: 3, start_ms: 8200, end_ms: 11800, zh: "播放时按 F3 设开始 按 F4 设结束并跳下一句", en: "Press F3 for start and F4 for end while playing" },
  { id: 4, start_ms: 12200, end_ms: 16500, zh: "拖入视频点击上方 AI 按钮 全自动听写加翻译!", en: "Drop a video in and click AI for auto transcription!" },
];

export const DEFAULT_STYLE = {
  order: "zh_top",
  margin_v: 15,
  line_gap: 7,
  blur: 2.0,
  ycbcr_matrix: "None",
  box_mode: false,
  box_color: "#0F172A",
  box_opacity: 0.72,
  zh: {
    style_name: "默认文泉", font: "WenQuanYi Micro Hei", size: 70, color: "#B7B7B7",
    secondary_color: "#000000", outline_color: "#000000", back_color: "#000000", back_opacity: 1.0,
    outline: 0.8, shadow: 0.7, scale_x: 93, margin_l: 10, margin_r: 11, bold: true, italic: false,
  },
  en: {
    style_name: "Eng - ITC", font: "ITCAvantGardePro-Demi", size: 47, color: "#C0A783",
    secondary_color: "#FF0000", outline_color: "#040000", back_color: "#091703", back_opacity: 1.0,
    outline: 0.8, shadow: 0.8, scale_x: 95, margin_l: 15, margin_r: 15, bold: true, italic: false,
  },
};

function createDemoWaveform(durationSec = 18, pps = 25) {
  const total = durationSec * pps;
  const peaks = new Array(total).fill(0).map((_, i) => 3 + Math.round(Math.abs(Math.sin(i * 1.7)) * 2));
  for (const cue of DEMO_SUBTITLES) {
    const s = Math.floor((cue.start_ms / 1000) * pps);
    const e = Math.min(total - 1, Math.floor((cue.end_ms / 1000) * pps));
    for (let i = s; i <= e; i++) {
      const t = (i - s) / Math.max(1, e - s);
      const envelope = Math.min(1, t * 9) * Math.min(1, (1 - t) * 6);
      const syllable = Math.abs(Math.sin(i * 0.62)) * 0.62 + Math.abs(Math.sin(i * 0.23 + 1.1)) * 0.38;
      peaks[i] = Math.min(96, Math.round(6 + envelope * syllable * 92));
    }
  }
  return { peaks_per_sec: pps, duration_ms: durationSec * 1000, peaks };
}

export const state = {
  // media
  hasRealVideo: false, // a <video> element is actually playing this file
  mediaLoaded: false, // a media file is loaded (even when it cannot be previewed)
  videoName: "",
  videoStem: "双语字幕",
  mediaDurationMs: 0,
  mediaId: 0, // grows with every film that is actually opened
  durationMs: 18000,
  currentTimeMs: 1200,
  waveform: createDemoWaveform(),
  waveformLoading: false,

  // cues
  subtitles: structuredClone(DEMO_SUBTITLES),
  isDemo: true, // demo cues are untouched placeholders, not the user's work
  selectedIdx: 0,
  searchQuery: "",
  filter: "all",

  // style
  presets: [],
  activePresetId: "us_drama_default",
  langMode: "bilingual",
  style: structuredClone(DEFAULT_STYLE),

  // misc
  dirty: false,
  settingsLoaded: false, // nothing is written back before it has been read
  settings: {},
  prefs: {},
};

/* ---------- events ---------- */
const handlers = new Map();
export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, []);
  handlers.get(event).push(fn);
}
export function emit(event, payload) {
  for (const fn of handlers.get(event) || []) fn(payload);
}

/* ---------- one frame loop for the whole app ----------
   Modules register a named draw function and call invalidate(name).
   The ticker (playback) runs first, so time and pixels land in the same frame. */
const draws = new Map();
const dirtySet = new Set();
const tickers = new Set();
let rafId = 0;

export function registerDraw(name, fn) {
  draws.set(name, fn);
}
export function invalidate(...names) {
  for (const n of names) dirtySet.add(n);
  requestFrame();
}
/** fn(now) → truthy to keep the loop alive */
export function addTicker(fn) {
  tickers.add(fn);
  requestFrame();
}
export function requestFrame() {
  if (!rafId) rafId = requestAnimationFrame(frame);
}
function frame(now) {
  rafId = 0;
  let keep = false;
  for (const fn of tickers) if (fn(now)) keep = true;
  if (dirtySet.size) {
    const todo = [...draws.keys()].filter((n) => dirtySet.has(n));
    dirtySet.clear();
    for (const n of todo) {
      try {
        draws.get(n)(now);
      } catch (err) {
        console.error(`[draw:${n}]`, err);
      }
    }
  }
  if (keep || dirtySet.size) requestFrame();
}

/* ---------- cue helpers ---------- */
export const isTop = (cue) => cue.pos === "top";
export const trimmed = (v) => String(v ?? "").trim();

export function normalizeCues(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c === "object")
    .map((c, i) => {
      const start = Math.max(0, Math.round(Number(c.start_ms) || 0));
      const end = Math.max(start + 1, Math.round(Number(c.end_ms) || start + 2000));
      const cue = {
        ...c,
        id: i + 1,
        start_ms: start,
        end_ms: end,
        zh: String(c.zh ?? "").replace(/\s*\r?\n\s*/g, " "),
        en: String(c.en ?? "").replace(/\s*\r?\n\s*/g, " "),
      };
      if (cue.style_override !== undefined) {
        const override = normalizeCueStyle(cue.style_override);
        if (override) cue.style_override = override;
        else delete cue.style_override;
      }
      if (!cue.style_override || typeof cue.style_preset_id !== "string") delete cue.style_preset_id;
      if (cue.motion !== undefined) {
        const path = normalizeMotion(cue.motion);
        if (path.length > 1) {
          cue.motion = path;
          cue.pos = "top";
          cue.start_ms = Math.min(path.at(-1)[0] - 1, Math.max(path[0][0], start));
          cue.end_ms = Math.min(path.at(-1)[0], Math.max(cue.start_ms + 1, end));
        } else delete cue.motion;
      }
      return cue;
    });
}

export function reindex() {
  state.subtitles.forEach((c, i) => {
    c.id = i + 1;
  });
}

export function syncDuration() {
  let maxEnd = 0;
  for (const c of state.subtitles) if (c.end_ms > maxEnd) maxEnd = c.end_ms;
  if (state.mediaLoaded && state.mediaDurationMs > 0) {
    state.durationMs = Math.max(state.mediaDurationMs, maxEnd + 1000);
  } else {
    state.durationMs = Math.max(maxEnd + 3000, 18000);
  }
  // Deleting the last lines can shorten the timeline under the playhead.
  if (state.currentTimeMs > state.durationMs) state.currentTimeMs = state.durationMs;
}

/** Active cue at ms; the selected cue wins when several overlap. */
export function cueAt(ms, top = false) {
  const sel = state.subtitles[state.selectedIdx];
  if (sel && !isMotion(sel) && isTop(sel) === top && ms >= sel.start_ms && ms <= sel.end_ms) return state.selectedIdx;
  for (let i = 0; i < state.subtitles.length; i++) {
    const c = state.subtitles[i];
    if (!isMotion(c) && isTop(c) === top && ms >= c.start_ms && ms <= c.end_ms) return i;
  }
  return -1;
}

/* ---------- quality checks shown as filters ---------- */
export const LIMITS = { zhMax: 28, enMax: 84, minMs: 750 };
export const zhLen = (cue) => trimmed(cue.zh).replace(/\s+/g, "").length;
export const enLen = (cue) => trimmed(cue.en).length;

export function cueIssues(cue) {
  const out = [];
  const zh = trimmed(cue.zh);
  const en = trimmed(cue.en);
  if (!isTop(cue) && (!zh || !en)) out.push("missing");
  if (cue.end_ms - cue.start_ms < LIMITS.minMs) out.push("short");
  if (zhLen(cue) > LIMITS.zhMax || enLen(cue) > LIMITS.enMax) out.push("long");
  return out;
}

/** Indexes of bottom cues that start before an earlier bottom cue has ended. */
export function overlapSet() {
  const order = state.subtitles
    .map((c, i) => ({ c, i }))
    .filter((o) => !isTop(o.c))
    .sort((a, b) => a.c.start_ms - b.c.start_ms || a.c.end_ms - b.c.end_ms);
  const hit = new Set();
  let lastEnd = -1;
  let lastIdx = -1;
  for (const { c, i } of order) {
    if (c.start_ms < lastEnd) {
      hit.add(i);
      hit.add(lastIdx);
    }
    if (c.end_ms > lastEnd) {
      lastEnd = c.end_ms;
      lastIdx = i;
    }
  }
  return hit;
}

/* ---------- history ---------- */
const HISTORY_MAX = 80;
let undoStack = [];
let redoStack = [];

export const capture = ({ includeStyle = false } = {}) =>
  JSON.stringify({
    subs: state.subtitles,
    sel: state.selectedIdx,
    demo: state.isDemo,
    ...(includeStyle ? { style: state.style, presetId: state.activePresetId } : {}),
  });

/** Push a snapshot taken before the change. */
export function pushHistory(label, snapshot = capture()) {
  undoStack.push({ label, snapshot });
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack = [];
  state.dirty = true;
  state.isDemo = false;
  emit("history");
}
/** Identity of the latest step; lets a toast know whether its undo still applies. */
export const historyMark = () => undoStack.at(-1);
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const undoLabel = () => undoStack.at(-1)?.label || "";
export const redoLabel = () => redoStack.at(-1)?.label || "";

function restore(snapshot) {
  const data = JSON.parse(snapshot);
  state.subtitles = data.subs;
  state.isDemo = Boolean(data.demo);
  state.selectedIdx = Math.max(0, Math.min(data.sel, state.subtitles.length - 1));
  if (data.style) {
    state.style = data.style;
    if (data.presetId !== undefined) state.activePresetId = data.presetId;
    emit("style", {});
  }
  state.dirty = true;
  syncDuration();
  emit("cues", { bulk: true });
  emit("select", { idx: state.selectedIdx });
  emit("history");
}
export function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  const hasStyle = Boolean(JSON.parse(entry.snapshot).style);
  redoStack.push({ label: entry.label, snapshot: capture({ includeStyle: hasStyle }) });
  restore(entry.snapshot);
  return entry.label;
}
export function redo() {
  const entry = redoStack.pop();
  if (!entry) return null;
  const hasStyle = Boolean(JSON.parse(entry.snapshot).style);
  undoStack.push({ label: entry.label, snapshot: capture({ includeStyle: hasStyle }) });
  restore(entry.snapshot);
  return entry.label;
}

/** The list without the demo lines: placeholders are never part of someone's work. */
export const ownCues = () => (state.isDemo ? [] : state.subtitles);

/** Drop untouched demo lines without leaving an undo step that could bring them back. */
export function clearDemo() {
  if (!state.isDemo) return;
  state.subtitles = [];
  state.selectedIdx = 0;
  state.isDemo = false;
  syncDuration();
  emit("cues", { bulk: true });
}

const sameCue = (a, b) => ["zh", "en", "start_ms", "end_ms"].every((k) => a[k] === b[k]) &&
  isTop(a) === isTop(b) && JSON.stringify(a.motion) === JSON.stringify(b.motion) &&
  JSON.stringify(a.style_override) === JSON.stringify(b.style_override) && a.style_preset_id === b.style_preset_id;
export const sameCues = (a, b) => a.length === b.length && a.every((c, i) => sameCue(c, b[i]));

/** Replace all cues as one undoable step. */
export function replaceCues(list, label, { select = 0 } = {}) {
  pushHistory(label);
  state.subtitles = normalizeCues(list);
  state.selectedIdx = Math.max(0, Math.min(select, state.subtitles.length - 1));
  syncDuration();
  emit("cues", { bulk: true });
  emit("select", { idx: state.selectedIdx });
}
