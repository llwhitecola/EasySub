/**
 * EasySub Studio (傻瓜双语字幕工坊) - Frontend Controller
 */

const DEMO_SUBTITLES = [
  {
    id: 1,
    start_ms: 600,
    end_ms: 3800,
    zh: "以前做双语字幕总要记一堆复杂代码",
    en: "Making bilingual subtitles used to require memorizing complex tags",
  },
  {
    id: 2,
    start_ms: 4200,
    end_ms: 7800,
    zh: "现在点一下右侧卡片，就能切换电影级双语样式",
    en: "Now with one click on the right, you get cinema-grade bilingual styles",
  },
  {
    id: 3,
    start_ms: 8200,
    end_ms: 11800,
    zh: "播放时按 F3 设开始、按 F4 设结束并自动跳下一句",
    en: "Press F3 for start and F4 for end while playing to time lines effortlessly",
  },
  {
    id: 4,
    start_ms: 12200,
    end_ms: 16500,
    zh: "或者拖入视频点击上方 AI 按钮，全自动听写加翻译！",
    en: "Or drop a video in and click AI above for automatic transcription and translation!",
  },
];

function createDemoWaveform(durationSec = 18, pps = 25) {
  const total = durationSec * pps;
  const peaks = new Array(total).fill(4);
  for (const cue of DEMO_SUBTITLES) {
    const sIdx = Math.floor((cue.start_ms / 1000) * pps);
    const eIdx = Math.min(total - 1, Math.floor((cue.end_ms / 1000) * pps));
    for (let i = sIdx; i <= eIdx; i++) {
      const wave = Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.19));
      peaks[i] = Math.min(96, Math.round(18 + wave * 76));
    }
  }
  return { peaks_per_sec: pps, duration_ms: durationSec * 1000, peaks };
}

const state = {
  hasRealVideo: false,
  videoName: "",
  videoStem: "双语字幕",
  durationMs: 18000,
  currentTimeMs: 1200,
  demoPlaying: false,
  demoLastTick: 0,

  subtitles: structuredClone(DEMO_SUBTITLES),
  selectedIdx: 0,
  searchQuery: "",

  presets: [],
  activePresetId: "us_drama_default",
  langMode: "bilingual", // 'bilingual' | 'zh_only' | 'en_only'
  style: {
    order: "zh_top",
    margin_v: 15,
    line_gap: 9,
    blur: 2.0,
    ycbcr_matrix: "None",
    box_mode: false,
    box_color: "#0F172A",
    box_opacity: 0.72,
    zh: {
      style_name: "默认文泉",
      font: "WenQuanYi Micro Hei",
      size: 70,
      color: "#B7B7B7",
      secondary_color: "#000000",
      outline_color: "#000000",
      back_color: "#000000",
      back_opacity: 1.0,
      outline: 0.8,
      shadow: 0.7,
      scale_x: 93,
      margin_l: 10,
      margin_r: 11,
      bold: true,
      italic: false,
    },
    en: {
      style_name: "Eng - ITC",
      font: "ITCAvantGardePro-Demi",
      size: 47,
      color: "#C0A783",
      secondary_color: "#FF0000",
      outline_color: "#040000",
      back_color: "#091703",
      back_opacity: 1.0,
      outline: 0.8,
      shadow: 0.8,
      scale_x: 95,
      margin_l: 15,
      margin_r: 15,
      bold: true,
      italic: false,
    },
  },

  waveform: createDemoWaveform(18, 25),
  pxPerSec: 100, // timeline zoom

  undoStack: [],
  redoStack: [],
  settings: {},
  aiPollTimer: null,
};

// DOM References
const el = {
  video: document.getElementById("videoEl"),
  demoBackdrop: document.getElementById("demoBackdrop"),
  videoStage: document.getElementById("videoStage"),
  subtitleOverlay: document.getElementById("subtitleOverlay"),
  subBoxWrap: document.getElementById("subBoxWrap"),
  subLineTop: document.getElementById("subLineTop"),
  subLineBottom: document.getElementById("subLineBottom"),
  mediaStatusText: document.getElementById("mediaStatusText"),

  btnPlayPause: document.getElementById("btnPlayPause"),
  curTimeLabel: document.getElementById("curTimeLabel"),
  durTimeLabel: document.getElementById("durTimeLabel"),
  chkLoopCue: document.getElementById("chkLoopCue"),
  selPlaybackRate: document.getElementById("selPlaybackRate"),

  presetGrid: document.getElementById("presetGrid"),
  waveformScroll: document.getElementById("waveformScroll"),
  waveformCanvas: document.getElementById("waveformCanvas"),
  subTableBody: document.getElementById("subTableBody"),
  subCountBadge: document.getElementById("subCountBadge"),
  bilingualRateBadge: document.getElementById("bilingualRateBadge"),
  chkSeekOnClick: document.getElementById("chkSeekOnClick"),
  inpSearch: document.getElementById("inpSearch"),
};

// ---------------------------------------------------------------------------
// Helpers: Bridge, Toast, Time Formatting, Undo/Redo
// ---------------------------------------------------------------------------

function hasApi() {
  return Boolean(window.pywebview && window.pywebview.api);
}

function showToast(msg, type = "info") {
  const box = document.getElementById("toastContainer");
  const div = document.createElement("div");
  div.className = `toast ${type}`;
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => {
    div.style.opacity = "0";
    setTimeout(() => div.remove(), 220);
  }, 3400);
}

function formatDisplayTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function parseDisplayTime(str) {
  if (!str) return null;
  const clean = str.trim().replace(",", ".");
  const parts = clean.split(":");
  let sec = 0;
  if (parts.length === 3) {
    sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  } else if (parts.length === 2) {
    sec = Number(parts[0]) * 60 + Number(parts[1]);
  } else if (parts.length === 1) {
    sec = Number(parts[0]);
  } else {
    return null;
  }
  if (Number.isNaN(sec) || sec < 0) return null;
  return Math.round(sec * 1000);
}

function pushUndoSnapshot() {
  state.undoStack.push(JSON.stringify(state.subtitles));
  if (state.undoStack.length > 45) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (!state.undoStack.length) {
    showToast("没有可撤销的操作");
    return;
  }
  state.redoStack.push(JSON.stringify(state.subtitles));
  state.subtitles = JSON.parse(state.undoStack.pop());
  state.selectedIdx = Math.min(state.selectedIdx, Math.max(0, state.subtitles.length - 1));
  renderTable();
  updateSubtitleOverlay();
  drawWaveform();
  showToast("已撤销上一步修改");
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(JSON.stringify(state.subtitles));
  state.subtitles = JSON.parse(state.redoStack.pop());
  renderTable();
  updateSubtitleOverlay();
  drawWaveform();
  showToast("已重做修改");
}

function reindexSubtitles() {
  state.subtitles.forEach((item, idx) => {
    item.id = idx + 1;
  });
}

// ---------------------------------------------------------------------------
// Video & Playback Engine (Supports both Real Video & Built-in Demo Timer)
// ---------------------------------------------------------------------------

function seekToMs(ms) {
  const clamped = Math.max(0, Math.min(state.durationMs || 36000000, Math.round(ms)));
  state.currentTimeMs = clamped;
  if (state.hasRealVideo) {
    el.video.currentTime = clamped / 1000;
  }
  updateTimeReadout();
  updateSubtitleOverlay();
  highlightPlayingRow();
  ensurePlayheadVisible();
  drawWaveform();
}

function isPlaying() {
  return state.hasRealVideo ? !el.video.paused : state.demoPlaying;
}

function togglePlayPause() {
  if (state.hasRealVideo) {
    if (el.video.paused) {
      el.video.play();
    } else {
      el.video.pause();
    }
  } else {
    state.demoPlaying = !state.demoPlaying;
    if (state.demoPlaying) {
      if (state.currentTimeMs >= state.durationMs - 100) state.currentTimeMs = 0;
      state.demoLastTick = performance.now();
      requestAnimationFrame(demoLoopTick);
    }
    syncPlayButtonUI();
  }
}

function syncPlayButtonUI() {
  el.btnPlayPause.textContent = isPlaying() ? "⏸ 暂停" : "▶ 播放";
}

function demoLoopTick(now) {
  if (!state.demoPlaying || state.hasRealVideo) return;
  const dt = (now - state.demoLastTick) * Number(el.selPlaybackRate.value || 1);
  state.demoLastTick = now;
  state.currentTimeMs += dt;

  handleSingleCueLoopCheck();

  if (state.currentTimeMs >= state.durationMs) {
    state.currentTimeMs = state.durationMs;
    state.demoPlaying = false;
    syncPlayButtonUI();
  }
  updateTimeReadout();
  updateSubtitleOverlay();
  highlightPlayingRow();
  ensurePlayheadVisible(true);
  drawWaveform();
  if (state.demoPlaying) requestAnimationFrame(demoLoopTick);
}

function handleSingleCueLoopCheck() {
  if (!el.chkLoopCue.checked) return;
  const cue = state.subtitles[state.selectedIdx];
  if (!cue) return;
  if (state.currentTimeMs > cue.end_ms) {
    seekToMs(cue.start_ms);
  }
}

function replaySelectedCue() {
  const cue = state.subtitles[state.selectedIdx];
  if (!cue) return;
  seekToMs(cue.start_ms);
  if (!isPlaying()) togglePlayPause();
}

function updateTimeReadout() {
  el.curTimeLabel.textContent = formatDisplayTime(state.currentTimeMs);
  el.durTimeLabel.textContent = formatDisplayTime(state.durationMs);
}

// Smooth playhead animation for real HTML5 video
function startRealVideoRaf() {
  function tick() {
    if (state.hasRealVideo && !el.video.paused) {
      state.currentTimeMs = Math.round(el.video.currentTime * 1000);
      handleSingleCueLoopCheck();
      updateTimeReadout();
      updateSubtitleOverlay();
      highlightPlayingRow();
      ensurePlayheadVisible(true);
      drawWaveform();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// 1:1 Scaled ASS WYSIWYG Subtitle Overlay
// ---------------------------------------------------------------------------

function buildCrispOutlineShadow(outlinePx, outlineColor, shadowPx, blurPx = 0) {
  const shadows = [];
  const softBlur = Math.max(0, blurPx).toFixed(2);
  if (outlinePx > 0.1) {
    const r = outlinePx;
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = (Math.cos(angle) * r).toFixed(2);
      const y = (Math.sin(angle) * r).toFixed(2);
      shadows.push(`${x}px ${y}px ${softBlur}px ${outlineColor}`);
    }
  } else if (blurPx > 0.1) {
    shadows.push(`0 0 ${(blurPx * 1.5).toFixed(2)}px ${outlineColor}`);
  }
  if (shadowPx > 0.1) {
    const d = (shadowPx + outlinePx * 0.4).toFixed(2);
    const sBlur = Math.max(shadowPx * 1.4, blurPx * 1.2).toFixed(2);
    shadows.push(`${d}px ${d}px ${sBlur}px rgba(0,0,0,0.85)`);
  }
  return shadows.join(", ");
}

function hexToRgba(hex, alpha) {
  const c = (hex || "#000000").replace("#", "");
  const r = parseInt(c.slice(0, 2) || "00", 16);
  const g = parseInt(c.slice(2, 4) || "00", 16);
  const b = parseInt(c.slice(4, 6) || "00", 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolveFontStack(fontName) {
  if (fontName === "ITCAvantGardePro-Demi") {
    return `"ITCAvantGardePro-Demi", "ITC Avant Garde Gothic Pro", "Avenir Next W1G", "Century Gothic", "Segoe UI", sans-serif`;
  }
  if (fontName === "Cronos Pro") {
    return `"Cronos Pro", "Cronos Pro Subhead", "Segoe UI", sans-serif`;
  }
  return `"${fontName}", "WenQuanYi Micro Hei", "Microsoft YaHei", sans-serif`;
}

function applyLineStyle(domEl, cfg, scale, boxMode, blurVal = 0) {
  const fontSize = Math.max(10, cfg.size * scale);
  const scaleXRatio = (Number(cfg.scale_x) || 100) / 100;
  domEl.style.fontFamily = resolveFontStack(cfg.font);
  domEl.style.fontSize = `${fontSize.toFixed(1)}px`;
  domEl.style.color = cfg.color;
  domEl.style.fontWeight = cfg.bold ? "700" : "400";
  domEl.style.fontStyle = cfg.italic ? "italic" : "normal";
  domEl.style.transform = scaleXRatio !== 1 ? `scaleX(${scaleXRatio.toFixed(2)})` : "none";
  domEl.style.transformOrigin = "center bottom";
  if (boxMode) {
    domEl.style.textShadow = "none";
  } else {
    domEl.style.textShadow = buildCrispOutlineShadow(
      cfg.outline * scale,
      cfg.outline_color,
      cfg.shadow * scale,
      blurVal * scale
    );
  }
}

function findActiveCueAt(ms) {
  for (let i = 0; i < state.subtitles.length; i++) {
    const c = state.subtitles[i];
    if (ms >= c.start_ms && ms <= c.end_ms) return { cue: c, idx: i };
  }
  return null;
}

function updateSubtitleOverlay() {
  const stageH = el.videoStage.clientHeight || 360;
  const scale = stageH / 1080; // Matches PlayResY: 1080 in exported .ass!

  el.subtitleOverlay.style.bottom = `${Math.round(state.style.margin_v * scale)}px`;
  el.subBoxWrap.style.gap = `${Math.max(1, Math.round(state.style.line_gap * scale))}px`;

  if (state.style.box_mode) {
    el.subBoxWrap.style.background = hexToRgba(
      state.style.box_color,
      state.style.box_opacity
    );
    el.subBoxWrap.style.padding = `${Math.max(4, Math.round(10 * scale))}px ${Math.max(10, Math.round(24 * scale))}px`;
    el.subBoxWrap.style.borderRadius = `${Math.max(4, Math.round(10 * scale))}px`;
  } else {
    el.subBoxWrap.style.background = "transparent";
    el.subBoxWrap.style.padding = "0";
  }

  const active = findActiveCueAt(state.currentTimeMs);
  if (!active) {
    el.subBoxWrap.style.display = "none";
    return;
  }

  const zhText = (active.cue.zh || "").trim();
  const enText = (active.cue.en || "").trim();

  let topCfg, bottomCfg, topTxt, bottomTxt;
  if (state.style.order === "zh_top") {
    topCfg = state.style.zh;
    bottomCfg = state.style.en;
    topTxt = state.langMode === "en_only" ? "" : zhText;
    bottomTxt = state.langMode === "zh_only" ? "" : enText;
  } else {
    topCfg = state.style.en;
    bottomCfg = state.style.zh;
    topTxt = state.langMode === "zh_only" ? "" : enText;
    bottomTxt = state.langMode === "en_only" ? "" : zhText;
  }

  if (!topTxt && !bottomTxt) {
    el.subBoxWrap.style.display = "none";
    return;
  }

  el.subBoxWrap.style.display = "inline-flex";

  const blurVal = Number(state.style.blur ?? 2.0);

  if (topTxt) {
    el.subLineTop.style.display = "block";
    el.subLineTop.textContent = topTxt;
    applyLineStyle(el.subLineTop, topCfg, scale, state.style.box_mode, blurVal);
  } else {
    el.subLineTop.style.display = "none";
  }

  if (bottomTxt) {
    el.subLineBottom.style.display = "block";
    el.subLineBottom.textContent = bottomTxt;
    applyLineStyle(el.subLineBottom, bottomCfg, scale, state.style.box_mode, blurVal);
  } else {
    el.subLineBottom.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Style Studio Presets & Controls Binding
// ---------------------------------------------------------------------------

function extractStyleFromPreset(p) {
  const copy = structuredClone(p);
  delete copy.id;
  delete copy.name;
  delete copy.desc;
  if (copy.blur === undefined) copy.blur = 0.8;
  if (copy.ycbcr_matrix === undefined) copy.ycbcr_matrix = "None";
  if (copy.zh && copy.zh.scale_x === undefined) copy.zh.scale_x = 100;
  if (copy.en && copy.en.scale_x === undefined) copy.en.scale_x = 100;
  return copy;
}

function ensureSelectOption(selectEl, val) {
  if (!val) return;
  const exists = Array.from(selectEl.options).some((opt) => opt.value === val);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    selectEl.appendChild(opt);
  }
  selectEl.value = val;
}

function renderPresetCards() {
  el.presetGrid.innerHTML = "";
  state.presets.forEach((p) => {
    const card = document.createElement("div");
    card.className = `preset-card ${p.id === state.activePresetId ? "active" : ""}`;
    const topIsZh = p.order !== "en_top";
    const firstColor = topIsZh ? p.zh.color : p.en.color;
    const secondColor = topIsZh ? p.en.color : p.zh.color;
    const boxBg = p.box_mode ? hexToRgba(p.box_color, p.box_opacity) : "#060911";

    card.innerHTML = `
      <div class="preset-preview-mini" style="background:${boxBg}">
        <div style="color:${firstColor};font-weight:700;font-size:12px;">${topIsZh ? "示例双语字幕效果" : "Cinema Subtitle"}</div>
        <div style="color:${secondColor};font-size:10px;">${topIsZh ? "Cinema Subtitle" : "示例双语字幕效果"}</div>
      </div>
      <div class="preset-name">${p.name}</div>
      <div class="preset-desc">${p.desc}</div>
    `;
    card.addEventListener("click", () => {
      state.activePresetId = p.id;
      state.style = extractStyleFromPreset(p);
      syncStyleControlsFromState();
      renderPresetCards();
      updateSubtitleOverlay();
    });
    el.presetGrid.appendChild(card);
  });
}

function syncStyleControlsFromState() {
  const s = state.style;
  document.querySelectorAll("#orderSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.order === s.order);
  });
  document.querySelectorAll("#langModeSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.langMode);
  });
  document.getElementById("chkBoxMode").checked = Boolean(s.box_mode);
  document.getElementById("rngMarginV").value = s.margin_v;
  document.getElementById("lblMarginV").textContent = s.margin_v;

  const blurVal = s.blur ?? 2;
  document.getElementById("rngBlur").value = blurVal;
  document.getElementById("lblBlur").textContent = blurVal;

  // ZH fields
  ensureSelectOption(document.getElementById("zhFont"), s.zh.font);
  document.getElementById("zhSize").value = s.zh.size;
  document.getElementById("lblZhSize").textContent = s.zh.size;
  document.getElementById("zhColor").value = s.zh.color;
  document.getElementById("lblZhColor").textContent = s.zh.color.toUpperCase();
  document.getElementById("zhOutlineColor").value = s.zh.outline_color;
  document.getElementById("lblZhOutlineColor").textContent = s.zh.outline_color.toUpperCase();
  document.getElementById("zhOutline").value = s.zh.outline;
  document.getElementById("lblZhOutline").textContent = s.zh.outline;
  document.getElementById("zhShadow").value = s.zh.shadow;
  document.getElementById("lblZhShadow").textContent = s.zh.shadow;
  const zhSx = s.zh.scale_x ?? 100;
  document.getElementById("zhScaleX").value = zhSx;
  document.getElementById("lblZhScaleX").textContent = zhSx;
  document.getElementById("zhBold").checked = Boolean(s.zh.bold);
  document.getElementById("zhItalic").checked = Boolean(s.zh.italic);

  // EN fields
  ensureSelectOption(document.getElementById("enFont"), s.en.font);
  document.getElementById("enSize").value = s.en.size;
  document.getElementById("lblEnSize").textContent = s.en.size;
  document.getElementById("enColor").value = s.en.color;
  document.getElementById("lblEnColor").textContent = s.en.color.toUpperCase();
  document.getElementById("enOutlineColor").value = s.en.outline_color;
  document.getElementById("lblEnOutlineColor").textContent = s.en.outline_color.toUpperCase();
  document.getElementById("enOutline").value = s.en.outline;
  document.getElementById("lblEnOutline").textContent = s.en.outline;
  document.getElementById("enShadow").value = s.en.shadow;
  document.getElementById("lblEnShadow").textContent = s.en.shadow;
  const enSx = s.en.scale_x ?? 100;
  document.getElementById("enScaleX").value = enSx;
  document.getElementById("lblEnScaleX").textContent = enSx;
  document.getElementById("enBold").checked = Boolean(s.en.bold);
  document.getElementById("enItalic").checked = Boolean(s.en.italic);
}

function bindStyleEvents() {
  // Tabs
  document.querySelectorAll(".panel-tabs .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".panel-tabs .tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".style-panel .tab-body").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // Order segmented buttons
  document.querySelectorAll("#orderSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.style.order = btn.dataset.order;
      syncStyleControlsFromState();
      updateSubtitleOverlay();
    });
  });

  // Lang mode segmented buttons
  document.querySelectorAll("#langModeSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.langMode = btn.dataset.mode;
      syncStyleControlsFromState();
      updateSubtitleOverlay();
    });
  });

  document.getElementById("chkBoxMode").addEventListener("change", (e) => {
    state.style.box_mode = e.target.checked;
    updateSubtitleOverlay();
  });

  document.getElementById("rngMarginV").addEventListener("input", (e) => {
    state.style.margin_v = Number(e.target.value);
    document.getElementById("lblMarginV").textContent = state.style.margin_v;
    updateSubtitleOverlay();
  });

  document.getElementById("rngBlur").addEventListener("input", (e) => {
    state.style.blur = Number(e.target.value);
    document.getElementById("lblBlur").textContent = state.style.blur;
    updateSubtitleOverlay();
  });

  const bindLangField = (lang, field, domId, labelId, isNum = false, isCheck = false) => {
    const node = document.getElementById(domId);
    node.addEventListener("input", () => {
      const val = isCheck ? node.checked : isNum ? Number(node.value) : node.value;
      state.style[lang][field] = val;
      if (labelId) {
        document.getElementById(labelId).textContent =
          typeof val === "string" ? val.toUpperCase() : val;
      }
      updateSubtitleOverlay();
    });
  };

  bindLangField("zh", "font", "zhFont");
  bindLangField("zh", "size", "zhSize", "lblZhSize", true);
  bindLangField("zh", "color", "zhColor", "lblZhColor");
  bindLangField("zh", "outline_color", "zhOutlineColor", "lblZhOutlineColor");
  bindLangField("zh", "outline", "zhOutline", "lblZhOutline", true);
  bindLangField("zh", "shadow", "zhShadow", "lblZhShadow", true);
  bindLangField("zh", "scale_x", "zhScaleX", "lblZhScaleX", true);
  bindLangField("zh", "bold", "zhBold", null, false, true);
  bindLangField("zh", "italic", "zhItalic", null, false, true);

  bindLangField("en", "font", "enFont");
  bindLangField("en", "size", "enSize", "lblEnSize", true);
  bindLangField("en", "color", "enColor", "lblEnColor");
  bindLangField("en", "outline_color", "enOutlineColor", "lblEnOutlineColor");
  bindLangField("en", "outline", "enOutline", "lblEnOutline", true);
  bindLangField("en", "shadow", "enShadow", "lblEnShadow", true);
  bindLangField("en", "scale_x", "enScaleX", "lblEnScaleX", true);
  bindLangField("en", "bold", "enBold", null, false, true);
  bindLangField("en", "italic", "enItalic", null, false, true);
}

// ---------------------------------------------------------------------------
// Interactive Audio Waveform & Visual Subtitle Block Timeline
// ---------------------------------------------------------------------------

let dragState = null;

function getTimelineTotalDurationSec() {
  const maxSubEnd = state.subtitles.reduce((m, c) => Math.max(m, c.end_ms), 0);
  const durMs = Math.max(state.durationMs || 18000, maxSubEnd + 3000, 10000);
  return durMs / 1000;
}

function ensurePlayheadVisible(smoothFollow = false) {
  const x = (state.currentTimeMs / 1000) * state.pxPerSec;
  const sc = el.waveformScroll;
  const viewLeft = sc.scrollLeft;
  const viewRight = viewLeft + sc.clientWidth;
  if (x < viewLeft + 40 || x > viewRight - 60) {
    sc.scrollLeft = Math.max(0, x - sc.clientWidth * (smoothFollow ? 0.25 : 0.45));
  }
}

function drawWaveform() {
  const canvas = el.waveformCanvas;
  const scrollWrap = el.waveformScroll;
  const totalSec = getTimelineTotalDurationSec();
  const desiredW = Math.max(scrollWrap.clientWidth, Math.ceil(totalSec * state.pxPerSec));
  // Cap canvas width at 32000px to stay comfortably inside GPU texture limits
  const maxCanvasW = 32000;
  const effectivePxPerSec = desiredW > maxCanvasW ? maxCanvasW / totalSec : state.pxPerSec;
  const width = Math.max(scrollWrap.clientWidth, Math.ceil(totalSec * effectivePxPerSec));
  const height = 84;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  // Background
  ctx.fillStyle = "#070b14";
  ctx.fillRect(0, 0, width, height);

  // Top ruler band
  ctx.fillStyle = "#0d1424";
  ctx.fillRect(0, 0, width, 18);

  // Time ticks
  const stepSec = effectivePxPerSec >= 110 ? 1 : effectivePxPerSec >= 55 ? 2 : 5;
  ctx.font = "10px Consolas, monospace";
  ctx.fillStyle = "#64748b";
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;

  for (let s = 0; s <= totalSec; s += stepSec) {
    const x = Math.round(s * effectivePxPerSec) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x, height);
    ctx.stroke();

    const mins = Math.floor(s / 60);
    const secs = s % 60;
    ctx.fillText(`${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`, x + 3, 12);
  }

  // Audio waveform peaks
  const peaks = state.waveform?.peaks || [];
  const pps = state.waveform?.peaks_per_sec || 25;
  if (peaks.length > 0) {
    const midY = 52;
    const maxAmp = 28;
    ctx.fillStyle = "rgba(56, 189, 248, 0.36)";
    const stepPx = Math.max(2, effectivePxPerSec / pps);
    const visibleStartSec = Math.max(0, scrollWrap.scrollLeft / effectivePxPerSec - 2);
    const visibleEndSec = (scrollWrap.scrollLeft + scrollWrap.clientWidth) / effectivePxPerSec + 2;
    const iStart = Math.max(0, Math.floor(visibleStartSec * pps));
    const iEnd = Math.min(peaks.length - 1, Math.ceil(visibleEndSec * pps));

    for (let i = iStart; i <= iEnd; i++) {
      const sec = i / pps;
      const x = sec * effectivePxPerSec;
      const h = Math.max(2, (peaks[i] / 100) * maxAmp * 2);
      ctx.fillRect(x, midY - h / 2, Math.max(1.5, stepPx - 0.6), h);
    }
  }

  // Subtitle regions
  state.subtitles.forEach((cue, idx) => {
    const x1 = (cue.start_ms / 1000) * effectivePxPerSec;
    const x2 = Math.max(x1 + 6, (cue.end_ms / 1000) * effectivePxPerSec);
    const w = x2 - x1;
    const isSel = idx === state.selectedIdx;

    ctx.fillStyle = isSel ? "rgba(59, 130, 246, 0.34)" : "rgba(139, 92, 246, 0.19)";
    ctx.strokeStyle = isSel ? "#60a5fa" : "rgba(167, 139, 250, 0.55)";
    ctx.lineWidth = isSel ? 1.6 : 1;

    ctx.beginPath();
    ctx.roundRect(x1, 21, w, 58, 4);
    ctx.fill();
    ctx.stroke();

    // Drag handles visual indicator on selected cue
    if (isSel) {
      ctx.fillStyle = "#93c5fd";
      ctx.fillRect(x1, 21, 3, 58);
      ctx.fillRect(x2 - 3, 21, 3, 58);
    }

    // Text preview inside block
    if (w > 26) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1 + 4, 22, w - 8, 56);
      ctx.clip();
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 11px 'Microsoft YaHei', sans-serif";
      const label = cue.zh || cue.en || `#${cue.id}`;
      ctx.fillText(`#${cue.id} ${label}`, x1 + 6, 37);
      if (cue.zh && cue.en) {
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "10px 'Segoe UI', sans-serif";
        ctx.fillText(cue.en, x1 + 6, 53);
      }
      ctx.restore();
    }
  });

  // Playhead needle
  const playX = (state.currentTimeMs / 1000) * effectivePxPerSec;
  ctx.strokeStyle = "#f43f5e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, height);
  ctx.stroke();

  ctx.fillStyle = "#f43f5e";
  ctx.beginPath();
  ctx.moveTo(playX - 5, 0);
  ctx.lineTo(playX + 5, 0);
  ctx.lineTo(playX, 8);
  ctx.closePath();
  ctx.fill();
}

function getEffectivePxPerSec() {
  const totalSec = getTimelineTotalDurationSec();
  const desiredW = Math.max(el.waveformScroll.clientWidth, Math.ceil(totalSec * state.pxPerSec));
  return desiredW > 32000 ? 32000 / totalSec : state.pxPerSec;
}

function hitTestWaveform(mouseX, mouseY) {
  const pps = getEffectivePxPerSec();
  if (mouseY < 20) return { type: "scrub" };

  for (let i = state.subtitles.length - 1; i >= 0; i--) {
    const c = state.subtitles[i];
    const x1 = (c.start_ms / 1000) * pps;
    const x2 = Math.max(x1 + 6, (c.end_ms / 1000) * pps);
    if (mouseY >= 21 && mouseY <= 79) {
      if (Math.abs(mouseX - x1) <= 6) return { type: "resize-start", idx: i };
      if (Math.abs(mouseX - x2) <= 6) return { type: "resize-end", idx: i };
      if (mouseX > x1 && mouseX < x2) return { type: "cue-body", idx: i };
    }
  }
  return { type: "scrub" };
}

function bindWaveformEvents() {
  const canvas = el.waveformCanvas;

  el.waveformScroll.addEventListener("scroll", () => drawWaveform());

  document.getElementById("rngZoom").addEventListener("input", (e) => {
    state.pxPerSec = Number(e.target.value);
    drawWaveform();
    ensurePlayheadVisible();
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pps = getEffectivePxPerSec();

    if (!dragState) {
      const hit = hitTestWaveform(x, y);
      if (hit.type === "resize-start" || hit.type === "resize-end") {
        canvas.style.cursor = "ew-resize";
      } else if (hit.type === "cue-body") {
        canvas.style.cursor = "grab";
      } else {
        canvas.style.cursor = "crosshair";
      }
      return;
    }

    const timeMs = Math.max(0, Math.round((x / pps) * 1000));
    if (dragState.type === "scrub") {
      seekToMs(timeMs);
    } else if (dragState.type === "resize-start") {
      const cue = state.subtitles[dragState.idx];
      cue.start_ms = Math.min(timeMs, cue.end_ms - 200);
      syncSingleRowTimeInputs(dragState.idx);
      updateSubtitleOverlay();
      drawWaveform();
    } else if (dragState.type === "resize-end") {
      const cue = state.subtitles[dragState.idx];
      cue.end_ms = Math.max(timeMs, cue.start_ms + 200);
      syncSingleRowTimeInputs(dragState.idx);
      updateSubtitleOverlay();
      drawWaveform();
    } else if (dragState.type === "cue-body") {
      const deltaMs = timeMs - dragState.startMouseMs;
      if (Math.abs(deltaMs) > 30) dragState.moved = true;
      if (dragState.moved) {
        const cue = state.subtitles[dragState.idx];
        const dur = dragState.origEnd - dragState.origStart;
        const ns = Math.max(0, dragState.origStart + deltaMs);
        cue.start_ms = ns;
        cue.end_ms = ns + dur;
        syncSingleRowTimeInputs(dragState.idx);
        updateSubtitleOverlay();
        drawWaveform();
      }
    }
  });

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pps = getEffectivePxPerSec();
    const hit = hitTestWaveform(x, y);
    const clickMs = Math.max(0, Math.round((x / pps) * 1000));

    if (hit.type === "scrub") {
      dragState = { type: "scrub" };
      seekToMs(clickMs);
    } else {
      pushUndoSnapshot();
      selectRow(hit.idx, false);
      const cue = state.subtitles[hit.idx];
      dragState = {
        type: hit.type,
        idx: hit.idx,
        startMouseMs: clickMs,
        origStart: cue.start_ms,
        origEnd: cue.end_ms,
        moved: false,
      };
      if (hit.type === "cue-body") {
        seekToMs(clickMs);
      }
    }
  });

  window.addEventListener("mouseup", () => {
    dragState = null;
  });
}

// ---------------------------------------------------------------------------
// 1-Click Foolproof Timing Actions (F3 / F4)
// ---------------------------------------------------------------------------

function markCurrentStart() {
  if (!state.subtitles.length) {
    addCueAtPlayhead();
    return;
  }
  pushUndoSnapshot();
  const cue = state.subtitles[state.selectedIdx];
  cue.start_ms = state.currentTimeMs;
  if (cue.end_ms <= cue.start_ms + 300) {
    cue.end_ms = cue.start_ms + 2400;
  }
  syncSingleRowTimeInputs(state.selectedIdx);
  updateSubtitleOverlay();
  drawWaveform();
  showToast(`已设第 #${cue.id} 句开始时间为 ${formatDisplayTime(cue.start_ms)}`, "success");
}

function markCurrentEndAndNext() {
  if (!state.subtitles.length) return;
  pushUndoSnapshot();
  const cue = state.subtitles[state.selectedIdx];
  if (state.currentTimeMs > cue.start_ms + 120) {
    cue.end_ms = state.currentTimeMs;
  } else {
    cue.end_ms = cue.start_ms + 1200;
  }
  syncSingleRowTimeInputs(state.selectedIdx);

  // Advance to next row and gently pre-fill next start if it overlaps or is untimed
  if (state.selectedIdx + 1 < state.subtitles.length) {
    const nextIdx = state.selectedIdx + 1;
    selectRow(nextIdx, false);
    scrollRowIntoView(nextIdx);
  }
  updateSubtitleOverlay();
  drawWaveform();
}

function addCueAtPlayhead() {
  pushUndoSnapshot();
  const start = state.currentTimeMs;
  const end = start + 2500;
  const newCue = { id: 0, start_ms: start, end_ms: end, zh: "", en: "" };

  // Insert in chronological order
  let insertIdx = state.subtitles.findIndex((c) => c.start_ms > start);
  if (insertIdx === -1) insertIdx = state.subtitles.length;
  state.subtitles.splice(insertIdx, 0, newCue);
  reindexSubtitles();
  state.selectedIdx = insertIdx;
  renderTable();
  scrollRowIntoView(insertIdx);
  updateSubtitleOverlay();
  drawWaveform();

  const zhInput = el.subTableBody.querySelector(`.sub-row[data-idx="${insertIdx}"] .zh-inp`);
  if (zhInput) zhInput.focus();
}

// ---------------------------------------------------------------------------
// Side-by-Side Bilingual Table Rendering & Editing
// ---------------------------------------------------------------------------

function updateStatsBadges() {
  const total = state.subtitles.length;
  const both = state.subtitles.filter((c) => (c.zh || "").trim() && (c.en || "").trim()).length;
  const pct = total === 0 ? 0 : Math.round((both / total) * 100);
  el.subCountBadge.textContent = `共 ${total} 句`;
  el.bilingualRateBadge.textContent = `双语完整 ${both}/${total} (${pct}%)`;
}

function selectRow(idx, allowSeek = true) {
  if (idx < 0 || idx >= state.subtitles.length) return;
  state.selectedIdx = idx;
  el.subTableBody.querySelectorAll(".sub-row").forEach((r) => {
    r.classList.toggle("selected", Number(r.dataset.idx) === idx);
  });
  if (allowSeek && el.chkSeekOnClick.checked) {
    seekToMs(state.subtitles[idx].start_ms + 20);
  } else {
    drawWaveform();
  }
}

function scrollRowIntoView(idx) {
  const row = el.subTableBody.querySelector(`.sub-row[data-idx="${idx}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function highlightPlayingRow() {
  const active = findActiveCueAt(state.currentTimeMs);
  const activeIdx = active ? active.idx : -1;
  el.subTableBody.querySelectorAll(".sub-row").forEach((r) => {
    r.classList.toggle("playing-now", Number(r.dataset.idx) === activeIdx);
  });
}

function syncSingleRowTimeInputs(idx) {
  const row = el.subTableBody.querySelector(`.sub-row[data-idx="${idx}"]`);
  if (!row) return;
  const cue = state.subtitles[idx];
  const inputs = row.querySelectorAll(".time-input");
  if (inputs[0]) inputs[0].value = formatDisplayTime(cue.start_ms);
  if (inputs[1]) inputs[1].value = formatDisplayTime(cue.end_ms);
}

function renderTable() {
  updateStatsBadges();
  const q = state.searchQuery.trim().toLowerCase();
  const frag = document.createDocumentFragment();

  state.subtitles.forEach((cue, idx) => {
    if (q) {
      const hay = `${cue.zh || ""} ${cue.en || ""}`.toLowerCase();
      if (!hay.includes(q)) return;
    }

    const row = document.createElement("div");
    row.className = `sub-row ${idx === state.selectedIdx ? "selected" : ""}`;
    row.dataset.idx = idx;

    row.innerHTML = `
      <div class="col-idx">${cue.id}</div>
      <div class="time-cell">
        <input type="text" class="time-input t-start" value="${formatDisplayTime(cue.start_ms)}" title="开始时间 (格式 分:秒.毫秒)" />
        <span class="time-arrow">→</span>
        <input type="text" class="time-input t-end" value="${formatDisplayTime(cue.end_ms)}" title="结束时间" />
      </div>
      <div>
        <input type="text" class="sub-input zh-inp" placeholder="输入中文台词…" />
      </div>
      <div>
        <input type="text" class="sub-input en-inp" placeholder="Enter English subtitle…" />
      </div>
      <div class="row-ops">
        <button class="op-btn act-play" title="定位并播放本句">▶</button>
        <button class="op-btn act-trans" title="AI 单句互译补全 (中⇄英)">🌐</button>
        <button class="op-btn act-insert" title="在下方插入新行">➕</button>
        <button class="op-btn act-merge" title="与下一句合并">🔗</button>
        <button class="op-btn danger act-del" title="删除本句">🗑</button>
      </div>
    `;

    const zhInp = row.querySelector(".zh-inp");
    const enInp = row.querySelector(".en-inp");
    zhInp.value = cue.zh || "";
    enInp.value = cue.en || "";

    row.addEventListener("mousedown", (e) => {
      if (e.target.closest(".row-ops")) return;
      const isTextInput = e.target.classList.contains("sub-input") || e.target.classList.contains("time-input");
      if (state.selectedIdx !== idx) {
        selectRow(idx, !isTextInput || el.chkSeekOnClick.checked);
      }
    });

    // Time inputs
    const tStart = row.querySelector(".t-start");
    const tEnd = row.querySelector(".t-end");
    tStart.addEventListener("change", () => {
      const parsed = parseDisplayTime(tStart.value);
      if (parsed !== null) {
        pushUndoSnapshot();
        cue.start_ms = parsed;
        if (cue.end_ms <= cue.start_ms) cue.end_ms = cue.start_ms + 1000;
        syncSingleRowTimeInputs(idx);
        updateSubtitleOverlay();
        drawWaveform();
      } else {
        tStart.value = formatDisplayTime(cue.start_ms);
      }
    });

    tEnd.addEventListener("change", () => {
      const parsed = parseDisplayTime(tEnd.value);
      if (parsed !== null && parsed > cue.start_ms) {
        pushUndoSnapshot();
        cue.end_ms = parsed;
        updateSubtitleOverlay();
        drawWaveform();
      } else {
        tEnd.value = formatDisplayTime(cue.end_ms);
      }
    });

    // Live bilingual text editing
    let pushedForFocus = false;
    const onFocusEdit = () => {
      pushedForFocus = false;
    };
    const onInputEdit = (field, inp) => {
      if (!pushedForFocus) {
        pushUndoSnapshot();
        pushedForFocus = true;
      }
      cue[field] = inp.value;
      updateSubtitleOverlay();
      updateStatsBadges();
      drawWaveform();
    };

    zhInp.addEventListener("focus", onFocusEdit);
    enInp.addEventListener("focus", onFocusEdit);
    zhInp.addEventListener("input", () => onInputEdit("zh", zhInp));
    enInp.addEventListener("input", () => onInputEdit("en", enInp));

    // Enter jumps directly to next row's same column!
    const handleEnterJump = (e, selector) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const nextIdx = idx + 1;
        if (nextIdx < state.subtitles.length) {
          selectRow(nextIdx, el.chkSeekOnClick.checked);
          const nextRow = el.subTableBody.querySelector(`.sub-row[data-idx="${nextIdx}"] ${selector}`);
          if (nextRow) nextRow.focus();
        }
      }
    };
    zhInp.addEventListener("keydown", (e) => handleEnterJump(e, ".zh-inp"));
    enInp.addEventListener("keydown", (e) => handleEnterJump(e, ".en-inp"));

    // Row Action Buttons
    row.querySelector(".act-play").addEventListener("click", () => {
      selectRow(idx, false);
      replaySelectedCue();
    });

    row.querySelector(".act-trans").addEventListener("click", async () => {
      if (!hasApi()) {
        showToast("桌面端 API 未就绪", "error");
        return;
      }
      const hasEn = Boolean((cue.en || "").trim());
      const hasZh = Boolean((cue.zh || "").trim());
      if (!hasEn && !hasZh) {
        showToast("请先输入中文或英文任意一栏，再点单句互译");
        return;
      }
      const dir = hasEn && !hasZh ? "en_to_zh" : !hasEn && hasZh ? "zh_to_en" : "en_to_zh";
      const srcTxt = dir === "en_to_zh" ? cue.en : cue.zh;
      showToast("正在翻译该句…");
      const res = await window.pywebview.api.translate_single_row(srcTxt, dir);
      if (res.ok) {
        pushUndoSnapshot();
        if (dir === "en_to_zh") {
          cue.zh = res.translated;
          zhInp.value = res.translated;
        } else {
          cue.en = res.translated;
          enInp.value = res.translated;
        }
        updateSubtitleOverlay();
        updateStatsBadges();
        showToast("单句翻译完成！", "success");
      } else {
        showToast(res.error || "翻译失败", "error");
      }
    });

    row.querySelector(".act-insert").addEventListener("click", () => {
      pushUndoSnapshot();
      const newStart = cue.end_ms + 100;
      const nextCue = state.subtitles[idx + 1];
      const newEnd = nextCue && nextCue.start_ms > newStart + 400
        ? Math.min(newStart + 2500, nextCue.start_ms - 50)
        : newStart + 2500;
      state.subtitles.splice(idx + 1, 0, {
        id: 0,
        start_ms: newStart,
        end_ms: newEnd,
        zh: "",
        en: "",
      });
      reindexSubtitles();
      state.selectedIdx = idx + 1;
      renderTable();
      drawWaveform();
    });

    row.querySelector(".act-merge").addEventListener("click", () => {
      if (idx + 1 >= state.subtitles.length) {
        showToast("已经是最后一句了");
        return;
      }
      pushUndoSnapshot();
      const nxt = state.subtitles[idx + 1];
      cue.end_ms = Math.max(cue.end_ms, nxt.end_ms);
      cue.zh = [cue.zh, nxt.zh].filter(Boolean).join(" ");
      cue.en = [cue.en, nxt.en].filter(Boolean).join(" ");
      state.subtitles.splice(idx + 1, 1);
      reindexSubtitles();
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast("已与下一句合并");
    });

    row.querySelector(".act-del").addEventListener("click", () => {
      pushUndoSnapshot();
      state.subtitles.splice(idx, 1);
      reindexSubtitles();
      state.selectedIdx = Math.min(state.selectedIdx, Math.max(0, state.subtitles.length - 1));
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
    });

    frag.appendChild(row);
  });

  el.subTableBody.innerHTML = "";
  el.subTableBody.appendChild(frag);
  highlightPlayingRow();
}

// ---------------------------------------------------------------------------
// Native File Operations: Video, Import/Merge, AI, Export
// ---------------------------------------------------------------------------

async function handleVideoLoadedResponse(res) {
  if (!res || !res.ok) {
    if (res && res.error) showToast(res.error, "error");
    return;
  }
  state.demoPlaying = false;
  state.hasRealVideo = true;
  state.videoName = res.video_name;
  state.videoStem = res.video_stem || "双语字幕";
  if (res.duration_ms > 0) state.durationMs = res.duration_ms;

  el.demoBackdrop.classList.add("hidden");
  el.video.src = res.media_url;
  el.mediaStatusText.textContent = `当前视频：${res.video_name}`;
  showToast(`已加载视频：${res.video_name}，正在提取声波时间轴…`, "success");

  // Auto-load same-name subtitle if found next to the video!
  if (res.matching_subtitle_path && hasApi()) {
    const subRes = await window.pywebview.api.load_subtitle_by_path(
      res.matching_subtitle_path,
      "replace",
      "auto",
      "time",
      []
    );
    if (subRes.ok && subRes.subtitles.length) {
      pushUndoSnapshot();
      state.subtitles = subRes.subtitles;
      state.selectedIdx = 0;
      renderTable();
      showToast(`已自动载入同名字幕：${subRes.file_name} (${subRes.count} 句)`, "success");
    }
  }

  // Extract real audio waveform asynchronously
  if (hasApi()) {
    const wf = await window.pywebview.api.get_video_waveform();
    if (wf && wf.ok && wf.peaks && wf.peaks.length) {
      state.waveform = wf;
      if (wf.duration_ms > state.durationMs) state.durationMs = wf.duration_ms;
      updateTimeReadout();
      drawWaveform();
    }
  }
}

// Global callback invoked by Python pywebview drag-and-drop handler
window.onNativeFileDropped = async function (kind, fullPath) {
  if (!hasApi()) return;
  if (kind === "video") {
    const res = await window.pywebview.api.load_video_by_path(fullPath);
    await handleVideoLoadedResponse(res);
  } else {
    const res = await window.pywebview.api.load_subtitle_by_path(
      fullPath,
      "replace",
      "auto",
      "time",
      state.subtitles
    );
    if (res.ok) {
      pushUndoSnapshot();
      state.subtitles = res.subtitles;
      state.selectedIdx = 0;
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast(`已载入字幕：${res.file_name} (共 ${res.count} 句)`, "success");
    } else if (res.error) {
      showToast(res.error, "error");
    }
  }
};

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

function bindModalsAndTopbar() {
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });

  document.querySelectorAll(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => {
      if (e.target === bd) bd.classList.add("hidden");
    });
  });

  // 1. Open Video
  document.getElementById("btnOpenVideo").addEventListener("click", async () => {
    if (!hasApi()) return;
    const res = await window.pywebview.api.pick_video_file();
    await handleVideoLoadedResponse(res);
  });

  // 2. Import / Merge Subtitle Modal
  document.getElementById("btnOpenImport").addEventListener("click", () => openModal("modalImport"));

  document.querySelector("#cardImportReplace button").addEventListener("click", async () => {
    if (!hasApi()) return;
    const res = await window.pywebview.api.pick_subtitle_file("replace", "auto", "time", []);
    if (res.ok) {
      pushUndoSnapshot();
      state.subtitles = res.subtitles;
      state.selectedIdx = 0;
      closeModal("modalImport");
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast(`成功导入 ${res.file_name}（共 ${res.count} 句）`, "success");
    } else if (res.error) {
      showToast(res.error, "error");
    }
  });

  document.getElementById("btnPickMergeFile").addEventListener("click", async () => {
    if (!hasApi()) return;
    const alignMode = document.getElementById("selMergeAlign").value;
    const timeBase = document.getElementById("selMergeTimeBase").value;
    const tolMs = Number(document.getElementById("inpMergeTolerance").value || 800);
    const res = await window.pywebview.api.pick_subtitle_file(
      "merge",
      "auto",
      alignMode,
      state.subtitles,
      timeBase,
      tolMs
    );
    if (res.ok) {
      pushUndoSnapshot();
      state.subtitles = res.subtitles;
      closeModal("modalImport");
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      const detail =
        res.matched_count !== undefined
          ? `（成功配对 ${res.matched_count} 组，独立保留 ${res.unmatched_secondary || 0} 条）`
          : "";
      showToast(`合并双语完成！当前共 ${res.count} 句 ${detail}`, "success");
    } else if (res.error) {
      showToast(res.error, "error");
    }
  });

  // In-table Bilingual Pairing & Report Preview (v4.1 Enhanced)
  document.getElementById("btnOpenInternalMerge").addEventListener("click", () => {
    document.getElementById("mergeReportPre").classList.add("hidden");
    openModal("modalImport");
    setTimeout(() => {
      document.getElementById("secInternalMergeBox")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  });

  const runInternalMergeAction = async (previewOnly) => {
    if (!hasApi()) return;
    const timeBase = document.getElementById("selIntTimeBase").value;
    const matchMode = document.getElementById("selIntMatchMode").value;
    const tolMs = Number(document.getElementById("inpIntTolerance").value || 200);
    const res = await window.pywebview.api.merge_table_bilingual_rows(
      state.subtitles,
      tolMs,
      timeBase,
      matchMode,
      previewOnly
    );
    if (!res.ok) {
      showToast(res.error || "合并检查出错", "error");
      return;
    }
    const reportEl = document.getElementById("mergeReportPre");
    reportEl.textContent = res.report || "";
    reportEl.classList.remove("hidden");

    if (previewOnly) {
      showToast(`预览完成：共找到 ${res.matched_count} 组可合并配对`);
      return;
    }

    if (res.matched_count === 0) {
      showToast("未找到符合时间误差条件的单语中英配对行（可适当调大允许误差或切换重叠匹配）");
      return;
    }

    pushUndoSnapshot();
    state.subtitles = res.subtitles;
    state.selectedIdx = 0;
    renderTable();
    updateSubtitleOverlay();
    drawWaveform();
    showToast(`成功合并 ${res.matched_count} 组中英双语字幕！（可按 Ctrl+Z 撤销）`, "success");
  };

  document.getElementById("btnPreviewInternalMerge").addEventListener("click", () => runInternalMergeAction(true));
  document.getElementById("btnRunInternalMerge").addEventListener("click", () => runInternalMergeAction(false));

  document.getElementById("btnConfirmPaste").addEventListener("click", async () => {
    const txt = document.getElementById("txtPasteScript").value.trim();
    if (!txt) {
      showToast("请先在文本框中粘贴台词内容");
      return;
    }
    const mode = document.getElementById("selPasteMode").value;
    const mergeInto = document.getElementById("chkPasteMerge").checked;
    if (!hasApi()) return;
    const res = await window.pywebview.api.import_pasted_script(
      txt,
      mode,
      mergeInto,
      state.subtitles
    );
    if (res.ok) {
      pushUndoSnapshot();
      state.subtitles = res.subtitles;
      state.selectedIdx = 0;
      closeModal("modalImport");
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast(`已生成 ${res.count} 句字幕，播放视频按 F3 / F4 即可打轴！`, "success");
    } else if (res.error) {
      showToast(res.error, "error");
    }
  });

  // 3. AI Modal
  document.getElementById("btnOpenAi").addEventListener("click", () => {
    syncAiModalVisibility();
    openModal("modalAi");
  });

  document.querySelectorAll('input[name="aiWorkflow"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".wf-radio").forEach((lbl) => lbl.classList.remove("active"));
      radio.closest(".wf-radio").classList.add("active");
      syncAiModalVisibility();
    });
  });

  document.getElementById("aiAsrEngine").addEventListener("change", syncAiModalVisibility);
  document.getElementById("aiTransProvider").addEventListener("change", syncAiModalVisibility);

  document.getElementById("btnStartAiRun").addEventListener("click", startAiRun);

  // 4. Undo / Redo / Time Shift
  document.getElementById("btnUndo").addEventListener("click", undo);
  document.getElementById("btnRedo").addEventListener("click", redo);

  document.querySelectorAll("[data-shift]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = Number(btn.dataset.shift);
      if (!state.subtitles.length) return;
      pushUndoSnapshot();
      state.subtitles.forEach((c) => {
        c.start_ms = Math.max(0, c.start_ms + delta);
        c.end_ms = Math.max(c.start_ms + 200, c.end_ms + delta);
      });
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast(`全部字幕已整体平移 ${delta > 0 ? "+" : ""}${(delta / 1000).toFixed(1)} 秒`);
    });
  });

  // 5. Export Modal
  document.getElementById("btnOpenExport").addEventListener("click", () => openModal("modalExport"));

  document.querySelectorAll("#modalExport [data-fmt]").forEach((elItem) => {
    elItem.addEventListener("click", async (e) => {
      // Avoid double trigger when button inside card is clicked
      const card = e.currentTarget;
      const fmt = card.dataset.fmt;
      const lang = card.dataset.lang;
      if (!hasApi()) return;
      const res = await window.pywebview.api.export_subtitle_dialog(
        fmt,
        lang,
        state.subtitles,
        state.style,
        state.videoStem
      );
      if (res.ok) {
        closeModal("modalExport");
        showToast(`导出成功：${res.saved_path}`, "success");
      } else if (res.error) {
        showToast(res.error, "error");
      }
    });
  });

  // 6. Blu-ray PGS (.SUP) Converter & Exporter Modal
  document.getElementById("btnOpenSupTool").addEventListener("click", () => {
    document.getElementById("supLangMode").value = state.langMode || "bilingual";
    openModal("modalSup");
  });

  document.getElementById("cardJumpToSup").addEventListener("click", () => {
    closeModal("modalExport");
    document.getElementById("supLangMode").value = state.langMode || "bilingual";
    openModal("modalSup");
  });

  document.getElementById("btnConvertAssFilesToSup").addEventListener("click", async () => {
    if (!hasApi()) return;
    const resolution = document.getElementById("supResolution").value;
    const fps = document.getElementById("supFps").value;
    const res = await window.pywebview.api.pick_and_convert_ass_to_sup(resolution, fps);
    if (res.ok && res.started) {
      monitorSupTaskProgress();
    } else if (res.error) {
      showToast(res.error, "error");
    }
  });

  document.getElementById("btnExportCurrentToSup").addEventListener("click", async () => {
    if (!hasApi()) return;
    const resolution = document.getElementById("supResolution").value;
    const fps = document.getElementById("supFps").value;
    const langMode = document.getElementById("supLangMode").value;
    const res = await window.pywebview.api.export_current_to_sup_dialog(
      langMode,
      state.subtitles,
      state.style,
      resolution,
      fps,
      state.videoStem
    );
    if (res.ok && res.started) {
      monitorSupTaskProgress();
    } else if (res.error) {
      showToast(res.error, "error");
    }
  });
}

function monitorSupTaskProgress() {
  const progBox = document.getElementById("supProgressBox");
  const progTxt = document.getElementById("supProgressText");
  const progBar = document.getElementById("supProgressBar");
  const btnFiles = document.getElementById("btnConvertAssFilesToSup");
  const btnCur = document.getElementById("btnExportCurrentToSup");

  progBox.classList.remove("hidden");
  btnFiles.disabled = true;
  btnCur.disabled = true;
  progTxt.textContent = "正在启动蓝光 PGS (.sup) 图形渲染引擎…";
  progBar.style.width = "6%";

  if (state.aiPollTimer) clearInterval(state.aiPollTimer);
  state.aiPollTimer = setInterval(async () => {
    const st = await window.pywebview.api.get_task_status();
    if (st.running) {
      progTxt.textContent = st.message || "正在压制蓝光 SUP 字幕…";
      progBar.style.width = `${Math.max(5, st.percent || 8)}%`;
    } else {
      clearInterval(state.aiPollTimer);
      state.aiPollTimer = null;
      btnFiles.disabled = false;
      btnCur.disabled = false;

      if (st.error) {
        progTxt.textContent = st.error;
        showToast(st.error, "error");
      } else {
        progBar.style.width = "100%";
        progTxt.textContent = st.message || "蓝光 SUP 生成完毕！";
        showToast(st.message || "蓝光 SUP 转换完成！", "success");
        setTimeout(() => {
          progBox.classList.add("hidden");
        }, 1400);
      }
    }
  }, 400);
}

function syncAiModalVisibility() {
  const wf = document.querySelector('input[name="aiWorkflow"]:checked')?.value || "asr_and_translate";
  const showAsr = wf === "asr_and_translate" || wf === "asr_only";
  const showTrans = wf === "asr_and_translate" || wf === "translate_only";

  document.getElementById("secAsrConfig").classList.toggle("hidden", !showAsr);
  document.getElementById("secTransConfig").classList.toggle("hidden", !showTrans);

  const asrEngine = document.getElementById("aiAsrEngine").value;
  document.getElementById("wrapLocalModel").classList.toggle("hidden", asrEngine !== "local");
  document.getElementById("wrapAsrApi").classList.toggle("hidden", asrEngine !== "api");

  const transProv = document.getElementById("aiTransProvider").value;
  document.getElementById("wrapLlmApi").classList.toggle("hidden", transProv !== "llm");
}

function populateSettingsUI(s) {
  state.settings = s || {};
  document.getElementById("aiAsrEngine").value = s.asr_engine || "local";
  document.getElementById("aiAsrModelSize").value = s.asr_model_size || "base";
  document.getElementById("aiAsrLang").value = s.asr_source_lang || "en";
  document.getElementById("aiAsrApiBase").value = s.asr_api_base || "https://api.openai.com/v1";
  document.getElementById("aiAsrApiKey").value = s.asr_api_key || "";
  document.getElementById("aiAsrApiModel").value = s.asr_api_model || "whisper-1";

  document.getElementById("aiTransProvider").value = s.trans_provider || "free";
  document.getElementById("aiLlmBase").value = s.llm_base || "https://api.deepseek.com/v1";
  document.getElementById("aiLlmKey").value = s.llm_key || "";
  document.getElementById("aiLlmModel").value = s.llm_model || "deepseek-chat";
  syncAiModalVisibility();
}

function collectSettingsFromUI() {
  return {
    asr_engine: document.getElementById("aiAsrEngine").value,
    asr_model_size: document.getElementById("aiAsrModelSize").value,
    asr_source_lang: document.getElementById("aiAsrLang").value,
    asr_api_base: document.getElementById("aiAsrApiBase").value.trim(),
    asr_api_key: document.getElementById("aiAsrApiKey").value.trim(),
    asr_api_model: document.getElementById("aiAsrApiModel").value.trim(),
    trans_provider: document.getElementById("aiTransProvider").value,
    llm_base: document.getElementById("aiLlmBase").value.trim(),
    llm_key: document.getElementById("aiLlmKey").value.trim(),
    llm_model: document.getElementById("aiLlmModel").value.trim(),
  };
}

async function startAiRun() {
  if (!hasApi()) return;
  const wf = document.querySelector('input[name="aiWorkflow"]:checked')?.value || "asr_and_translate";
  const settings = collectSettingsFromUI();
  const options = {
    settings,
    direction: document.getElementById("aiTransDir").value,
    overwrite: document.getElementById("aiTransOverwrite").checked,
  };

  const res = await window.pywebview.api.start_ai_workflow(wf, state.subtitles, options);
  if (!res.ok) {
    showToast(res.error || "无法启动 AI 任务", "error");
    return;
  }

  const progBox = document.getElementById("aiProgressBox");
  const progTxt = document.getElementById("aiProgressText");
  const progBar = document.getElementById("aiProgressBar");
  const btnStart = document.getElementById("btnStartAiRun");

  progBox.classList.remove("hidden");
  btnStart.disabled = true;
  progTxt.textContent = "正在启动任务…";
  progBar.style.width = "8%";

  if (state.aiPollTimer) clearInterval(state.aiPollTimer);
  state.aiPollTimer = setInterval(async () => {
    const st = await window.pywebview.api.get_task_status();
    if (st.running) {
      progTxt.textContent = st.message || "AI 正在努力处理中…";
      progBar.style.width = `${Math.max(5, st.percent || 10)}%`;
    } else {
      clearInterval(state.aiPollTimer);
      state.aiPollTimer = null;
      btnStart.disabled = false;

      if (st.error) {
        progTxt.textContent = `出错：${st.error}`;
        showToast(st.error, "error");
      } else if (st.result && st.result.subtitles) {
        pushUndoSnapshot();
        state.subtitles = st.result.subtitles;
        state.selectedIdx = 0;
        progBar.style.width = "100%";
        progTxt.textContent = st.message || "完成！";
        renderTable();
        updateSubtitleOverlay();
        drawWaveform();
        showToast(st.message || "AI 双语生成完成！", "success");
        setTimeout(() => {
          progBox.classList.add("hidden");
          closeModal("modalAi");
        }, 700);
      }
    }
  }, 450);
}

// ---------------------------------------------------------------------------
// Transport, Table Toolbar & Global Keyboard Shortcuts
// ---------------------------------------------------------------------------

function bindTransportAndTableTools() {
  el.btnPlayPause.addEventListener("click", togglePlayPause);
  document.getElementById("btnBack2s").addEventListener("click", () => seekToMs(state.currentTimeMs - 2000));
  document.getElementById("btnFwd2s").addEventListener("click", () => seekToMs(state.currentTimeMs + 2000));
  document.getElementById("btnReplayCue").addEventListener("click", replaySelectedCue);

  el.selPlaybackRate.addEventListener("change", () => {
    el.video.playbackRate = Number(el.selPlaybackRate.value || 1);
  });

  el.video.addEventListener("play", syncPlayButtonUI);
  el.video.addEventListener("pause", syncPlayButtonUI);
  el.video.addEventListener("loadedmetadata", () => {
    if (el.video.duration && Number.isFinite(el.video.duration)) {
      state.durationMs = Math.round(el.video.duration * 1000);
      updateTimeReadout();
      drawWaveform();
    }
  });

  document.getElementById("btnMarkStart").addEventListener("click", markCurrentStart);
  document.getElementById("btnMarkEndNext").addEventListener("click", markCurrentEndAndNext);
  document.getElementById("btnAddCueAtPlayhead").addEventListener("click", addCueAtPlayhead);

  el.inpSearch.addEventListener("input", () => {
    state.searchQuery = el.inpSearch.value;
    renderTable();
  });

  // Smart auto-fix ZH/EN column swap if user imported or pasted swapped columns
  document.getElementById("btnSwapAllLang").addEventListener("click", () => {
    const cjkRe = /[\u4e00-\u9fff]/;
    pushUndoSnapshot();
    let fixedCount = 0;
    state.subtitles.forEach((c) => {
      const zhHasCjk = cjkRe.test(c.zh || "");
      const enHasCjk = cjkRe.test(c.en || "");
      if (!zhHasCjk && enHasCjk) {
        const tmp = c.zh;
        c.zh = c.en;
        c.en = tmp;
        fixedCount++;
      }
    });
    renderTable();
    updateSubtitleOverlay();
    showToast(
      fixedCount > 0
        ? `已智能纠正 ${fixedCount} 句填反的中英文分栏！`
        : "检查完毕：所有中英文分栏均已正确归位"
    );
  });

  document.getElementById("btnClearAll").addEventListener("click", () => {
    if (!state.subtitles.length) return;
    pushUndoSnapshot();
    state.subtitles = [];
    state.selectedIdx = 0;
    renderTable();
    updateSubtitleOverlay();
    drawWaveform();
    showToast("已清空字幕列表（可随时按 Ctrl+Z 撤销）");
  });

  // Global Hotkeys
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    // Undo / Redo when not editing inside an input, or Ctrl+Z globally
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inInput) {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !inInput) {
      e.preventDefault();
      redo();
      return;
    }

    // Function-key timing shortcuts work EVEN WHILE TYPING inside subtitle boxes!
    if (e.key === "F2") {
      e.preventDefault();
      togglePlayPause();
      return;
    }
    if (e.key === "F3") {
      e.preventDefault();
      markCurrentStart();
      return;
    }
    if (e.key === "F4") {
      e.preventDefault();
      markCurrentEndAndNext();
      return;
    }
    if (e.key === "F5") {
      e.preventDefault();
      replaySelectedCue();
      return;
    }

    if (inInput) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePlayPause();
    } else if (e.key === "[") {
      e.preventDefault();
      markCurrentStart();
    } else if (e.key === "]") {
      e.preventDefault();
      markCurrentEndAndNext();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekToMs(state.currentTimeMs - 1500);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekToMs(state.currentTimeMs + 1500);
    }
  });
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function initBootstrap() {
  if (hasApi()) {
    const data = await window.pywebview.api.get_initial_bootstrap();
    if (data.presets && data.presets.length) {
      state.presets = data.presets;
      const first = data.presets[0];
      state.activePresetId = first.id;
      state.style = extractStyleFromPreset(first);
    }
    if (data.settings) {
      populateSettingsUI(data.settings);
    }
  } else {
    state.presets = [
      {
        id: "us_drama_default",
        name: "美剧双语经典 (默认)",
        desc: "文泉驿微米黑银灰白 + ITC 暖沙金英文，93%窄字宽与柔边羽化",
        ...structuredClone(state.style),
      },
    ];
  }

  renderPresetCards();
  syncStyleControlsFromState();
  renderTable();
  updateTimeReadout();
  updateSubtitleOverlay();
  drawWaveform();
}

function init() {
  bindStyleEvents();
  bindWaveformEvents();
  bindModalsAndTopbar();
  bindTransportAndTableTools();
  startRealVideoRaf();

  const ro = new ResizeObserver(() => {
    updateSubtitleOverlay();
    drawWaveform();
  });
  ro.observe(el.videoStage);
  ro.observe(el.waveformScroll);

  if (hasApi()) {
    initBootstrap();
  } else {
    window.addEventListener("pywebviewready", initBootstrap, { once: true });
    // Fallback render right away so UI is never blank
    renderTable();
    syncStyleControlsFromState();
    updateTimeReadout();
    updateSubtitleOverlay();
    drawWaveform();
  }
}

init();
