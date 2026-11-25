/* Box-select a target, run local tracking, and correct a label on a paused frame. */

import { byId, clamp, fmtTime } from "./util.js";
import { call, callQuiet } from "./bridge.js";
import { closeModal, onModalClose, openModal, toast, withBusy } from "./feedback.js";
import { emit, on, ownCues, pushHistory, replaceCues, state } from "./store.js";
import { pause, seekTo } from "./player.js";
import { undoAction } from "./cues.js";
import { isMotion, motionAt, pictureRect } from "./motion-path.js";

const video = byId("video");
const surface = byId("motionSurface");
const outline = byId("motionOutline");
const picker = byId("motionPicker");
const adjustButton = byId("btnMotionAdjust");
const modal = "modalMotion";
let selection = null;
let draft = null;
let running = null;

function activeAnnotation(ms) {
  const cue = state.subtitles[state.selectedIdx];
  return isMotion(cue) && ms >= cue.start_ms && ms < cue.end_ms && motionAt(cue.motion, ms) ? cue : null;
}

function endSelection() {
  selection = null;
  surface.hidden = outline.hidden = picker.hidden = true;
}

function beginSelection(adjust) {
  if (running) return toast("正在结束上一次追踪，请稍候");
  if (!state.hasRealVideo || !video.videoWidth || video.readyState < 2 || video.seeking) {
    return toast("请加载视频并等当前画面显示后再框选");
  }
  pause();
  const ms = Math.round(video.currentTime * 1000);
  const cue = adjust ? activeAnnotation(ms) : null;
  if (adjust && !cue) return;
  selection = { ms, cue, media: state.mediaId };
  byId("motionPickerText").textContent = adjust ? "点击新的标注位置（文字底部居中）" : "拖动鼠标框选路牌或其他目标";
  surface.hidden = picker.hidden = false;
  byId("btnMotionPickCancel").focus({ preventScroll: true });
}

function pointerInPicture(event, clampToPicture = false) {
  const rect = surface.getBoundingClientRect();
  const picture = pictureRect(video, rect.width, rect.height);
  if (!picture) return null;
  const x = (event.clientX - rect.left - picture.x) / picture.w;
  const y = (event.clientY - rect.top - picture.y) / picture.h;
  if (!clampToPicture && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), picture };
}

function boxBetween(a, b) {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
}

function paintBox(a, b) {
  const [x, y, w, h] = boxBetween(a, b);
  const { picture: p } = b;
  outline.style.left = `${p.x + x * p.w}px`;
  outline.style.top = `${p.y + y * p.h}px`;
  outline.style.width = `${w * p.w}px`;
  outline.style.height = `${h * p.h}px`;
}

function correctPoint(cue, ms, x, y) {
  const idx = state.subtitles.indexOf(cue);
  if (idx < 0) return;
  // Blend a correction into the nearby automatic path instead of jumping for a frame.
  const path = cue.motion;
  const from = Math.max(path[0][0], ms - 250);
  const to = Math.min(path.at(-1)[0], ms + 250);
  const points = path.filter(([t]) => t < from || t > to);
  for (const t of [from, to]) if (t !== ms) points.push([t, ...motionAt(path, t)]);
  points.push([ms, x, y]);
  pushHistory("校正跟随标注");
  cue.motion = points.sort((a, b) => a[0] - b[0]);
  emit("cue", { idx, what: "motion" });
  toast("已校正标注位置", { type: "success", action: undoAction() });
}

function configure(job, box) {
  const available = Math.floor((video.duration * 1000 - job.ms) / 50) / 20;
  if (!Number.isFinite(available) || available < 0.1) return toast("这个位置太靠近视频结尾");
  draft = { ...job, box, mediaId: new URL(video.src).searchParams.get("id"), size: [video.videoWidth, video.videoHeight] };
  byId("motionText").value = "";
  byId("motionStart").textContent = fmtTime(job.ms);
  const duration = byId("motionDuration");
  duration.max = String(available);
  duration.value = String(Math.min(3, available));
  byId("motionStatus").textContent = "";
  openModal(modal);
}

async function runTracking(event) {
  event.preventDefault();
  const job = draft;
  if (running || !job) return;
  const text = byId("motionText").value.trim();
  const status = byId("motionStatus");
  if (!text) {
    byId("motionText").focus();
    status.textContent = "请输入标注文字";
    return;
  }
  const end = job.ms + Math.round(Number(byId("motionDuration").value) * 1000);
  running = job;
  status.textContent = "正在分析画面…";
  const result = await withBusy(byId("btnMotionRun"), () => call("track_visual_annotation", {
    media_id: job.mediaId, start_ms: job.ms, end_ms: end, box: job.box, video_size: job.size,
  }));
  running = null;
  if (draft !== job || state.mediaId !== job.media) return;
  if (!result?.ok) {
    status.textContent = result?.error || "追踪已取消";
    return;
  }
  const subtitles = [...ownCues()];
  const at = subtitles.findIndex((cue) => cue.start_ms > job.ms);
  const idx = at < 0 ? subtitles.length : at;
  subtitles.splice(idx, 0, {
    start_ms: job.ms, end_ms: result.end_ms, zh: text, en: "", pos: "top", motion: result.motion,
  });
  replaceCues(subtitles, "添加跟随标注", { select: idx });
  seekTo(job.ms);
  closeModal(modal);
  const message = result.end_ms < end ? "已添加标注，追踪在目标丢失处结束" : "已添加跟随标注";
  toast(message, { type: "success", action: undoAction() });
}

export function initMotion() {
  byId("btnMotion").addEventListener("click", () => beginSelection(false));
  adjustButton.addEventListener("click", () => beginSelection(true));
  byId("btnMotionPickCancel").addEventListener("click", endSelection);
  byId("motionForm").addEventListener("submit", runTracking);
  onModalClose(modal, () => {
    if (draft && running === draft) void callQuiet("cancel_visual_annotation");
    draft = null;
  });

  surface.addEventListener("pointerdown", (event) => {
    if (!selection || event.button !== 0 || selection.pointer !== undefined) return;
    const start = pointerInPicture(event);
    if (!start) return;
    selection.pointer = event.pointerId;
    selection.start = start;
    surface.setPointerCapture(event.pointerId);
    if (!selection.cue) {
      outline.hidden = false;
      paintBox(start, start);
    }
  });
  surface.addEventListener("pointermove", (event) => {
    if (selection?.pointer !== event.pointerId || selection.cue) return;
    const point = pointerInPicture(event, true);
    if (point) paintBox(selection.start, point);
  });
  surface.addEventListener("pointerup", (event) => {
    if (selection?.pointer !== event.pointerId) return;
    const job = selection;
    const point = pointerInPicture(event, true);
    if (!point) return endSelection();
    if (job.cue) {
      endSelection();
      correctPoint(job.cue, job.ms, point.x, point.y);
      return;
    }
    const box = boxBetween(job.start, point);
    if (box[2] * point.picture.w < 7 || box[3] * point.picture.h < 7) {
      delete job.pointer;
      outline.hidden = true;
      toast("请框住目标的文字和边缘");
      return;
    }
    endSelection();
    configure(job, box);
  });
  surface.addEventListener("pointercancel", endSelection);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !selection) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    endSelection();
  }, true);

  const syncButtons = () => {
    byId("btnMotion").hidden = !state.hasRealVideo || !video.videoWidth;
    adjustButton.hidden = byId("btnMotion").hidden || !activeAnnotation(state.currentTimeMs);
  };
  on("time", (info) => {
    if (info?.seek && selection) endSelection();
    syncButtons();
  });
  on("select", syncButtons);
  on("cues", syncButtons);
  on("media-ready", syncButtons);
  on("media-unplayable", syncButtons);
  on("play", (playing) => { if (playing && selection) endSelection(); });
  on("media-changed", () => {
    endSelection();
    if (draft) closeModal(modal);
    syncButtons();
  });
}
