/* Smart fix: scan the list, show what is wrong, repair it in one undoable step. */

import { $, byId, prefersReducedMotion } from "./util.js";
import { state } from "./store.js";
import { closeModal, openModal, toast, withBusy } from "./feedback.js";
import { bindSeg } from "./controls.js";
import { call } from "./bridge.js";
import { applyTaskResult, followTask, jobMark, taskRunning } from "./tasks.js";

let orphanMode = "merge";
let orphanSeg;
let scanToken = 0;

const ORPHAN_NOTE = {
  merge: "把被拆开的上下两行合成完整一句，立即完成。",
  ai_split: "保留两段时间轴，用 AI 按语义把长句切开填回空行。",
  none: "断句孤行保持原样。",
};

/* ---------- diagnosis tiles ---------- */
function countUp(node, to) {
  if (prefersReducedMotion() || to <= 0) {
    node.textContent = String(to);
    return;
  }
  const t0 = performance.now();
  const run = (now) => {
    const p = Math.min(1, (now - t0) / 620);
    node.textContent = String(Math.round(to * (1 - (1 - p) ** 3)));
    if (p < 1) requestAnimationFrame(run);
  };
  requestAnimationFrame(run);
  // rAF is paused in background windows
  setTimeout(() => {
    node.textContent = String(to);
  }, 760);
}

function setTile(id, n, note = "") {
  const tile = byId(id);
  tile.classList.toggle("clean", n === 0);
  tile.classList.remove("wait");
  countUp($("b", tile), n);
  $("small", tile).textContent = n === 0 ? "没有问题" : note;
}

async function scan() {
  const token = ++scanToken;
  for (const id of ["diagOrphan", "diagSdh", "diagOverlap", "diagMissing"]) {
    byId(id).classList.add("wait");
    $("b", byId(id)).textContent = "–";
    $("small", byId(id)).textContent = "正在检查";
  }
  const d = await call("diagnose_subtitle_issues", state.subtitles);
  if (token !== scanToken) return;
  if (!d.ok) {
    for (const id of ["diagOrphan", "diagSdh", "diagOverlap", "diagMissing"]) $("small", byId(id)).textContent = "检查失败";
    return d.error && toast(d.error, { type: "error" });
  }
  setTile("diagOrphan", d.split_orphan_count, "一句被拆成两行");
  setTile("diagSdh", d.pure_sdh_row_count + d.inline_sdh_count, `${d.pure_sdh_row_count} 行 + ${d.inline_sdh_count} 处`);
  setTile("diagOverlap", d.time_overlap_count, "上下句打架");
  setTile("diagMissing", d.missing_trans_count, d.foreign_note_count ? `另有 ${d.foreign_note_count} 句外语标注` : "只有一种语言");
}

export function openSmartFix() {
  if (!state.subtitles.length) return toast("还没有字幕可以精修");
  openModal("modalSmartFix");
  if (!taskRunning()) {
    byId("fixProgress").hidden = true;
    scan();
  }
}

/* ---------- run ---------- */
async function run(btn) {
  if (taskRunning()) return toast("已有任务在运行，请等它完成");
  if (!state.subtitles.length) return toast("还没有字幕可以精修");
  return withBusy(btn, async () => {
    const punct = byId("fixPunct").checked;
    const mark = jobMark();
    const res = await call("start_smart_bilingual_autofix", state.subtitles, {
      orphan_mode: orphanMode,
      clean_sdh: byId("fixSdh").checked,
      fix_overlaps: byId("fixOverlap").checked,
      fill_missing_ai: byId("fixFill").checked,
      skip_foreign_notes: byId("fixSkipForeign").checked,
    });
    if (!res.ok) return toast(res.error || "没能启动精修", { type: "error" });
    followTask({
      label: "FIX",
      modal: "modalSmartFix",
      box: byId("fixProgress"),
      onStart: () => setRunning(true),
      onEnd: () => setRunning(false),
      onDone: async (st) => {
        let subs = st.result?.subtitles;
        if (!subs) return;
        if (punct) {
          const p = await call("clean_us_drama_punctuation", subs);
          if (p.ok) subs = p.subtitles;
        }
        const message = String(st.message || "精修完成").replace("（可按 Ctrl+Z 撤销）", "").replace(/！$/, "");
        const applied = applyTaskResult({ subs, label: "智能精修", mark, message, select: state.selectedIdx });
        setTimeout(() => {
          byId("fixProgress").hidden = true;
          if (applied) closeModal("modalSmartFix");
        }, 700);
      },
    });
  });
}

function setRunning(on) {
  byId("fixForm").inert = on;
  const btn = byId("btnFixRun");
  btn.disabled = on;
  $("span", btn).textContent = on ? "正在精修…" : "开始精修";
}

export function initSmartFix() {
  orphanSeg = bindSeg(byId("fixOrphan"), (v) => {
    orphanMode = v;
    byId("fixOrphanNote").textContent = ORPHAN_NOTE[v];
  });
  orphanSeg.set(orphanMode, { animate: false });
  byId("fixOrphanNote").textContent = ORPHAN_NOTE[orphanMode];
  const fill = byId("fixFill");
  const syncFill = () => {
    byId("fixSkipRow").hidden = !fill.checked;
  };
  fill.addEventListener("change", syncFill);
  syncFill();
  byId("btnFixRun").addEventListener("click", (e) => run(e.currentTarget));
}
