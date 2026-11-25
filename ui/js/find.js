/* Find & replace bar: sits above the script so matches stay visible while you work. */

import { byId } from "./util.js";
import { emit, invalidate, on, pushHistory, registerDraw, state } from "./store.js";
import { toast } from "./feedback.js";
import { bindSeg } from "./controls.js";
import { selectCue, undoAction } from "./cues.js";
import { clearFilters } from "./script.js";

let scope = "both";
let matches = []; // cue indexes

const bar = byId("findBar");
const inpFind = byId("inpFind");
const inpReplace = byId("inpReplace");

function pattern() {
  const q = inpFind.value;
  if (!q) return null;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, byId("btnCase").getAttribute("aria-pressed") === "true" ? "g" : "gi");
}
const fields = () => (scope === "both" ? ["zh", "en"] : [scope]);

function recount() {
  const re = pattern();
  const label = byId("findCount");
  matches = [];
  let total = 0;
  if (re) {
    state.subtitles.forEach((c, i) => {
      let n = 0;
      for (const f of fields()) n += (String(c[f] || "").match(re) || []).length;
      if (n) {
        matches.push(i);
        total += n;
      }
    });
  }
  label.textContent = !re ? "" : total ? `${total} 处，${matches.length} 句` : "没有匹配";
  label.classList.toggle("none", Boolean(re) && !total);
  byId("btnReplaceAll").disabled = !total;
  byId("btnFindNext").disabled = byId("btnFindPrev").disabled = !matches.length;
}

function step(dir) {
  recount();
  if (!matches.length) return;
  const from = state.selectedIdx;
  let next;
  if (dir > 0) next = matches.find((i) => i > from) ?? matches[0];
  else next = matches.findLast((i) => i < from) ?? matches.at(-1);
  clearFilters();
  selectCue(next, { seek: true });
}

function replaceAll() {
  const re = pattern();
  if (!re) return toast("先输入要查找的内容");
  recount();
  if (!matches.length) return toast("没有可替换的内容");
  const to = inpReplace.value;
  let n = 0;
  pushHistory("批量替换");
  for (const i of matches) {
    const c = state.subtitles[i];
    for (const f of fields()) {
      c[f] = String(c[f] || "").replace(re, () => {
        n++;
        return to; // a function, so "$&" typed by the user stays literal
      });
    }
  }
  emit("cues", {});
  toast(`已替换 ${n} 处`, { type: "success", action: undoAction() });
}

export function openFind() {
  emit("show-tab", "script");
  bar.hidden = false;
  requestAnimationFrame(() => bar.classList.add("open"));
  setTimeout(() => bar.classList.add("open"), 60);
  byId("btnFind").setAttribute("aria-pressed", "true");
  inpFind.focus();
  inpFind.select();
  recount();
}
export function closeFind() {
  bar.classList.remove("open");
  byId("btnFind").setAttribute("aria-pressed", "false");
  setTimeout(() => {
    if (!bar.classList.contains("open")) bar.hidden = true;
  }, 200);
}
export const toggleFind = () => (bar.classList.contains("open") ? closeFind() : openFind());

export function initFind() {
  registerDraw("find", () => !bar.hidden && recount());
  const seg = bindSeg(byId("findScope"), (v) => {
    scope = v;
    recount();
  });
  seg.set("both", { animate: false });
  byId("btnFind").addEventListener("click", toggleFind);
  byId("btnFindClose").addEventListener("click", closeFind);
  byId("btnFindNext").addEventListener("click", () => step(1));
  byId("btnFindPrev").addEventListener("click", () => step(-1));
  byId("btnReplaceAll").addEventListener("click", replaceAll);
  byId("btnCase").addEventListener("click", (e) => {
    const b = e.currentTarget;
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    recount();
  });
  inpFind.addEventListener("input", recount);
  bar.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      closeFind();
    } else if (e.key === "Enter" && e.target === inpFind) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" && e.target === inpReplace) {
      e.preventDefault();
      replaceAll();
    }
  });
  on("cues", () => invalidate("find"));
  on("cue", ({ what }) => what === "text" && invalidate("find"));
}

