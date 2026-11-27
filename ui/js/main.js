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
import { initLyrics, openLyrics } from "./lyrics.js";
import { initPulse } from "./pulse.js";
import { initAura } from "./aura.js";
import { addCueAt, cleanPunctuation, clearAll, fixSwappedColumns, markEndNext, markStart, shiftAll, sortByTime } from "./cues.js";

const AUTOSAVE_MS = 25000;

/* Shown only when the page is opened without the desktop backend. */
const OFFLINE_PRESETS = [
  { id: "us_drama_default", name: "美剧双语经典", desc: "银灰白中文 + 暖沙金英文", ...structuredClone(DEFAULT_STYLE) },
  {
    id: "cinema_classic", name: "经典蓝光", desc: "方正黑体浅灰中文与 Tahoma 粗体亮白英文，沿用默认模板的中英间距",
    order: "zh_top", margin_v: 20, line_gap: DEFAULT_STYLE.line_gap, blur: 0, ycbcr_matrix: "None",
    box_mode: false, box_color: "#000000", box_opacity: 0.55,
    zh: { style_name: "chs", font: "方正黑体_GBK", size: 66, color: "#DBDBDB", secondary_color: "#FF0000", outline_color: "#000000", outline: 1, shadow: 1, scale_x: 100, margin_l: 10, margin_r: 10, bold: false, italic: false },
    en: { style_name: "eng", font: "Tahoma", size: 45, color: "#FFFFFF", secondary_color: "#FF0000", outline_color: "#000000", outline: 1, shadow: 1, scale_x: 100, margin_l: 10, margin_r: 10, bold: true, italic: false },
  },
  {
    id: "doc_immersive_box", name: "纪录片黑底沉浸盒", desc: "半透明圆润黑底条，白底亮画面也清晰可读",
    order: "zh_top", margin_v: 50, line_gap: 6, blur: 0, box_mode: true, box_color: "#0F172A", box_opacity: 0.72,
    zh: { font: "Microsoft YaHei", size: 52, color: "#F8FAFC", outline_color: "#0F172A", outline: 2.2, shadow: 0, scale_x: 100, bold: true, italic: false },
    en: { font: "Segoe UI", size: 32, color: "#CBD5E1", outline_color: "#0F172A", outline: 1.8, shadow: 0, scale_x: 100, bold: false, italic: false },
  },
  {
    id: "english_learner", name: "英语学习主英辅中", desc: "英文大字在上、中文辅助在下",
    order: "en_top", margin_v: 44, line_gap: 5, blur: 1.5, box_mode: false, box_color: "#000000", box_opacity: 0.5,
    zh: { font: "WenQuanYi Micro Hei", size: 38, color: "#CBD5E1", outline_color: "#0F172A", outline: 2.0, shadow: 1.2, scale_x: 95, bold: false, italic: false },
    en: { font: "Avenir Next W1G", size: 52, color: "#FEF08A", outline_color: "#0F172A", outline: 2.8, shadow: 1.6, scale_x: 98, bold: true, italic: false },
  },
  {
    id: "lyrics_yellow", name: "歌词 · 经典亮黄", desc: "蜘蛛体双语歌词，亮黄纯色、2.5 柔边，中英间距 9",
    order: "zh_top", margin_v: 30, line_gap: 9, blur: 2.5, box_mode: false, box_color: "#000000", box_opacity: 0.5,
    zh: { style_name: "Lyrics", font: "【嵐】蜘蛛体", size: 68, color: "#FFF200", outline_color: "#463C37", outline: 3.0, shadow: 1.0, scale_x: 100, margin_l: 10, margin_r: 10, bold: false, italic: false },
    en: { style_name: "LyricsENG", font: "【嵐】蜘蛛体", size: 45, color: "#CCC200", outline_color: "#463C37", outline: 3.0, shadow: 1.0, scale_x: 100, margin_l: 10, margin_r: 10, bold: false, italic: false },
  },
  {
    id: "lyrics_shinkai", name: "歌词 · 新海诚黄昏", desc: "暮紫×晚霞橙四角渐变、镜头聚焦动效与 150ms 淡入淡出，副字幕降亮 20%",
    order: "zh_top", margin_v: 30, line_gap: 9, blur: 2.5, fade_in_ms: 150, fade_out_ms: 150, anim: "shinkai_focus", anim_mult: 1.0, sub_anim: true,
    box_mode: false, box_color: "#000000", box_opacity: 0.5,
    zh: { style_name: "Lyrics", font: "【嵐】蜘蛛体", size: 68, color: "#AC6782", gradient: ["#764EB2", "#EE8A3A", "#EE8A3A", "#764EB2"], outline_color: "#000A1A", back_color: "#1A0010", back_opacity: 0.4, outline: 2.8, shadow: 1.5, scale_x: 100, margin_l: 10, margin_r: 10, bold: false, italic: false },
    en: { style_name: "LyricsENG", font: "【嵐】蜘蛛体", size: 45, color: "#8A5268", gradient: ["#5E3E8E", "#BE6E2E", "#BE6E2E", "#5E3E8E"], outline_color: "#000A1A", back_color: "#1A0010", back_opacity: 0.4, outline: 2.8, shadow: 1.5, scale_x: 100, margin_l: 10, margin_r: 10, bold: false, italic: false },
  },
];

function bindToolbars() {
  byId("btnMarkStart").addEventListener("click", markStart);
  byId("btnMarkEnd").addEventListener("click", markEndNext);
  byId("btnAddCue").addEventListener("click", () => addCueAt(state.currentTimeMs));
  for (const b of $$("[data-shift]")) b.addEventListener("click", () => shiftAll(Number(b.dataset.shift)));

  const tidy = { fix: openSmartFix, lyrics: () => openLyrics("guide"), punct: cleanPunctuation, pair: () => openImport("pair"), swap: fixSwappedColumns, sort: sortByTime, clear: clearAll };
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
  initLyrics();
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
