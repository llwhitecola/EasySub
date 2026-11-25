/* Every operation that changes cues lives here, so undo and redraw stay consistent. */

import { fmtTime } from "./util.js";
import { emit, historyMark, isTop, pushHistory, reindex, replaceCues, state, syncDuration, trimmed } from "./store.js";
import { toast } from "./feedback.js";
import { call } from "./bridge.js";
import { seekTo } from "./player.js";

/** Offer to undo the step that was just made, and only that one. */
const undoAction = () => {
  const mark = historyMark();
  return {
    label: "撤销",
    run: () => {
      if (historyMark() === mark) emit("do-undo");
      else toast("之后又有别的修改，请按 Ctrl+Z 逐步撤销");
    },
  };
};

/* ---------- selection ---------- */
export function selectCue(idx, { seek = false, reveal = true, focus = "" } = {}) {
  if (idx < 0 || idx >= state.subtitles.length) return;
  const prev = state.selectedIdx;
  state.selectedIdx = idx;
  emit("select", { idx, prev, reveal, focus });
  if (seek) seekTo(state.subtitles[idx].start_ms + 20);
}

function structureChanged(select, { reveal = true, focus = "" } = {}) {
  reindex();
  state.selectedIdx = Math.max(0, Math.min(select, state.subtitles.length - 1));
  syncDuration();
  emit("cues", { animate: true });
  emit("select", { idx: state.selectedIdx, reveal, focus });
}

function timeChanged(idx) {
  syncDuration();
  emit("cue", { idx, what: "time" });
}

/* ---------- timing ---------- */
export function markStart() {
  if (!state.subtitles.length) {
    addCueAt(state.currentTimeMs);
    return;
  }
  const cue = state.subtitles[state.selectedIdx];
  pushHistory("设开始时间");
  cue.start_ms = Math.round(state.currentTimeMs);
  if (cue.end_ms <= cue.start_ms + 300) cue.end_ms = cue.start_ms + 2400;
  timeChanged(state.selectedIdx);
  emit("mark", { idx: state.selectedIdx, edge: "start" });
  emit("status", `第 ${cue.id} 句开始 → ${fmtTime(cue.start_ms)}`);
}

export function markEndNext() {
  if (!state.subtitles.length) return;
  const idx = state.selectedIdx;
  const cue = state.subtitles[idx];
  pushHistory("设结束时间");
  const now = Math.round(state.currentTimeMs);
  cue.end_ms = now > cue.start_ms + 120 ? now : cue.start_ms + 1200;
  timeChanged(idx);
  emit("mark", { idx, edge: "end" });
  emit("status", `第 ${cue.id} 句结束 → ${fmtTime(cue.end_ms)}`);
  if (idx + 1 < state.subtitles.length) selectCue(idx + 1);
}

let lastNudge = null;
/**
 * Returns false when the typed value does not make sense.
 * nudge: repeated small steps on the same edge share one undo step.
 */
export function setCueTime(idx, edge, ms, { nudge = false } = {}) {
  const cue = state.subtitles[idx];
  if (!cue || ms === null) return false;
  if (edge === "end" && ms <= cue.start_ms) return false;
  if (cue[`${edge}_ms`] === ms) return true;
  const now = performance.now();
  const same = nudge && lastNudge && lastNudge.cue === cue && lastNudge.edge === edge && lastNudge.mark === historyMark() && now - lastNudge.at < 1500;
  if (!same) pushHistory(nudge ? "微调时间" : "修改时间");
  state.dirty = true;
  lastNudge = nudge ? { cue, edge, mark: historyMark(), at: now } : null;
  cue[`${edge}_ms`] = ms;
  if (edge === "start" && cue.end_ms <= ms) cue.end_ms = ms + 1000;
  timeChanged(idx);
  return true;
}

export function shiftAll(deltaMs) {
  if (!state.subtitles.length) return;
  pushHistory("整体平移");
  for (const c of state.subtitles) {
    const dur = c.end_ms - c.start_ms;
    c.start_ms = Math.max(0, c.start_ms + deltaMs);
    c.end_ms = Math.max(c.start_ms + Math.min(200, dur), c.end_ms + deltaMs);
  }
  syncDuration();
  emit("cues", {});
  const sec = (deltaMs / 1000).toFixed(1);
  toast(`全部字幕已平移 ${deltaMs > 0 ? "+" : ""}${sec} 秒`, { key: "shift", action: undoAction() });
}

/* ---------- structure ---------- */
export function addCueAt(ms) {
  pushHistory("新建一句");
  const start = Math.max(0, Math.round(ms));
  let at = state.subtitles.findIndex((c) => c.start_ms > start);
  if (at < 0) at = state.subtitles.length;
  const next = state.subtitles.slice(at).find((c) => !isTop(c));
  const end = next && next.start_ms > start + 500 ? Math.min(start + 2500, next.start_ms - 40) : start + 2500;
  state.subtitles.splice(at, 0, { id: 0, start_ms: start, end_ms: end, zh: "", en: "" });
  structureChanged(at, { focus: "zh" });
}

export function insertAfter(idx) {
  const cue = state.subtitles[idx];
  if (!cue) return;
  pushHistory("插入新行");
  const start = cue.end_ms + 100;
  const next = state.subtitles[idx + 1];
  const end = next && next.start_ms > start + 400 ? Math.min(start + 2500, next.start_ms - 50) : start + 2500;
  state.subtitles.splice(idx + 1, 0, { id: 0, start_ms: start, end_ms: end, zh: "", en: "" });
  structureChanged(idx + 1, { focus: "zh" });
}

export function deleteCue(idx) {
  const cue = state.subtitles[idx];
  if (!cue) return;
  pushHistory("删除一句");
  state.subtitles.splice(idx, 1);
  const sel = state.selectedIdx > idx ? state.selectedIdx - 1 : state.selectedIdx;
  structureChanged(sel, { reveal: false });
  toast(`已删除第 ${idx + 1} 句`, { key: "del", action: undoAction() });
}

export function mergeNext(idx) {
  const cue = state.subtitles[idx];
  const next = state.subtitles[idx + 1];
  if (!cue) return;
  if (!next) {
    toast("已经是最后一句了");
    return;
  }
  pushHistory("与下一句合并");
  cue.start_ms = Math.min(cue.start_ms, next.start_ms);
  cue.end_ms = Math.max(cue.end_ms, next.end_ms);
  cue.zh = [trimmed(cue.zh), trimmed(next.zh)].filter(Boolean).join(" ");
  cue.en = [trimmed(cue.en), trimmed(next.en)].filter(Boolean).join(" ");
  state.subtitles.splice(idx + 1, 1);
  structureChanged(idx);
  toast(`第 ${idx + 1}、${idx + 2} 句已合并`, { key: "merge", action: undoAction() });
}

export async function splitCue(idx) {
  const cue = state.subtitles[idx];
  if (!cue) return;
  if (!trimmed(cue.zh) && !trimmed(cue.en)) {
    toast("这一句还没有文字，无法拆分");
    return;
  }
  const res = await call("split_cue_item", cue);
  if (res.ok && res.parts?.length === 2) {
    const at = state.subtitles.indexOf(cue); // rows may have moved while waiting
    if (at < 0) return;
    pushHistory("拆成两句");
    state.subtitles.splice(at, 1, res.parts[0], res.parts[1]);
    structureChanged(at);
    toast(`第 ${at + 1} 句已拆成两句`, { key: "split", action: undoAction() });
  } else if (res.error) {
    toast(res.error, { type: "error" });
  }
}

export function togglePos(idx) {
  const cue = state.subtitles[idx];
  if (!cue) return;
  pushHistory("切换位置");
  if (isTop(cue)) delete cue.pos;
  else cue.pos = "top";
  emit("cue", { idx, what: "pos" });
  toast(isTop(cue) ? `第 ${cue.id} 句已设为顶部注释` : `第 ${cue.id} 句已恢复为底部对白`, { key: "pos", type: "success" });
}

/**
 * Complete one line in context. A line that is half of a split sentence is repaired
 * together with its neighbour; anything else is translated. Only the rows the backend
 * actually changed are touched, so edits made while waiting are kept.
 */
export async function translateCue(idx) {
  const cue = state.subtitles[idx];
  if (!cue) return;
  if (!trimmed(cue.en) && !trimmed(cue.zh)) {
    toast("先在中文或英文任意一栏填上内容，再点智能补全");
    return;
  }
  const sent = [...state.subtitles];
  const before = sent.map((c) => ({ ...c }));
  const res = await call("smart_fix_single_orphan_or_translate", before, idx);
  if (!res.ok || !Array.isArray(res.subtitles)) {
    if (res.error) toast(res.error, { type: "error" });
    return;
  }
  // Field by field: only what the backend changed and nobody has edited since.
  const changes = [];
  let touched = false;
  res.subtitles.forEach((next, i) => {
    const was = before[i];
    const target = sent[i];
    if (!was || !state.subtitles.includes(target)) return;
    for (const f of ["zh", "en", "start_ms", "end_ms"]) {
      if (next[f] === was[f] || next[f] === undefined || next[f] === null) continue;
      if (target[f] === was[f]) changes.push([target, f, f.endsWith("_ms") ? Math.max(0, Math.round(Number(next[f]) || 0)) : String(next[f])]);
      else touched = true;
    }
  });
  if (!changes.length) {
    if (!state.subtitles.includes(cue)) toast("这一句已经不在列表里了");
    else toast(touched ? "等待期间你改过这一句，译文没有覆盖" : "没有得到新的译文");
    return;
  }
  pushHistory("智能补全");
  for (const [target, f, value] of changes) target[f] = value;
  for (const c of new Set(changes.map(([target]) => target))) if (c.end_ms <= c.start_ms) c.end_ms = c.start_ms + 400;
  syncDuration();
  emit("cues", {});
  toast(String(res.message || "已补全").replace(/！$/, ""), { key: "trans", type: "success", action: undoAction() });
}

/* ---------- bulk tools ---------- */
/* Each returns a short result that the one-click button shows in place of its label. */
export async function cleanPunctuation({ quiet = false } = {}) {
  if (!state.subtitles.length) return toast("还没有字幕");
  const res = await call("clean_us_drama_punctuation", state.subtitles);
  if (!res.ok) return res.error && toast(res.error, { type: "error" });
  if (!res.changed_count) {
    if (!quiet) toast("标点都已符合规范，没有需要改的");
    return "无需改动";
  }
  replaceCues(res.subtitles, "标点清洗", { select: state.selectedIdx });
  toast(`已规范 ${res.changed_count} 句标点`, { type: "success", action: undoAction() });
  return `改了 ${res.changed_count} 句`;
}

const CJK = /[一-鿿]/;
export function fixSwappedColumns({ quiet = false } = {}) {
  const wrong = state.subtitles.filter((c) => !CJK.test(c.zh || "") && CJK.test(c.en || ""));
  if (!wrong.length) {
    if (!quiet) toast("中英文分栏都正确，没有需要纠正的");
    return "都正确";
  }
  pushHistory("中英纠偏");
  for (const c of wrong) [c.zh, c.en] = [c.en, c.zh];
  emit("cues", {});
  toast(`已纠正 ${wrong.length} 句填反的中英文`, { type: "success", action: undoAction() });
  return `改了 ${wrong.length} 句`;
}

export function sortByTime({ quiet = false } = {}) {
  const sorted = [...state.subtitles].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  if (sorted.every((c, i) => c === state.subtitles[i])) {
    if (!quiet) toast("字幕已经按时间排好了");
    return "已是顺序";
  }
  const sel = state.subtitles[state.selectedIdx];
  pushHistory("按时间排序");
  state.subtitles = sorted;
  structureChanged(sorted.indexOf(sel));
  toast("已按开始时间重新排序", { type: "success", action: undoAction() });
  return "排好了";
}

export function clearAll() {
  if (!state.subtitles.length) return;
  const n = state.subtitles.length;
  pushHistory("清空字幕");
  state.subtitles = [];
  structureChanged(0);
  toast(`已清空 ${n} 句字幕`, { action: undoAction(), ms: 7000 });
}

export { undoAction };
