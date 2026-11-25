/* EasySub Studio: boot order and wiring. */

import { $, $$, byId } from "./util.js";
import { DEFAULT_STYLE, emit, invalidate, normalizeCues, pushHistory, state, syncDuration } from "./store.js";
import { initMenus, initModals, initTooltips, toast, withBusy } from "./feedback.js";
import { call, callQuiet, whenReady } from "./bridge.js";
import { initPlayer } from "./player.js";
import { initStage } from "./stage.js";
import { initTimeline } from "./timeline.js";
import { initScript } from "./script.js";
import { applyStyle, initStyles, renderPresets } from "./styles.js";
import { initMedia, loadVideo } from "./media.js";
import { initImporter, openImport } from "./importer.js";
import { initTasks } from "./tasks.js";
import { initAi, openAi, populateSettings } from "./ai.js";
import { initExporter } from "./exporter.js";
import { initFind } from "./find.js";
import { applyPrefs, initShell, showTab } from "./shell.js";
import { initPalette } from "./palette.js";
import { initSmartFix, openSmartFix } from "./smartfix.js";
import { initPulse } from "./pulse.js";
import { initAura } from "./aura.js";
import { addCueAt, cleanPunctuation, clearAll, fixSwappedColumns, markEndNext, markStart, shiftAll, sortByTime } from "./cues.js";

const AUTOSAVE_MS = 25000;

/* Shown only when the page is opened without the desktop backend. */
const OFFLINE_PRESETS = [
  { id: "us_drama_default", name: "美剧双语经典", desc: "银灰白中文 + 暖沙金英文", ...structuredClone(DEFAULT_STYLE) },
  {
    id: "cinema_classic", name: "经典蓝光亮白", desc: "纯白中文 + 浅灰英文",
    order: "zh_top", margin_v: 42, line_gap: 4, blur: 0.8, box_mode: false, box_color: "#000000", box_opacity: 0.55,
    zh: { font: "Microsoft YaHei", size: 58, color: "#FFFFFF", outline_color: "#111827", outline: 2.4, shadow: 1.6, scale_x: 100, bold: true, italic: false },
    en: { font: "Segoe UI", size: 36, color: "#E2E8F0", outline_color: "#111827", outline: 1.8, shadow: 1.4, scale_x: 100, bold: false, italic: false },
  },
];

function bindToolbars() {
  byId("btnMarkStart").addEventListener("click", markStart);
  byId("btnMarkEnd").addEventListener("click", markEndNext);
  byId("btnAddCue").addEventListener("click", () => addCueAt(state.currentTimeMs));
  for (const b of $$("[data-shift]")) b.addEventListener("click", () => shiftAll(Number(b.dataset.shift)));

  const tidy = { fix: openSmartFix, punct: cleanPunctuation, pair: () => openImport("pair"), swap: fixSwappedColumns, sort: sortByTime, clear: clearAll };
  for (const b of $$("#oneClick [data-do]")) {
    const label = $("span", b);
    const name = label?.textContent;
    let timer = 0;
    b.addEventListener("click", async () => {
      const said = await withBusy(b, async () => tidy[b.dataset.do]({ quiet: true }));
      if (typeof said !== "string" || !label) return;
      label.textContent = said;
      b.classList.add("told");
      clearTimeout(timer);
      timer = setTimeout(() => {
        label.textContent = name;
        b.classList.remove("told");
      }, 2400);
    });
  }
  byId("btnFootPreset").addEventListener("click", () => showTab("style"));

  byId("emptyImport").addEventListener("click", () => openImport("open"));
  byId("emptyPaste").addEventListener("click", () => openImport("paste"));
  byId("emptyAi").addEventListener("click", () => openAi("asr_and_translate"));
  byId("emptyNew").addEventListener("click", () => addCueAt(state.currentTimeMs));
}

/* ---------- crash recovery ---------- */
function offerDraft(meta) {
  const btn = byId("btnRestore");
  byId("restoreLabel").textContent = `恢复上次草稿（${meta.count} 句 · ${meta.saved_at}）`;
  const wrap = byId("restoreWrap");
  wrap.hidden = false;
  byId("btnRestoreDrop").onclick = () => {
    wrap.hidden = true;
  };
  btn.onclick = async () => {
    wrap.hidden = true; // one click only
    const res = await call("load_autosave_draft");
    if (!res.ok) {
      wrap.hidden = false;
      return res.error && toast(res.error, { type: "error" });
    }
    const { draft } = res;
    if (draft.style) applyStyle(draft.style);
    if (draft.subtitles?.length) {
      pushHistory("恢复草稿");
      state.subtitles = normalizeCues(draft.subtitles);
      state.selectedIdx = 0;
      syncDuration();
      emit("cues", { bulk: true });
      emit("select", { idx: 0 });
    }
    toast(`已恢复上次草稿，共 ${state.subtitles.length} 句`, { type: "success" });
    if (draft.video_path) await loadVideo(draft.video_path, { keepCues: true });
  };
}

function startAutosave() {
  setInterval(async () => {
    if (!state.dirty || state.isDemo || !state.subtitles.length) return;
    state.dirty = false;
    const res = await callQuiet("save_autosave_draft", {
      video_name: state.videoName,
      style: state.style,
      subtitles: state.subtitles,
    });
    if (res.ok) {
      byId("footSave").textContent = `已自动暂存 ${res.saved_at}`;
    } else state.dirty = true;
  }, AUTOSAVE_MS);
}

function watchPixelRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    "change",
    () => {
      emit("dpr");
      watchPixelRatio();
    },
    { once: true },
  );
}

async function boot() {
  initModals();
  initTooltips();
  initMenus();
  initTasks();
  initPlayer();
  initStage();
  initAura();
  initTimeline();
  initScript();
  initStyles();
  initMedia();
  initImporter();
  initAi();
  initExporter();
  initFind();
  initShell();
  initPalette();
  initSmartFix();
  initPulse();
  bindToolbars();
  watchPixelRatio();
  state.presets = OFFLINE_PRESETS;
  renderPresets();
  document.documentElement.classList.add("ready");

  await whenReady(); // in a plain browser this simply never resolves
  const data = await callQuiet("get_initial_bootstrap");
  byId("appVersion").textContent = data.version ? `EasySub Studio v${data.version}` : "EasySub Studio 源码运行";
  if (data.presets?.length) {
    state.presets = data.presets;
    applyStyle(data.presets[0], data.presets[0].id);
    renderPresets();
  }
  if (data.settings) {
    populateSettings(data.settings);
    applyPrefs(data.settings.ui || {});
  }
  if (data.autosave_meta?.count > 0) offerDraft(data.autosave_meta);
  startAutosave();
  invalidate("overlay", "strip", "head", "list");
}

boot();
