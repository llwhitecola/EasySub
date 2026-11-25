/* Playback engine: one clock for real video and for the built-in demo. */

import { $, byId, clamp, fmtTime } from "./util.js";
import { addTicker, cueAt, emit, invalidate, on, registerDraw, requestFrame, state, syncDuration, trimmed } from "./store.js";
import { toast } from "./feedback.js";
import { paintRange } from "./controls.js";

const video = byId("video");
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

let pendingSeekMs = null;
let lastManualSeekAt = -1e9;
let demoPlaying = false;
let demoLast = 0;
let rate = 1;
let loopCue = false;

export const isPlaying = () => (state.hasRealVideo ? !video.paused : demoPlaying);

/* ---------- seeking ---------- */
export function seekTo(ms, { reveal = true } = {}) {
  syncDuration();
  const t = clamp(Math.round(ms), 0, state.durationMs || 36000000);
  state.currentTimeMs = t;
  lastManualSeekAt = performance.now();
  if (state.hasRealVideo) {
    if (video.readyState >= 1) {
      pendingSeekMs = null;
      try {
        video.currentTime = t / 1000;
      } catch { /* not seekable yet */ }
    } else {
      pendingSeekMs = t;
    }
  }
  emit("time", { seek: true, reveal });
}
export const nudge = (deltaMs) => seekTo(state.currentTimeMs + deltaMs);

/* ---------- transport ---------- */
export function play() {
  if (state.hasRealVideo) {
    if (state.currentTimeMs >= state.durationMs - 100) seekTo(0);
    const mediaEnd = Number.isFinite(video.duration) ? video.duration * 1000 : Infinity;
    if (state.currentTimeMs > mediaEnd + 60) {
      toast("这里已经超过影片结尾，没有画面可以播放", { key: "past-end" });
      return;
    }
    if (pendingSeekMs === null && video.readyState >= 1) {
      const target = state.currentTimeMs / 1000;
      if (Math.abs(video.currentTime - target) > 0.25 && target <= (video.duration || Infinity)) {
        try {
          video.currentTime = target;
        } catch { /* not seekable yet */ }
      }
    }
    video.play()?.catch?.(() => {});
  } else {
    syncDuration();
    if (state.currentTimeMs >= state.durationMs - 100) state.currentTimeMs = 0;
    demoPlaying = true;
    demoLast = performance.now();
    emit("play", true);
  }
  requestFrame();
}
export function pause() {
  if (state.hasRealVideo) video.pause();
  else if (demoPlaying) {
    demoPlaying = false;
    emit("play", false);
  }
}
export const togglePlay = () => (isPlaying() ? pause() : play());

export function replayCue() {
  const cue = state.subtitles[state.selectedIdx];
  if (!cue) return;
  seekTo(cue.start_ms);
  play();
}

/** Jump to the previous / next cue start relative to the playhead. */
export function jumpCue(dir) {
  const starts = state.subtitles.map((c, i) => ({ t: c.start_ms, i })).sort((a, b) => a.t - b.t);
  if (!starts.length) return;
  const now = state.currentTimeMs;
  const hit = dir > 0 ? starts.find((s) => s.t > now + 40) : starts.findLast((s) => s.t < now - 260);
  if (!hit) return;
  emit("request-select", { idx: hit.i });
  seekTo(hit.t + 20);
}

export function setLoop(onOff) {
  loopCue = onOff;
  byId("btnLoop").setAttribute("aria-pressed", String(onOff));
}

function checkLoop() {
  if (!loopCue) return;
  const cue = state.subtitles[state.selectedIdx];
  if (cue && state.currentTimeMs > cue.end_ms) seekTo(cue.start_ms);
}

/* ---------- clock ---------- */
function tick(now) {
  if (state.hasRealVideo) {
    if (video.paused) return false;
    if (video.seeking || pendingSeekMs !== null) return true;
    const ms = Math.round(video.currentTime * 1000);
    const since = now - lastManualSeekAt;
    if (since > 220 || Math.abs(ms - state.currentTimeMs) < 1200) {
      state.currentTimeMs = ms;
      checkLoop();
      emit("time", { tick: true });
    }
    return true;
  }
  if (!demoPlaying) return false;
  state.currentTimeMs += clamp(now - demoLast, 0, 120) * rate;
  demoLast = now;
  checkLoop();
  if (state.currentTimeMs >= state.durationMs) {
    state.currentTimeMs = state.durationMs;
    demoPlaying = false;
    emit("play", false);
  }
  emit("time", { tick: true });
  return demoPlaying;
}

/* ---------- media element ---------- */
export function attachMedia(url) {
  demoPlaying = false;
  pendingSeekMs = null;
  state.hasRealVideo = true;
  state.currentTimeMs = 0;
  video.src = url;
  video.load();
  emit("play", false);
}

function bindMedia() {
  video.addEventListener("play", () => {
    emit("play", true);
    requestFrame();
  });
  video.addEventListener("pause", () => emit("play", false));
  video.addEventListener("ended", () => {
    emit("play", false);
    // Looping a line that reaches the end of the film
    const cue = state.subtitles[state.selectedIdx];
    if (loopCue && cue && cue.start_ms < video.duration * 1000 - 100) {
      seekTo(cue.start_ms);
      play();
    }
  });
  video.addEventListener("loadedmetadata", () => {
    video.playbackRate = rate; // loading a new source resets it
    if (Number.isFinite(video.duration) && video.duration > 0) {
      state.mediaDurationMs = Math.round(video.duration * 1000);
      syncDuration();
    }
    if (pendingSeekMs !== null) {
      const t = pendingSeekMs / 1000;
      pendingSeekMs = null;
      try {
        video.currentTime = t;
      } catch { /* not seekable */ }
    }
    // Audio-only files play fine but have no picture: keep the scene visible.
    document.documentElement.classList.toggle("audio-only", video.videoWidth === 0);
    emit("media-ready");
    emit("time", { seek: true });
  });
  video.addEventListener("error", () => {
    if (!state.hasRealVideo || !video.getAttribute("src")) return;
    state.hasRealVideo = false;
    pendingSeekMs = null;
    emit("play", false);
    emit("media-unplayable");
    toast("这个视频的编码无法在预览窗播放，已切到时间轴模式：打轴、AI 听写和导出都不受影响", { ms: 7000 });
  });
}

/* ---------- transport UI ---------- */
function paintTime() {
  byId("tcNow").textContent = fmtTime(state.currentTimeMs);
  byId("tcDur").textContent = fmtTime(state.durationMs);
  const p = state.durationMs > 0 ? clamp(state.currentTimeMs / state.durationMs, 0, 1) : 0;
  byId("scrub").style.setProperty("--p", p.toFixed(5));
}

function paintPlayState() {
  const playing = isPlaying();
  const btn = byId("btnPlay");
  btn.classList.toggle("playing", playing);
  btn.setAttribute("aria-label", playing ? "暂停" : "播放");
  btn.dataset.tip = playing ? "暂停" : "播放";
  document.documentElement.classList.toggle("is-playing", playing);
}

function bindScrub() {
  const bar = byId("scrub");
  const hover = $(".scrub-hover", bar);
  let dragging = false;
  const at = (e) => {
    const r = bar.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * state.durationMs;
  };
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("drag");
    seekTo(at(e));
  });
  bar.addEventListener("pointermove", (e) => {
    if (dragging && !(e.buttons & 1)) end();
    const t = at(e);
    const r = bar.getBoundingClientRect();
    const i = cueAt(t);
    const cue = state.subtitles[i];
    hover.replaceChildren(fmtTime(t));
    if (cue) {
      const line = document.createElement("em");
      line.textContent = trimmed(cue.zh) || trimmed(cue.en);
      if (line.textContent) hover.append(line);
    }
    const half = hover.offsetWidth / 2;
    hover.style.left = `${clamp(e.clientX - r.left, half, r.width - half)}px`;
    if (dragging) seekTo(t);
  });
  const end = () => {
    dragging = false;
    bar.classList.remove("drag");
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("lostpointercapture", end);
}

/** Cue map: the bar is darker wherever there is a line to read. */
function paintCueMap() {
  const canvas = byId("cueMap");
  const w = canvas.clientWidth;
  if (!w) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = getComputedStyle(canvas).color;
  const total = Math.max(1, state.durationMs);
  for (const c of state.subtitles) {
    const x = (c.start_ms / total) * canvas.width;
    ctx.fillRect(x, 0, Math.max(dpr, ((c.end_ms - c.start_ms) / total) * canvas.width - dpr), 1);
  }
}

/* ---------- volume ---------- */
export function setVolume(v, muted = video.muted) {
  video.volume = clamp(v, 0, 1);
  video.muted = muted;
  const slider = byId("rngVolume");
  slider.value = String(Math.round((muted ? 0 : video.volume) * 100));
  paintRange(slider);
  byId("btnMute").classList.toggle("muted", muted || video.volume === 0);
}

export function initPlayer() {
  bindMedia();
  bindScrub();
  addTicker(tick);

  byId("btnPlay").addEventListener("click", togglePlay);
  byId("btnBack").addEventListener("click", () => nudge(-2000));
  byId("btnFwd").addEventListener("click", () => nudge(2000));
  byId("btnPrevCue").addEventListener("click", () => jumpCue(-1));
  byId("btnNextCue").addEventListener("click", () => jumpCue(1));
  byId("btnReplay").addEventListener("click", replayCue);
  byId("btnLoop").addEventListener("click", () => setLoop(!loopCue));

  const btnRate = byId("btnRate");
  const setRate = (r) => {
    rate = r;
    video.playbackRate = r;
    btnRate.textContent = `${r}×`;
    btnRate.classList.toggle("off-default", r !== 1);
  };
  btnRate.addEventListener("click", (e) => {
    const at = RATES.indexOf(rate);
    setRate(RATES[(at + (e.shiftKey ? RATES.length - 1 : 1)) % RATES.length]);
  });
  btnRate.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    setRate(1);
  });

  byId("rngVolume").addEventListener("input", (e) => {
    const v = Number(e.target.value) / 100;
    setVolume(v, v === 0);
    emit("pref", { volume: v });
  });
  byId("btnMute").addEventListener("click", () => {
    const unmute = video.muted || video.volume === 0;
    setVolume(unmute && video.volume === 0 ? 0.8 : video.volume, !unmute);
  });

  registerDraw("cuemap", paintCueMap);
  on("cues", () => invalidate("cuemap"));
  on("cue", ({ what }) => what === "time" && invalidate("cuemap"));
  on("media-ready", () => invalidate("cuemap"));
  on("theme", () => invalidate("cuemap"));
  on("palette", () => invalidate("cuemap"));
  on("dpr", () => invalidate("cuemap"));
  new ResizeObserver(() => invalidate("cuemap")).observe(byId("scrub"));

  registerDraw("time", paintTime);
  on("time", () => invalidate("time"));
  on("cues", () => invalidate("time"));
  on("cue", () => invalidate("time"));
  on("media-ready", () => invalidate("time"));
  on("play", paintPlayState);
  invalidate("time");
}
