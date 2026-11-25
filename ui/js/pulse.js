/**
 * One loudness signal, read from the waveform at the playhead, drives everything
 * that should feel alive while sound is playing: the orb on the play button, the
 * bars beside the line being spoken, the backdrop, and the two lines of the logo.
 */

import { $, byId, clamp } from "./util.js";
import { addTicker, cueAt, emit, on, requestFrame, state, trimmed } from "./store.js";
import { isPlaying } from "./player.js";
import { setBreath } from "./scenes.js";

const halo = byId("playHalo");
const lineA = $(".mark-a");
const lineB = $(".mark-b");

let amp = 0;
let last = 0;
let markKey = "";

function loudness() {
  const { peaks, peaks_per_sec: rate } = state.waveform || {};
  if (!peaks?.length) return 0.25;
  const f = (state.currentTimeMs / 1000) * (rate || 25);
  const i = Math.floor(f);
  const a = peaks[i] ?? 0;
  const b = peaks[i + 1] ?? a;
  return clamp((a + (b - a) * (f - i)) / 100, 0, 1);
}

function tick(now) {
  const dt = clamp(now - last, 0, 64);
  last = now;
  const target = isPlaying() ? loudness() : 0;
  // Fast attack, slow release: the way a voice meter should feel.
  const tau = target > amp ? 55 : 190;
  amp += (target - amp) * (1 - Math.exp(-dt / tau));
  if (amp < 0.003 && target === 0) amp = 0;
  halo.style.transform = `scale(${(1 + amp * 0.42).toFixed(3)})`;
  setBreath(amp);
  emit("pulse", amp);
  return amp > 0 || isPlaying();
}

/** The logo is a subtitle: its two lines take the length of the current cue. */
function paintMark() {
  let a = 1;
  let b = 1;
  if (isPlaying()) {
    const cue = state.subtitles[cueAt(state.currentTimeMs)];
    const size = (text, full) => (text ? clamp(0.34 + (text.length / full) * 0.66, 0.34, 1) : 0.16);
    a = cue ? size(trimmed(cue.zh), 20) : 0.16;
    b = cue ? size(trimmed(cue.en), 52) : 0.26;
  }
  const key = `${a.toFixed(2)}|${b.toFixed(2)}`;
  if (key === markKey) return;
  markKey = key;
  lineA.style.transform = `scaleX(${a})`;
  lineB.style.transform = `scaleX(${b})`;
}

export function initPulse() {
  addTicker(tick);
  on("play", () => {
    paintMark();
    requestFrame();
  });
  on("time", paintMark);
}
