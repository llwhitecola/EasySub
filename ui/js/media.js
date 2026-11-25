/* Opening video / audio, drag & drop, the media chip in the header. */

import { byId, fmtTime } from "./util.js";
import { clearDemo, emit, invalidate, normalizeCues, on, replaceCues, state, syncDuration } from "./store.js";
import { toast, withBusy } from "./feedback.js";
import { call } from "./bridge.js";
import { attachMedia, isPlaying, seekTo } from "./player.js";
import { setWaveform } from "./timeline.js";
import { stageBusy, syncBackdrop } from "./stage.js";
import { applyStyle } from "./styles.js";
import { undoAction } from "./cues.js";

const SUB_EXT = /\.(srt|ass|ssa|vtt|txt|json)$/i;
let loadToken = 0;
let lastAccepted = 0;
let inflight = 0;
let unplayable = false;

/* ---------- header chip ---------- */
function paintChip() {
  const chip = byId("mediaChip");
  chip.classList.toggle("loaded", state.mediaLoaded);
  byId("mediaName").textContent = state.mediaLoaded ? state.videoName : "未载入影片";
  const meta = [];
  if (state.mediaLoaded) {
    const v = byId("video");
    if (unplayable) meta.push("时间轴模式");
    else if (v.videoWidth) meta.push(`${v.videoWidth}×${v.videoHeight}`);
    else if (document.documentElement.classList.contains("audio-only")) meta.push("音频");
    if (state.mediaDurationMs) meta.push(fmtTime(state.mediaDurationMs).split(".")[0]);
  } else meta.push("演示画面");
  byId("mediaMeta").textContent = meta.join(" · ");
}

/* ---------- open ---------- */
export async function openVideoDialog(btn) {
  return withBusy(btn, async () => {
    const picked = await call("choose_video_file");
    if (picked.ok && picked.path) await loadVideo(picked.path);
    else if (picked.error) toast(picked.error, { type: "error" });
  });
}

/** keepCues: restoring a draft must never be overwritten by a same-name subtitle file. */
export async function loadVideo(path, { keepCues = false } = {}) {
  const request = ++loadToken;
  inflight++;
  stageBusy("正在准备预览…");
  const res = await call("load_video_by_path", path);
  if (!--inflight) stageBusy("");
  // The backend decides which of several overlapping requests wins; follow it.
  if (res.superseded || request < lastAccepted) return false;
  if (!res.ok) {
    if (res.error) toast(res.error, { type: "error" });
    return false; // whatever was open before stays open, waveform included
  }
  lastAccepted = request;

  const media = ++state.mediaId;
  unplayable = false;
  state.mediaLoaded = true;
  state.videoName = res.video_name;
  state.videoStem = res.video_stem || "双语字幕";
  state.mediaDurationMs = Math.max(0, res.duration_ms || 0);
  attachMedia(res.media_url);
  if (!keepCues) clearDemo();
  syncDuration();
  setWaveform({ peaks: [], peaks_per_sec: 25, duration_ms: 0 });
  state.waveformLoading = true;
  syncBackdrop();
  emit("media-changed");
  emit("time", { seek: true });
  paintChip();
  loadWaveform(media); // in the background: nothing else waits for it

  if (!keepCues) {
    if (res.matching_subtitle_path) {
      const sub = await call("load_subtitle_by_path", res.matching_subtitle_path, "replace", "auto", "time", []);
      if (media !== state.mediaId) return false;
      if (sub.ok && sub.subtitles?.length) {
        replaceCues(sub.subtitles, "载入同名字幕");
        toast(`已载入影片和同名字幕 ${sub.file_name}（${sub.count} 句）`, { type: "success", action: undoAction() });
        return true;
      }
    }
    toast(`已载入 ${res.video_name}`, { type: "success" });
  }
  return true;
}

async function loadWaveform(media) {
  const wf = await call("get_video_waveform");
  if (media !== state.mediaId) return;
  state.waveformLoading = false;
  if (wf.ok && wf.peaks?.length) {
    setWaveform(wf);
    if (wf.duration_ms > state.mediaDurationMs) {
      state.mediaDurationMs = wf.duration_ms;
      syncDuration();
      emit("media-ready");
    }
  } else {
    invalidate("strip");
    toast("没有提取到声轨波形（可能没有音频，或未安装 FFmpeg），仍可照常打轴");
  }
}

/** Replace the list with a subtitle / project file. */
export async function loadSubtitleFile(path) {
  const res = await call("load_subtitle_by_path", path, "replace", "auto", "time", []);
  return applyLoadedSubtitles(res);
}

export function applyLoadedSubtitles(res) {
  if (!res.ok) {
    if (res.error) toast(res.error, { type: "error" });
    return false;
  }
  if (!normalizeCues(res.subtitles).length) {
    toast(`${res.file_name || "这个文件"} 里没有识别到字幕`, { type: "error" });
    return false;
  }
  replaceCues(res.subtitles, "导入字幕");
  if (res.style) applyStyle(res.style);
  if (!isPlaying()) seekTo(state.subtitles[0].start_ms + 20);
  toast(`已导入 ${res.file_name}（${res.count} 句）${res.style ? "，并恢复了工程样式" : ""}`, { type: "success", action: undoAction() });
  return true;
}

/* ---------- drag & drop ----------
   The browser side only draws the curtain; real paths arrive from Python. */
let dropQueue = Promise.resolve();
window.onNativeFileDropped = (kind, fullPath) => {
  hideCurtain();
  dropQueue = dropQueue
    .then(() => (kind === "subtitle" || SUB_EXT.test(fullPath) ? loadSubtitleFile(fullPath) : loadVideo(fullPath)))
    .catch((err) => console.error("[drop]", err));
  return true;
};

let depth = 0;
function hideCurtain() {
  depth = 0;
  byId("dropCurtain").classList.remove("on");
}
function bindDrop() {
  const curtain = byId("dropCurtain");
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    const item = Array.from(e.dataTransfer.items || []).find((it) => it.kind === "file");
    const type = item?.type || "";
    const [title, note] = /^video\//.test(type)
      ? ["松手，打开这部影片", "会自动提取声波，同名字幕也会一起载入"]
      : /^audio\//.test(type)
        ? ["松手，打开这段声音", "会自动提取声波，可以直接听写"]
        : /text|json|subrip/.test(type)
          ? ["松手，导入这份字幕", "会替换当前列表，可以撤销"]
          : ["松手载入", "视频、音频或字幕文件"];
    byId("dropTitle").textContent = title;
    byId("dropNote").textContent = note;
    curtain.classList.add("on");
  }, true);
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) hideCurtain();
  }, true);
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, true);
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideCurtain();
  }, true);
}

export function initMedia() {
  byId("btnOpenVideo").addEventListener("click", (e) => openVideoDialog(e.currentTarget));
  byId("mediaChip").addEventListener("click", () => openVideoDialog(byId("btnOpenVideo")));
  byId("stageHero").addEventListener("click", () => openVideoDialog(byId("btnOpenVideo")));
  bindDrop();
  on("media-ready", paintChip);
  on("media-unplayable", () => {
    unplayable = true;
    paintChip();
  });
  paintChip();
}

