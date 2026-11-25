/* Long-running backend jobs (AI, SUP): polling plus every place that shows progress. */

import { $, byId, h } from "./util.js";
import { callQuiet } from "./bridge.js";
import { confirmBox, openModal, toast } from "./feedback.js";
import { historyMark, normalizeCues, replaceCues, sameCues, state } from "./store.js";
import { undoAction } from "./cues.js";

const POLL_MS = 360;
const VERBS = {
  AI: ["正在倾听", "正在断句", "正在对口型", "正在斟酌译法", "正在打磨语气", "正在对齐时间", "正在琢磨双关"],
  FIX: ["正在扫描", "正在拼合断句", "正在理顺时间", "正在清理音效", "正在补齐译文"],
  SUP: ["正在描边", "正在显影", "正在调色板取色", "正在压制", "正在对帧"],
};
let current = null; // { kind, modal, box, onDone }

export const taskRunning = () => current !== null;

/** Build the progress ring inside a host element once. */
function mountRing(host) {
  host.classList.add("ring");
  host.innerHTML =
    '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="rail" cx="50" cy="50" r="44"/><circle class="arc" cx="50" cy="50" r="44" pathLength="100"/></svg>';
  host.append(h("b", {}, ""));
}

/** Backend messages may start with an emoji; the interface speaks in words. */
const plain = (msg) => String(msg || "").replace(/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+/u, "");

let verbAt = -1e9;
let verb = "";
function nextVerb(label) {
  if (performance.now() - verbAt < 2600 && verb) return verb;
  verbAt = performance.now();
  const pool = (VERBS[label] || ["正在处理"]).filter((v) => v !== verb);
  verb = pool[Math.floor(Math.random() * pool.length)];
  return verb;
}

function paint(percent, message) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const pill = byId("taskPill");
  pill.hidden = false;
  document.documentElement.classList.add("working");
  $(".ring", pill).style.setProperty("--p", String(p));
  $("span", pill).textContent = nextVerb(current.label);
  $("b.num", pill).textContent = `${p}%`;
  const { box } = current;
  const dial = $(".ring", box);
  dial.style.setProperty("--p", String(p));
  $("b", dial).textContent = String(p);
  $("p", box).textContent = plain(message);
}

function finish(how, message) {
  const { box } = current;
  const dial = $(".ring", box);
  dial.classList.toggle("fail", how === "fail");
  $("b", dial).textContent = how === "done" ? "100" : "!";
  if (how === "done") dial.style.setProperty("--p", "100");
  $("p", box).textContent = plain(message);
  byId("taskPill").hidden = true;
  document.documentElement.classList.remove("working");
}

/**
 * Follow the running backend task until it ends.
 * job: { label, modal, box, onStart, onEnd, onDone(status) }
 */
export async function followTask(job) {
  current = job;
  $(".ring", job.box).classList.remove("fail");
  job.box.hidden = false;
  job.box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  job.onStart?.();
  paint(3, "正在启动…");

  try {
    let failures = 0;
    // One request at a time: the backend hands the result out exactly once.
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const st = await callQuiet("get_task_status");
      if (st.running === undefined) {
        failures++;
        if (failures < 8) continue;
        finish("fail", "与后端失去联系，请重启软件后再试");
        break;
      }
      failures = 0;
      if (st.running) {
        paint(st.percent || 3, st.message);
        continue;
      }
      if (st.error) {
        finish("fail", st.error);
        toast(st.error, { type: "error" });
      } else {
        finish("done", String(st.message || "完成").replace("（可按 Ctrl+Z 撤销）", ""));
        await job.onDone?.(st);
      }
      break;
    }
  } finally {
    current = null;
    job.onEnd?.();
  }
}

/* ---------- results ----------
   A finished job never interrupts typing and is never thrown away: if the list or the
   film changed while it ran, the result waits in the header until someone decides. */
let pending = null;

/** Taken when a job starts; tells later whether the list is still the one it was given. */
export const jobMark = () => ({ history: historyMark(), media: state.mediaId, cues: state.subtitles });

function applyNow({ subs, label, message, select }) {
  const next = normalizeCues(subs);
  if (sameCues(next, state.subtitles)) {
    toast(message); // nothing to change: no undo step
    return;
  }
  replaceCues(subs, label, { select });
  toast(message, { type: "success", action: undoAction(), ms: 7000 });
}

export function applyTaskResult(job) {
  const { mark } = job;
  if (historyMark() === mark.history && state.mediaId === mark.media && state.subtitles === mark.cues) {
    applyNow(job);
    return true;
  }
  pending = job;
  byId("resultPill").hidden = false;
  const why = state.mediaId !== mark.media ? "期间换了影片" : "期间字幕有改动";
  toast(`处理完成，但${why}。点右上角「结果待应用」决定要不要替换`, { ms: 9000 });
  return false;
}

async function decide() {
  const job = pending;
  if (!job) return;
  const yes = await confirmBox({
    title: "用处理结果替换当前字幕？",
    body: `${job.message}。替换会覆盖任务开始后的改动，可以按 Ctrl+Z 撤销。`,
    okLabel: "替换",
  });
  if (!yes || pending !== job) return;
  dropPending();
  applyNow(job);
}
function dropPending() {
  pending = null;
  byId("resultPill").hidden = true;
}

export function initTasks() {
  const pill = byId("taskPill");
  mountRing($(".ring", pill));
  $(".ring", pill).classList.add("mini");
  pill.addEventListener("click", () => current && openModal(current.modal));
  for (const id of ["aiDial", "supDial", "fixDial", "stageDial"]) mountRing(byId(id));
  byId("stageDial").classList.add("spin");
  byId("btnResult").addEventListener("click", decide);
  byId("btnResultDrop").addEventListener("click", () => {
    dropPending();
    toast("已丢弃这次处理结果");
  });
}

