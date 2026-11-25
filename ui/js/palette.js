/* Command palette (Ctrl K): run any command, jump to a line number, a time, or some words. */

import { byId, fmtTime, h, icon, parseTime } from "./util.js";
import { emit, state, trimmed } from "./store.js";
import { closeModal, onModalClose, openModal } from "./feedback.js";
import { seekTo, togglePlay } from "./player.js";
import {
  addCueAt, cleanPunctuation, clearAll, deleteCue, fixSwappedColumns, insertAfter, markEndNext, markStart, mergeNext,
  selectCue, shiftAll, sortByTime, splitCue, togglePos, translateCue,
} from "./cues.js";
import { openImport } from "./importer.js";
import { openSmartFix } from "./smartfix.js";
import { openAi } from "./ai.js";
import { openExport, openSup } from "./exporter.js";
import { openFind } from "./find.js";
import { openVideoDialog } from "./media.js";
import { applyStyle, setLangMode } from "./styles.js";
import { clearFilters, setFilter } from "./script.js";
import { doRedo, doUndo, showTab, toggleTheme } from "./shell.js";
import { toggleTheatre } from "./stage.js";
import { setMood } from "./aura.js";
import { zoomCue, zoomFit } from "./timeline.js";

/* [label, keywords (pinyin, English), icon, keys, run] */
const COMMANDS = [
  ["打开视频", "dakai shipin video open dksp", "film", "Ctrl O", () => openVideoDialog(byId("btnOpenVideo"))],
  ["打开字幕文件", "dakai zimu import srt ass dkzm daoru", "file", "Ctrl I", () => openImport("open")],
  ["合并第二份字幕", "hebing hezhou merge hbzm", "layers", "", () => openImport("merge")],
  ["表内中英配对", "peidui pair hebing pd", "pair", "", () => openImport("pair")],
  ["粘贴台词", "zhantie paste zttc", "paste", "", () => openImport("paste")],
  ["AI 听写并翻译", "ai tingxie fanyi whisper asr tx", "spark", "", () => openAi("asr_and_translate")],
  ["AI 只翻译", "ai fanyi translate fy", "translate", "", () => openAi("translate_only")],
  ["AI 精翻 Agent 设置", "agent shezhi moxing key llm deepseek", "spark", "", () => openAi("translate_only")],
  ["AI 只听写", "ai tingxie dictate asr tx", "mic", "", () => openAi("asr_only")],
  ["导出字幕", "daochu export save ass srt dc", "export", "Ctrl S", openExport],
  ["压制蓝光 SUP", "sup pgs languang yazhi bluray", "disc", "", openSup],
  ["播放 / 暂停", "bofang zanting play pause bf", "play", "F2", togglePlay],
  ["设为开始", "kaishi start in ks", "check", "F3", markStart],
  ["设为结束，下一句", "jieshu end out js", "check", "F4", markEndNext],
  ["新建一句", "xinjian new add xj", "plus", "Insert", () => addCueAt(state.currentTimeMs)],
  ["本句：智能补全", "fanyi huyi buquan translate hy bq", "translate", "", () => translateCue(state.selectedIdx)],
  ["本句：拆成两句", "chaifen split cf", "split", "", () => splitCue(state.selectedIdx)],
  ["本句：与下一句合并", "hebing merge hb", "merge", "", () => mergeNext(state.selectedIdx)],
  ["本句：在下方插入一句", "charu insert cr", "plus", "", () => insertAfter(state.selectedIdx)],
  ["本句：切换顶部注释", "dingbu zhushi top note db", "pin", "", () => togglePos(state.selectedIdx)],
  ["本句：删除", "shanchu delete sc", "trash", "Delete", () => deleteCue(state.selectedIdx)],
  ["全部提前 0.5 秒", "pingyi tiqian shift earlier py", "undo", "", () => shiftAll(-500)],
  ["全部延后 0.5 秒", "pingyi yanhou shift later py", "redo", "", () => shiftAll(500)],
  ["查找替换", "chazhao tihuan find replace cz th", "replace", "Ctrl H", openFind],
  ["只看缺译的句子", "queyi missing shaixuan qy", "translate", "", () => filterTo("missing")],
  ["只看时间重叠的句子", "chongdie overlap shaixuan cd", "layers", "", () => filterTo("overlap")],
  ["显示全部句子", "quanbu all qb", "tidy", "", () => filterTo("")],
  ["智能精修", "zhineng jingxiu smart fix duanju sdh znjx", "spark", "", openSmartFix],
  ["美剧标点清洗", "biaodian qingxi punctuation bd", "punct", "", cleanPunctuation],
  ["中英纠偏分栏", "jiupian swap fenlan jp", "swap", "", fixSwappedColumns],
  ["按时间排序", "paixu sort px", "sort", "", sortByTime],
  ["清空字幕", "qingkong clear qk", "trash", "", clearAll],
  ["切换到台词", "taici script tc", "tidy", "", () => showTab("script")],
  ["切换到样式", "yangshi style ys", "bold", "", () => showTab("style")],
  ["预览双语", "shuangyu bilingual sy", "eye", "", () => setLangMode("bilingual")],
  ["只预览中文", "zhongwen chinese zw", "eye", "", () => setLangMode("zh_only")],
  ["只预览英文", "yingwen english yw", "eye", "", () => setLangMode("en_only")],
  ["时间轴显示全片", "suofang fit zoom sf", "fit", "", zoomFit],
  ["时间轴放大本句", "fangda zoom fd", "focus", "", zoomCue],
  ["专注画面", "zhuanzhu focus theatre zz", "expand", "T", toggleTheatre],
  ["切换浅色 / 深色", "zhuti theme dark light qiepan waiguan", "theme", "", () => toggleTheme()],
  ["氛围：雾蓝", "fenwei mood mist wulan blue", "theme", "", () => pickMood("mist")],
  ["氛围：海盐", "fenwei mood salt haiyan", "theme", "", () => pickMood("salt")],
  ["氛围：石楠", "fenwei mood heather shinan", "theme", "", () => pickMood("heather")],
  ["氛围：青苔", "fenwei mood moss qingtai", "theme", "", () => pickMood("moss")],
  ["撤销", "chexiao undo cx", "undo", "Ctrl Z", doUndo],
  ["重做", "chongzuo redo cz", "redo", "Ctrl Y", doRedo],
  ["全部快捷键", "kuaijiejian shortcuts keys help kjj", "keys", "F1", () => openModal("modalKeys")],
];

function filterTo(name) {
  showTab("script");
  if (name) setFilter(name);
  else clearFilters();
}

function pickMood(mood) {
  setMood(mood);
  emit("pref", { mood });
}

const input = byId("palInput");
const list = byId("palList");
let items = [];
let at = 0;

function jump(idx) {
  showTab("script");
  clearFilters();
  selectCue(idx, { seek: true });
}

function build(q) {
  const out = [];
  const query = q.trim();
  const low = query.toLowerCase();

  const lineNo = /^[#＃](\d+)$/.exec(query);
  if (lineNo) {
    const n = Number(lineNo[1]);
    if (n >= 1 && n <= state.subtitles.length) {
      const c = state.subtitles[n - 1];
      out.push({ group: "跳转", label: `第 ${n} 句`, note: trimmed(c.zh) || trimmed(c.en) || "空白", icon: "focus", run: () => jump(n - 1) });
    }
    return out;
  }
  if (/[:：.]/.test(query) || /^\d+$/.test(query)) {
    const ms = parseTime(query);
    if (ms !== null) out.push({ group: "跳转", label: `跳到 ${fmtTime(ms)}`, note: "", icon: "focus", run: () => seekTo(ms) });
    if (/^\d+$/.test(query) && Number(query) >= 1 && Number(query) <= state.subtitles.length) {
      const n = Number(query);
      out.push({ group: "跳转", label: `第 ${n} 句`, note: trimmed(state.subtitles[n - 1].zh), icon: "focus", run: () => jump(n - 1) });
    }
  }
  const hits = COMMANDS.filter(([label, keys]) => !low || label.toLowerCase().includes(low) || keys.split(" ").some((k) => k.startsWith(low)));
  for (const [label, , ic, keys, run] of low ? hits.slice(0, 9) : hits.slice(0, 11)) out.push({ group: "功能", label, keys, icon: ic, run });

  if (low) {
    for (const p of state.presets) {
      if (p.name.toLowerCase().includes(low)) out.push({ group: "模板", label: `套用「${p.name}」`, icon: "star", run: () => { applyStyle(p, p.id); state.dirty = true; } });
    }
  }
  if (low.length >= 1) {
    let n = 0;
    for (let i = 0; i < state.subtitles.length && n < 7; i++) {
      const c = state.subtitles[i];
      const zh = trimmed(c.zh);
      const en = trimmed(c.en);
      if (!zh.toLowerCase().includes(low) && !en.toLowerCase().includes(low)) continue;
      n++;
      out.push({ group: "台词", label: zh || en, note: `${c.id} · ${fmtTime(c.start_ms)}`, icon: "replace", run: () => jump(i) });
    }
  }
  return out;
}

function paint() {
  items = build(input.value);
  at = 0;
  const nodes = [];
  let group = "";
  items.forEach((it, i) => {
    if (it.group !== group) {
      group = it.group;
      nodes.push(h("div", { class: "pal-group" }, group));
    }
    nodes.push(
      h(
        "button",
        { class: "pal-item", type: "button", role: "option", tabindex: "-1", dataset: { i: String(i) } },
        icon(it.icon),
        h("span", {}, it.label),
        it.note ? h("em", { class: "num" }, it.note) : null,
        it.keys ? h("span", { class: "pal-keys" }, ...it.keys.split(" ").map((k) => h("kbd", {}, k))) : null,
      ),
    );
  });
  if (!items.length) nodes.push(h("div", { class: "pal-none" }, "没有找到。试试功能名、台词里的词，或 #句号"));
  list.replaceChildren(...nodes);
  list.scrollTop = 0;
  mark();
}

function mark() {
  for (const node of list.querySelectorAll(".pal-item")) {
    const on = Number(node.dataset.i) === at;
    node.classList.toggle("on", on);
    node.setAttribute("aria-selected", String(on));
    if (on) node.scrollIntoView({ block: "nearest" });
  }
}

let pending = null;
function choose(i) {
  const it = items[i];
  if (!it) return;
  pending = it.run; // run after the dialog has closed, so focus lands where the command wants it
  closeModal("modalPalette");
}

export function openPalette() {
  input.value = "";
  paint();
  openModal("modalPalette");
}

export function initPalette() {
  byId("btnPalette").addEventListener("click", openPalette);
  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      at = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(at);
    }
  });
  list.addEventListener("pointermove", (e) => {
    const node = e.target.closest(".pal-item");
    if (!node || Number(node.dataset.i) === at) return;
    at = Number(node.dataset.i);
    for (const n of list.querySelectorAll(".pal-item")) n.classList.toggle("on", n === node);
  });
  list.addEventListener("click", (e) => {
    const node = e.target.closest(".pal-item");
    if (node) choose(Number(node.dataset.i));
  });
  onModalClose("modalPalette", () => {
    const run = pending;
    pending = null;
    if (run) setTimeout(run, 30);
  });
}
