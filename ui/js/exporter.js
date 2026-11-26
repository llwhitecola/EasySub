/* Export dialog and the Blu-ray SUP workbench. */

import { $, byId } from "./util.js";
import { state } from "./store.js";
import { closeModal, openModal, toast, withBusy } from "./feedback.js";
import { call } from "./bridge.js";
import { bindSeg } from "./controls.js";
import { followTask, taskRunning } from "./tasks.js";
import { gapHint } from "./subs-render.js";
import { resolveCueStyle } from "./cue-style.js";

const LANG_LABEL = { bilingual: "双语", zh_only: "仅中文", en_only: "仅英文" };
let lang = "bilingual";
let langSeg;

function paintExport() {
  const rows = state.subtitles.length;
  byId("exportCount").textContent = rows
    ? state.isDemo
      ? `当前是 ${rows} 句演示字幕`
      : `当前共 ${rows} 句`
    : "当前没有字幕";
  for (const id of ["expAss", "expSrt"]) $(".exp-lang", byId(id)).textContent = LANG_LABEL[lang];
}

export function openExport() {
  lang = state.langMode;
  langSeg.set(lang, { animate: false });
  paintExport();
  openModal("modalExport");
}

let cheerTimer = 0;
function celebrate() {
  const btn = byId("btnOpenExport");
  btn.classList.add("done");
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => btn.classList.remove("done"), 2200);
}

/**
 * The preview measures each line's ink padding for the fonts it actually draws with;
 * hand the exporter the same numbers so `中英间距` stays the visible pixel gap it shows.
 */
function collectInk() {
  return state.subtitles.map((cue) => {
    if (cue.pos === "top" || Array.isArray(cue.motion)) return null;
    return gapHint(resolveCueStyle(state.style, cue), cue.zh, cue.en);
  });
}

async function doExport(fmt, btn) {
  return withBusy(btn, async () => {
    if (!state.subtitles.length) return toast("还没有字幕可以导出");
    const ink = fmt === "ass" ? collectInk() : null;
    const res = await call("export_subtitle_dialog", fmt, fmt === "project" ? "bilingual" : lang, state.subtitles, state.style, state.videoStem, ink);
    if (res.ok) {
      closeModal("modalExport");
      celebrate();
      toast(`已保存到 ${res.saved_path}`, { type: "success", ms: 6000 });
    } else if (res.error) toast(res.error, { type: "error" });
  });
}

/* ---------- SUP ---------- */
function paintSupRenderer() {
  byId("supVsFilterOptions").hidden = byId("supRenderer").value !== "vsfiltermod";
  byId("supPluginPath").textContent = state.settings.sup_vsfiltermod_dll || "尚未选择插件";
}

export function openSup() {
  byId("supLang").value = state.langMode;
  byId("supCurrentCount").textContent = state.subtitles.length ? `${state.subtitles.length} 句` : "没有字幕";
  paintSupRenderer();
  openModal("modalSup");
}

async function runSup(btn, start) {
  if (taskRunning()) return toast("已有任务在运行，请等它完成");
  const renderer = byId("supRenderer").value;
  if (renderer === "vsfiltermod" && !state.settings.sup_vsfiltermod_dll) {
    return toast("请先选择 VSFilterMod.dll", { type: "error" });
  }
  return withBusy(btn, async () => {
    const res = await start(byId("supRes").value, byId("supFps").value, renderer);
    if (res.cancelled) return;
    if (!res.ok || !res.started) return res.error && toast(res.error, { type: "error" });
    followTask({
      label: "SUP",
      modal: "modalSup",
      box: byId("supProgress"),
      onStart: () => setSupRunning(true),
      onEnd: () => setSupRunning(false),
      onDone: (st) => {
        celebrate();
        toast(st.message || "SUP 已生成", { type: "success", ms: 6500 });
      },
    });
  });
}

function setSupRunning(on) {
  byId("supForm").inert = on;
  byId("modalSup").classList.toggle("running", on);
}

export function initExporter() {
  langSeg = bindSeg(byId("exportLang"), (v) => {
    lang = v;
    paintExport();
  });
  byId("btnOpenExport").addEventListener("click", openExport);
  byId("expAss").addEventListener("click", (e) => doExport("ass", e.currentTarget));
  byId("expSrt").addEventListener("click", (e) => doExport("srt", e.currentTarget));
  byId("expProject").addEventListener("click", (e) => doExport("project", e.currentTarget));
  byId("expSup").addEventListener("click", () => {
    closeModal("modalExport");
    openSup();
    byId("supLang").value = lang;
  });

  byId("btnOpenSup").addEventListener("click", openSup);
  byId("supRenderer").addEventListener("change", paintSupRenderer);
  byId("btnSupPlugin").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    const res = await call("pick_vsfiltermod_dll");
    if (res.ok) {
      state.settings.sup_vsfiltermod_dll = res.path;
      paintSupRenderer();
    } else if (res.error) toast(res.error, { type: "error" });
  }));
  byId("btnSupFiles").addEventListener("click", (e) =>
    runSup(e.currentTarget, (res, fps, renderer) => call("pick_and_convert_ass_to_sup", res, fps, renderer)),
  );
  byId("btnSupCurrent").addEventListener("click", (e) => {
    if (!state.subtitles.length) return toast("还没有字幕可以压制");
    return runSup(e.currentTarget, (res, fps, renderer) =>
      call("export_current_to_sup_dialog", byId("supLang").value, state.subtitles, state.style, res, fps, state.videoStem, collectInk(), renderer),
    );
  });
}
