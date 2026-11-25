/* Import dialog: open a file, merge a second file, pair rows in the table, paste text. */

import { $$, byId } from "./util.js";
import { ownCues, replaceCues } from "./store.js";
import { closeModal, openModal, toast, withBusy } from "./feedback.js";
import { bindSeg } from "./controls.js";
import { call } from "./bridge.js";
import { applyLoadedSubtitles } from "./media.js";
import { undoAction } from "./cues.js";

let tabs = null;

export function openImport(pane = "open") {
  showPane(pane);
  tabs.set(pane, { animate: false });
  openModal("modalImport");
}

function showPane(name) {
  for (const p of $$("#modalImport [data-pane]")) p.hidden = p.dataset.pane !== name;
  if (name === "pair") byId("pairReport").hidden = true;
  if (name === "paste") setTimeout(() => byId("txtPaste").focus(), 60);
  const n = ownCues().length;
  byId("mergeState").textContent = n ? `当前列表有 ${n} 句，会作为第一份字幕。` : "当前列表还没有你的字幕，请先打开第一份。";
}

async function pickReplace(btn) {
  return withBusy(btn, async () => {
    const res = await call("pick_subtitle_file", "replace", "auto", "time", []);
    if (res.cancelled) return;
    if (applyLoadedSubtitles(res)) closeModal("modalImport");
  });
}

async function pickMerge(btn) {
  return withBusy(btn, async () => {
    if (!ownCues().length) return toast("请先打开第一份字幕，再合并第二份");
    const res = await call(
      "pick_subtitle_file",
      "merge",
      "auto",
      byId("selMergeAlign").value,
      ownCues(),
      byId("selMergeBase").value,
      Math.max(0, Number(byId("numMergeTol").value) || 0),
    );
    if (res.cancelled) return;
    if (!res.ok) return res.error && toast(res.error, { type: "error" });
    replaceCues(res.subtitles, "合并双语");
    closeModal("modalImport");
    const detail = res.matched_count !== undefined ? `：配对 ${res.matched_count} 组，单独保留 ${res.unmatched_secondary || 0} 句` : "";
    toast(`合并完成，共 ${res.count} 句${detail}`, { type: "success", action: undoAction() });
  });
}

async function pairRows(previewOnly, btn) {
  return withBusy(btn, async () => {
    if (!ownCues().length) return toast("还没有字幕");
    const res = await call(
      "merge_table_bilingual_rows",
      ownCues(),
      Math.max(0, Number(byId("numPairTol").value) || 0),
      byId("selPairBase").value,
      byId("selPairMode").value,
      previewOnly,
    );
    if (!res.ok) return res.error && toast(res.error, { type: "error" });
    const report = byId("pairReport");
    report.textContent = res.report || "";
    report.hidden = false;
    report.scrollTop = 0;
    if (previewOnly) return;
    if (!res.matched_count) {
      toast("没有找到能配对的中英行，可以调大允许误差，或改用重叠匹配");
      return;
    }
    replaceCues(res.subtitles, "合并中英行");
    toast(`已合并 ${res.matched_count} 组中英字幕`, { type: "success", action: undoAction() });
  });
}

async function importPaste(btn) {
  return withBusy(btn, async () => {
    const text = byId("txtPaste").value.trim();
    if (!text) {
      toast("先把台词粘贴进来");
      byId("txtPaste").focus();
      return;
    }
    const merge = byId("chkPasteMerge").checked;
    const res = await call("import_pasted_script", text, byId("selPasteMode").value, merge, ownCues());
    if (!res.ok) return res.error && toast(res.error, { type: "error" });
    if (!res.subtitles?.length) return toast("没有识别到台词");
    replaceCues(res.subtitles, "粘贴台词");
    byId("txtPaste").value = "";
    closeModal("modalImport");
    toast(`已生成 ${res.count} 句，播放时按 F3 / F4 打轴`, { type: "success", action: undoAction() });
  });
}

export function initImporter() {
  tabs = bindSeg(byId("importTabs"), showPane, "aria-selected");
  byId("btnOpenImport").addEventListener("click", () => openImport("open"));
  byId("btnPickReplace").addEventListener("click", (e) => pickReplace(e.currentTarget));
  byId("btnPickMerge").addEventListener("click", (e) => pickMerge(e.currentTarget));
  byId("btnPairPreview").addEventListener("click", (e) => pairRows(true, e.currentTarget));
  byId("btnPairRun").addEventListener("click", (e) => pairRows(false, e.currentTarget));
  byId("btnPasteGo").addEventListener("click", (e) => importPaste(e.currentTarget));
  byId("txtPaste").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) byId("btnPasteGo").click();
  });
}

