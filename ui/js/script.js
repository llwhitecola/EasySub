/**
 * The script: a virtualised bilingual list. Only the rows on screen exist in the
 * DOM, so 5 000 cues scroll as smoothly as 5. Rows are keyed by cue object, which
 * lets inserts / deletes / merges slide instead of jumping.
 */

import { $, $$, byId, fmtDur, fmtTime, h, iconHtml, parseTime } from "./util.js";
import {
  LIMITS, capture, cueAt, cueIssues, emit, enLen, invalidate, isTop, on, overlapSet, pushHistory, registerDraw, state, trimmed, zhLen,
} from "./store.js";
import { toast } from "./feedback.js";
import { bindSeg } from "./controls.js";
import { lineRatio } from "./subs-render.js";
import { isPlaying, replayCue, seekTo } from "./player.js";
import { isMotion } from "./motion-path.js";
import { resolveCueStyle } from "./cue-style.js";
import { addCueAt, deleteCue, insertAfter, mergeNext, selectCue, setCueTime, splitCue, togglePos, translateCue } from "./cues.js";

const ROW_H = 66;
const OVERSCAN = 5;

const body = byId("scriptBody");
const sheet = byId("scriptSheet");

let order = []; // positions → cue indexes (after filter / search)
let posOf = new Map(); // cue index → position
const live = new Map(); // cue object → row element
const pool = [];
let overlaps = new Set();
let animateNext = false;
let reflowTimer = 0;
let seekOnClick = true;
let followList = true;
let userScrolledAt = -1e9;
let playingIdx = -1;
let editedSinceFocus = false;
let tcTyped = false; // the focused time box holds text the user typed
const busyJobs = new Map(); // cue object → Set of running row actions

/* ---------- row element ---------- */
function makeRow() {
  const row = h("div", { class: "row", role: "listitem" });
  row.innerHTML = `
    <button class="row-no" type="button" tabindex="-1" data-act="play" data-tip="播放本句"><span></span><em class="eq"><i></i><i></i><i></i></em>${iconHtml("play", "i-fill")}</button>
    <div class="row-tc">
      <input class="tc t-start" type="text" spellcheck="false" aria-label="开始时间" />
      <input class="tc t-end" type="text" spellcheck="false" aria-label="结束时间" />
    </div>
    <div class="row-lines">
      <label><input class="ln zh" type="text" spellcheck="false" placeholder="中文台词" aria-label="中文台词" /><i class="ruler"></i></label>
      <label><input class="ln en" type="text" spellcheck="false" placeholder="English line" aria-label="英文台词" /><i class="ruler"></i></label>
    </div>
    <div class="row-meta"><span class="dur num"></span><span class="flag"></span></div>
    <div class="row-ops">
      <button type="button" tabindex="-1" data-act="pos" data-tip="切换：底部对白 / 顶部注释">${iconHtml("pin")}</button>
      <button type="button" tabindex="-1" data-act="trans" data-tip="智能补全：结合上下文翻译；断句孤行会和相邻句一起修复">${iconHtml("translate")}</button>
      <button type="button" tabindex="-1" data-act="split" data-tip="按标点拆成两句">${iconHtml("split")}</button>
      <button type="button" tabindex="-1" data-act="insert" data-tip="在下方插入一句">${iconHtml("plus")}</button>
      <button type="button" tabindex="-1" data-act="merge" data-tip="与下一句合并">${iconHtml("merge")}</button>
      <button type="button" tabindex="-1" data-act="del" data-tip="删除本句" class="danger">${iconHtml("trash")}</button>
    </div>
    <i class="row-prog"></i>`;
  row._ = {
    no: $(".row-no span", row),
    start: $(".t-start", row),
    end: $(".t-end", row),
    zh: $(".ln.zh", row),
    en: $(".ln.en", row),
    dur: $(".dur", row),
    flag: $(".flag", row),
    prog: $(".row-prog", row),
    rulers: $$(".ruler", row),
    eq: $(".eq", row),
    pos: $('[data-act="pos"]', row),
    jobs: $$('[data-act="trans"], [data-act="split"]', row),
  };
  return row;
}

const setVal = (input, value) => {
  if (input.value !== value) input.value = value;
};

const FLAG_TEXT = { overlap: "重叠", short: "过短", long: "过长", missing: "缺译" };

function bindRow(row, idx, pos) {
  const cue = state.subtitles[idx];
  const r = row._;
  row.dataset.idx = String(idx);
  row._cue = cue;
  const y = pos * ROW_H;
  if (row._y !== y) {
    row._y = y;
    row.style.transform = `translateY(${y}px)`;
  }
  r.no.textContent = String(cue.id);
  // A time being typed is left alone; a merely focused box still follows the cue.
  for (const [box, ms] of [[r.start, cue.start_ms], [r.end, cue.end_ms]]) {
    if (document.activeElement !== box || !tcTyped) setVal(box, fmtTime(ms));
  }
  setVal(r.zh, cue.zh || "");
  setVal(r.en, cue.en || "");
  r.en.readOnly = isMotion(cue);
  r.en.placeholder = isMotion(cue) ? "跟随标注" : "English line";
  bindMeta(row, cue, idx);
  row.classList.toggle("selected", idx === state.selectedIdx);
  row.classList.toggle("playing", idx === playingIdx);
  row.classList.toggle("is-top", isTop(cue));
  for (const b of r.jobs) {
    if (busyJobs.get(cue)?.has(b.dataset.act)) b.setAttribute("aria-busy", "true");
    else b.removeAttribute("aria-busy");
  }
  r.pos.setAttribute("aria-pressed", String(isTop(cue)));
}

function bindMeta(row, cue, idx) {
  const r = row._;
  const ms = cue.end_ms - cue.start_ms;
  const issues = cueIssues(cue);
  if (overlaps.has(idx)) issues.unshift("overlap");
  r.dur.textContent = fmtDur(ms);
  r.dur.classList.toggle("warn", ms < LIMITS.minMs);
  const first = issues[0];
  if (isTop(cue)) {
    r.flag.textContent = isMotion(cue) ? "跟随标注" : "顶部注释";
    r.flag.className = "flag top";
  } else if (first) {
    r.flag.textContent = FLAG_TEXT[first];
    r.flag.className = `flag ${first === "missing" ? "soft" : "warn"}`;
  } else {
    const cps = zhLen(cue) / Math.max(0.2, ms / 1000);
    r.flag.textContent = `${cps.toFixed(1)} 字/秒`;
    r.flag.className = "flag";
  }
  const zl = zhLen(cue);
  const el = enLen(cue);
  r.zh.classList.toggle("too-long", zl > LIMITS.zhMax);
  r.en.classList.toggle("too-long", el > LIMITS.enMax);
  r.zh.dataset.tip = zl > LIMITS.zhMax ? `中文 ${zl} 字，单行可能放不下，建议拆成两句` : "";
  r.en.dataset.tip = el > LIMITS.enMax ? `英文 ${el} 字符，单行可能放不下，建议拆成两句` : "";
  if (idx === state.selectedIdx) paintRulers(r, cue);
}

/** The selected row shows how much of the 16:9 frame each line really fills. */
function paintRulers(r, cue) {
  ["zh", "en"].forEach((lang, i) => {
    const ratio = isTop(cue) ? 0 : lineRatio(cue[lang], resolveCueStyle(state.style, cue)[lang]);
    r.rulers[i].style.transform = `scaleX(${Math.min(1, ratio).toFixed(4)})`;
    r.rulers[i].classList.toggle("over", ratio > 1);
    if (ratio > 1) r[lang].dataset.tip = `按当前样式会折成 ${Math.ceil(ratio)} 行，可以拆成两句`;
  });
}

/* ---------- painting ---------- */
const focusedRow = () => {
  const a = document.activeElement;
  return a && sheet.contains(a) ? a.closest(".row") : null;
};

function paintList() {
  const viewH = body.clientHeight;
  if (!viewH) return; // tab hidden: repainted when it is shown again
  const top = body.scrollTop;
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(order.length - 1, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);

  const wanted = new Map();
  for (let p = first; p <= last; p++) wanted.set(state.subtitles[order[p]], p);

  const keep = focusedRow();
  for (const [cue, row] of live) {
    if (wanted.has(cue)) continue;
    // Never recycle the row being typed in: it would drop focus and IME state.
    if (row === keep) {
      const idx = state.subtitles.indexOf(cue);
      if (idx >= 0 && posOf.has(idx)) {
        bindRow(row, idx, posOf.get(idx));
        continue;
      }
      document.activeElement.blur();
    }
    live.delete(cue);
    row.remove();
    row._y = undefined;
    row.classList.remove("enter");
    pool.push(row);
  }
  for (const [cue, p] of wanted) {
    let row = live.get(cue);
    if (!row) {
      row = pool.pop() || makeRow();
      live.set(cue, row);
      bindRow(row, order[p], p);
      if (animateNext) row.classList.add("enter");
      sheet.append(row);
    } else {
      bindRow(row, order[p], p);
    }
  }
  animateNext = false;
  paintProgress();
}

function paintProgress() {
  const cue = state.subtitles[playingIdx];
  const row = cue && live.get(cue);
  if (!row) return;
  const p = (state.currentTimeMs - cue.start_ms) / Math.max(1, cue.end_ms - cue.start_ms);
  row._.prog.style.transform = `scaleX(${Math.min(1, Math.max(0, p)).toFixed(4)})`;
}

function onTime() {
  const idx = cueAt(state.currentTimeMs, false);
  if (idx !== playingIdx) {
    const prev = state.subtitles[playingIdx];
    live.get(prev)?.classList.remove("playing");
    playingIdx = idx;
    const row = live.get(state.subtitles[idx]);
    row?.classList.add("playing");
    const typing = document.activeElement?.matches?.("input") && sheet.contains(document.activeElement);
    if (idx >= 0 && followList && isPlaying() && !typing && performance.now() - userScrolledAt > 2600) reveal(idx, "center");
  }
  invalidate("rowprog");
}

/* ---------- order: filter + search ---------- */
function rebuildOrder() {
  const q = state.searchQuery.trim().toLowerCase();
  const f = state.filter;
  if (f === "overlap") overlaps = overlapSet();
  order = [];
  state.subtitles.forEach((cue, i) => {
    if (q && !`${cue.zh || ""}\n${cue.en || ""}`.toLowerCase().includes(q)) return;
    if (f === "overlap" && !overlaps.has(i)) return;
    if (f !== "all" && f !== "overlap" && !cueIssues(cue).includes(f)) return;
    order.push(i);
  });
  posOf = new Map(order.map((idx, p) => [idx, p]));
  sheet.style.height = `${order.length * ROW_H}px`;
  const none = state.subtitles.length === 0;
  byId("scriptEmpty").hidden = !none;
  byId("scriptNoMatch").hidden = none || order.length > 0;
  sheet.hidden = order.length === 0;
  invalidate("list");
}

function paintStats() {
  overlaps = overlapSet();
  const n = { all: state.subtitles.length, missing: 0, short: 0, long: 0, overlap: overlaps.size };
  let both = 0;
  let dialog = 0;
  for (const c of state.subtitles) {
    for (const k of cueIssues(c)) n[k]++;
    if (!isTop(c)) {
      dialog++;
      if (trimmed(c.zh) && trimmed(c.en)) both++;
    }
  }
  for (const b of $$("#filterChips button")) {
    const k = b.dataset.value;
    $("b", b).textContent = String(n[k]);
    b.hidden = k !== "all" && n[k] === 0 && state.filter !== k;
  }
  if (state.filter !== "all" && n[state.filter] === 0 && order.length === 0) setFilter("all");
  const pct = dialog ? Math.floor((both / dialog) * 100) : 0;
  const meter = byId("bilingualMeter");
  meter.style.setProperty("--p", String(pct / 100));
  $("b", meter).textContent = dialog ? `${pct}%` : "0%";
  meter.dataset.tip = !dialog ? "还没有字幕" : both === dialog ? `${dialog} 句对白，中英都齐了` : `还有 ${dialog - both} 句没配齐，点一下跳过去`;
  if (lastPct >= 0 && lastPct < 100 && pct === 100 && dialog > 0) {
    meter.classList.remove("cheer");
    void meter.offsetWidth;
    meter.classList.add("cheer");
    emit("status", "中英都齐了");
  }
  lastPct = dialog ? pct : -1;
  byId("tabScriptCount").textContent = n.all ? String(n.all) : "";
  // Row flags depend on overlaps, which other rows can change.
  invalidate("list");
}
let lastPct = -1;
let statsTimer = 0;
const statsSoon = () => {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => invalidate("stats"), 120);
};

let filterSeg = null;
export function setFilter(value) {
  state.filter = value;
  filterSeg.set(value, { animate: false });
  for (const b of $$("#filterChips button")) b.setAttribute("aria-checked", String(b.dataset.value === value));
  rebuildOrder();
  body.scrollTop = 0;
}

export function clearFilters() {
  if (!state.searchQuery && state.filter === "all") return;
  state.searchQuery = "";
  byId("inpSearch").value = "";
  byId("searchBox").classList.remove("has-value");
  setFilter("all");
}

/* ---------- revealing / focusing ---------- */
function reveal(idx, block = "nearest", instant = false) {
  const p = posOf.get(idx);
  if (p === undefined || !body.clientHeight) return;
  const y = p * ROW_H;
  const top = body.scrollTop;
  const viewH = body.clientHeight;
  let target = top;
  if (block === "center") {
    if (y >= top + viewH * 0.18 && y + ROW_H <= top + viewH * 0.82) return;
    target = y - (viewH - ROW_H) / 2;
  } else if (y < top + 6) target = y - 10;
  else if (y + ROW_H > top + viewH - 6) target = y + ROW_H - viewH + 10;
  else return;
  target = Math.max(0, Math.min(target, sheet.offsetHeight - viewH));
  const far = Math.abs(target - top) > viewH * 2.5;
  if (far && !instant) body.scrollTop = target + Math.sign(top - target) * viewH * 0.6;
  autoScrolling = performance.now();
  body.scrollTo({ top: target, behavior: instant ? "instant" : "smooth" });
}
let autoScrolling = -1e9;

function focusField(idx, field) {
  if (!posOf.has(idx)) clearFilters();
  reveal(idx, "nearest", true);
  paintList();
  const row = live.get(state.subtitles[idx]);
  const input = row && $(field.startsWith("t-") ? `.${field}` : `.ln.${field}`, row);
  input?.focus({ preventScroll: true });
  if (input && field.startsWith("t-")) input.select();
}

/** For the global keys: ↑ ↓ walk the rows that are showing, Delete needs a visible one. */
export const cueVisible = (idx) => posOf.has(idx);
export function stepCue(dir) {
  if (!order.length) return -1;
  const p = posOf.get(state.selectedIdx);
  if (p !== undefined) return order[p + dir] ?? -1;
  // the selection is filtered out: take the nearest visible row in that direction
  return dir > 0 ? (order.find((i) => i > state.selectedIdx) ?? -1) : (order.findLast((i) => i < state.selectedIdx) ?? -1);
}

/** Next visible row in a direction, or -1 */
function neighbour(idx, dir) {
  const p = posOf.get(idx);
  return p === undefined ? -1 : (order[p + dir] ?? -1);
}

/* ---------- events ---------- */
/** Busy state belongs to the cue, not to a button that may be recycled for another row. */
async function rowJob(idx, name, job) {
  const cue = state.subtitles[idx];
  const set = busyJobs.get(cue) || new Set();
  if (set.has(name)) return;
  busyJobs.set(cue, set.add(name));
  invalidate("list");
  try {
    await job(idx);
  } finally {
    set.delete(name);
    if (!set.size) busyJobs.delete(cue);
    invalidate("list");
  }
}

const ACTIONS = {
  play: (idx) => {
    selectCue(idx);
    replayCue();
  },
  pos: togglePos,
  trans: (idx) => rowJob(idx, "trans", translateCue),
  split: (idx) => rowJob(idx, "split", splitCue),
  insert: insertAfter,
  merge: mergeNext,
  del: deleteCue,
};

const idxOf = (node) => {
  const row = node.closest?.(".row");
  return row ? state.subtitles.indexOf(row._cue) : -1;
};

function bindEvents() {
  sheet.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const idx = idxOf(btn);
    if (idx >= 0) ACTIONS[btn.dataset.act]?.(idx);
  });

  sheet.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("[data-act]") || e.target.closest(".row-ops")) return;
    const idx = idxOf(e.target);
    if (idx < 0) return;
    const cue = state.subtitles[idx];
    const isField = e.target.matches("input");
    if (idx !== state.selectedIdx) {
      selectCue(idx, { seek: seekOnClick, reveal: !isField });
    } else if (seekOnClick) {
      const outside = state.currentTimeMs < cue.start_ms || state.currentTimeMs > cue.end_ms;
      if (!isField || outside) seekTo(cue.start_ms + 20);
    }
  });

  sheet.addEventListener("focusin", (e) => {
    editedSinceFocus = false;
    tcTyped = false;
    if (e.target.matches("input")) {
      const idx = idxOf(e.target);
      if (idx >= 0 && idx !== state.selectedIdx) selectCue(idx, { reveal: false });
    }
  });

  sheet.addEventListener("input", (e) => {
    if (e.target.matches(".tc")) tcTyped = true;
    if (!e.target.matches(".ln")) return;
    const idx = idxOf(e.target);
    if (idx < 0) return;
    const cue = state.subtitles[idx];
    const field = e.target.classList.contains("zh") ? "zh" : "en";
    if (cue[field] === e.target.value) return;
    if (!editedSinceFocus) {
      pushHistory(field === "zh" ? "编辑中文" : "编辑英文", capture());
      editedSinceFocus = true;
    }
    cue[field] = e.target.value;
    state.dirty = true;
    emit("cue", { idx, what: "text" });
  });

  sheet.addEventListener("change", (e) => {
    if (!e.target.matches(".tc")) return;
    const idx = idxOf(e.target);
    if (idx < 0) return;
    const edge = e.target.classList.contains("t-start") ? "start" : "end";
    const cue = state.subtitles[idx];
    const ms = parseTime(e.target.value);
    if (!setCueTime(idx, edge, ms)) {
      e.target.classList.remove("shake");
      void e.target.offsetWidth;
      e.target.classList.add("shake");
      toast(ms === null ? "时间格式应为 分:秒.百分秒，例如 01:23.45" : "结束时间必须晚于开始时间", { type: "error", key: "tc" });
    }
    tcTyped = false;
    e.target.value = fmtTime(cue[`${edge}_ms`]);
  });

  sheet.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME is using the key
    const t = e.target;
    if (!t.matches?.("input")) return;
    const idx = idxOf(t);
    if (idx < 0) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      tcTyped = false;
      if (t.matches(".tc")) t.value = fmtTime(state.subtitles[idx][t.matches(".t-start") ? "start_ms" : "end_ms"]);
      t.blur();
      return;
    }
    if (t.matches(".tc")) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Nudge like a scrubbable number: 0.05 s, or 0.5 s with Shift.
        e.preventDefault();
        const edge = t.matches(".t-start") ? "start" : "end";
        const cue = state.subtitles[idx];
        const base = (tcTyped ? parseTime(t.value) : null) ?? cue[`${edge}_ms`];
        const next = Math.max(0, base + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 500 : 50));
        if (setCueTime(idx, edge, next, { nudge: true })) {
          tcTyped = false;
          t.value = fmtTime(cue[`${edge}_ms`]);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        t.blur();
      } else if (e.key === "Tab" && !e.ctrlKey) {
        e.preventDefault();
        const startField = t.matches(".t-start");
        t.blur();
        if (e.shiftKey) focusField(idx, startField ? "zh" : "t-start");
        else focusField(idx, startField ? "t-end" : "zh");
      }
      return;
    }
    const field = t.classList.contains("zh") ? "zh" : "en";
    const go = (target, col) => {
      if (target < 0) return;
      selectCue(target, { seek: seekOnClick, reveal: false });
      focusField(target, col);
    };
    if (e.key === "Enter") {
      e.preventDefault();
      go(neighbour(idx, e.shiftKey ? -1 : 1), field);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      go(neighbour(idx, e.key === "ArrowDown" ? 1 : -1), field);
    } else if (e.key === "Tab" && !e.ctrlKey) {
      e.preventDefault();
      if (!e.shiftKey && field === "zh") focusField(idx, "en");
      else if (e.shiftKey && field === "en") focusField(idx, "zh");
      else go(neighbour(idx, e.shiftKey ? -1 : 1), e.shiftKey ? "en" : "zh");
    }
  });

  body.addEventListener("scroll", () => invalidate("list"), { passive: true });
  for (const ev of ["wheel", "pointerdown"]) {
    body.addEventListener(ev, () => {
      userScrolledAt = performance.now();
    }, { passive: true });
  }
  sheet.addEventListener("animationend", (e) => {
    e.target.classList?.remove("enter", "shake");
  });

  const search = byId("inpSearch");
  search.addEventListener("input", () => {
    state.searchQuery = search.value;
    byId("searchBox").classList.toggle("has-value", Boolean(search.value));
    rebuildOrder();
    body.scrollTop = 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (search.value) {
        search.value = "";
        search.dispatchEvent(new Event("input"));
      } else search.blur();
    }
  });
  byId("btnClearSearch").addEventListener("click", () => {
    search.value = "";
    search.dispatchEvent(new Event("input"));
    search.focus();
  });
  byId("btnNoMatchReset").addEventListener("click", clearFilters);
  byId("bilingualMeter").addEventListener("click", () => {
    const n = state.subtitles.length;
    for (let k = 1; k <= n; k++) {
      const i = (state.selectedIdx + k) % n;
      const c = state.subtitles[i];
      if (isTop(c) || (trimmed(c.zh) && trimmed(c.en))) continue;
      selectCue(i, { seek: true, focus: trimmed(c.zh) ? "en" : "zh" });
      return;
    }
    if (n) toast("每一句都中英齐全");
  });
  byId("btnNewCue").addEventListener("click", () => addCueAt(state.currentTimeMs));
}

export function setSeekOnClick(on_) {
  seekOnClick = on_;
  byId("chkSeek").checked = on_;
}
export const getSeekOnClick = () => seekOnClick;

export function initScript() {
  bindEvents();
  filterSeg = bindSeg(byId("filterChips"), (v) => setFilter(v));
  byId("chkSeek").addEventListener("change", (e) => {
    setSeekOnClick(e.target.checked);
    emit("pref", { seekOnClick });
  });

  registerDraw("stats", paintStats);
  registerDraw("list", paintList);
  registerDraw("rowprog", paintProgress);

  on("time", onTime);
  on("cues", ({ animate, bulk }) => {
    playingIdx = cueAt(state.currentTimeMs, false);
    if (bulk && !state.subtitles.length && state.filter !== "all") setFilter("all");
    if (animate) {
      animateNext = true;
      sheet.classList.add("reflow");
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => sheet.classList.remove("reflow"), 300);
    }
    rebuildOrder();
    invalidate("stats");
  });
  on("cue", ({ idx, live: dragging }) => {
    const row = live.get(state.subtitles[idx]);
    if (row) bindRow(row, idx, posOf.get(idx) ?? 0);
    if (!dragging) statsSoon();
  });
  on("select", ({ idx, prev, reveal: shouldReveal, focus }) => {
    const left = state.subtitles[prev];
    const leftRow = prev !== idx && live.get(left);
    if (leftRow) bindMeta(leftRow, left, prev); // back to the plain tooltip
    for (const [cue, row] of live) {
      const on_ = state.subtitles[idx] === cue;
      row.classList.toggle("selected", on_);
      if (on_) paintRulers(row._, cue);
    }
    if (focus) {
      emit("show-tab", "script");
      focusField(idx, focus);
    } else if (shouldReveal !== false) reveal(idx);
  });
  on("request-select", ({ idx }) => selectCue(idx));
  on("edit-cue", (idx) => selectCue(idx, { focus: "zh" }));
  on("style", () => {
    const cue = state.subtitles[state.selectedIdx];
    const row = cue && live.get(cue);
    if (row) bindMeta(row, cue, state.selectedIdx);
  });
  // Any other undo step ends the current run of typing.
  on("history", () => {
    editedSinceFocus = false;
  });
  on("pulse", (amp) => {
    const row = live.get(state.subtitles[playingIdx]);
    row?._.eq.style.setProperty("--a", amp.toFixed(3));
  });

  new ResizeObserver(() => invalidate("list")).observe(body);
  rebuildOrder();
  invalidate("stats");
}
