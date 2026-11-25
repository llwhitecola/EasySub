/**
 * EasySub Studio (傻瓜双语字幕工坊) - Frontend Controller
 */

const DEMO_SUBTITLES = [
  {
    id: 1,
    start_ms: 600,
    end_ms: 3800,
    zh: "以前做双语字幕总要记一堆复杂代码",
    en: "Making bilingual subs used to mean complex tags",
  },
  {
    id: 2,
    start_ms: 4200,
    end_ms: 7800,
    zh: "现在点一下右侧卡片 就能切换电影级双语样式",
    en: "Now one click switches to cinema-grade bilingual styles",
  },
  {
    id: 3,
    start_ms: 8200,
    end_ms: 11800,
    zh: "播放时按 F3 设开始 按 F4 设结束并跳下一句",
    en: "Press F3 for start and F4 for end while playing",
  },
  {
    id: 4,
    start_ms: 12200,
    end_ms: 16500,
    zh: "拖入视频点击上方 AI 按钮 全自动听写加翻译!",
    en: "Drop a video in and click AI for auto transcription!",
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
  mediaDurationMs: 0,
  durationMs: 18000,
  currentTimeMs: 1200,
  pendingVideoSeekMs: null,
  lastManualSeekAt: 0,
  lastPlayingIdx: -1,
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
    line_gap: 4,
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
  pxPerSec: 72, // timeline zoom (fits 18s demo comfortably end-to-end)

  undoStack: [],
  redoStack: [],
  dirtyForAutosave: false,
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
  state.dirtyForAutosave = true;
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

function syncDurationFromContent() {
  let maxSubEnd = 0;
  for (let i = 0; i < state.subtitles.length; i++) {
    const e = Number(state.subtitles[i].end_ms) || 0;
    if (e > maxSubEnd) maxSubEnd = e;
  }
  if (state.hasRealVideo && state.mediaDurationMs > 0) {
    state.durationMs = Math.max(state.mediaDurationMs, maxSubEnd + 1000);
  } else {
    state.durationMs = Math.max(maxSubEnd + 3000, 18000);
  }
}

function seekToMs(ms) {
  syncDurationFromContent();
  const clamped = Math.max(0, Math.min(state.durationMs || 36000000, Math.round(ms)));
  state.currentTimeMs = clamped;
  state.lastManualSeekAt = performance.now();
  if (state.hasRealVideo) {
    if (el.video.readyState >= 1) {
      state.pendingVideoSeekMs = null;
      try {
        el.video.currentTime = clamped / 1000;
      } catch (_) {}
    } else {
      state.pendingVideoSeekMs = clamped;
    }
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

function startPlaybackFromCurrentPos() {
  if (state.hasRealVideo) {
    if (state.pendingVideoSeekMs === null && el.video.readyState >= 1) {
      const diffSec = Math.abs(el.video.currentTime - state.currentTimeMs / 1000);
      if (diffSec > 0.25) {
        try {
          el.video.currentTime = state.currentTimeMs / 1000;
        } catch (_) {}
      }
    }
    const p = el.video.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } else {
    syncDurationFromContent();
    const wasPlaying = state.demoPlaying;
    state.demoPlaying = true;
    state.demoLastTick = performance.now();
    syncPlayButtonUI();
    if (!wasPlaying) requestAnimationFrame(demoLoopTick);
  }
}

function togglePlayPause() {
  syncDurationFromContent();
  if (state.hasRealVideo) {
    if (el.video.paused) {
      if (state.currentTimeMs >= state.durationMs - 100) {
        seekToMs(0);
      }
      startPlaybackFromCurrentPos();
    } else {
      el.video.pause();
    }
  } else {
    if (state.demoPlaying) {
      state.demoPlaying = false;
      syncPlayButtonUI();
    } else {
      if (state.currentTimeMs >= state.durationMs - 100) {
        state.currentTimeMs = 0;
      }
      startPlaybackFromCurrentPos();
    }
  }
}

function syncPlayButtonUI() {
  const playing = isPlaying();
  el.btnPlayPause.textContent = playing ? "⏸ 暂停" : "▶ 播放";
  const hero = document.getElementById("dropHeroCard");
  if (hero) hero.classList.toggle("faded", playing);
}

function demoLoopTick(now) {
  if (!state.demoPlaying || state.hasRealVideo) return;
  const dt = Math.min(120, Math.max(0, now - state.demoLastTick)) * Number(el.selPlaybackRate.value || 1);
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
  startPlaybackFromCurrentPos();
}

function updateTimeReadout() {
  el.curTimeLabel.textContent = formatDisplayTime(state.currentTimeMs);
  el.durTimeLabel.textContent = formatDisplayTime(state.durationMs);
}

// Smooth playhead animation for real HTML5 video
function startRealVideoRaf() {
  function tick() {
    if (state.hasRealVideo && !el.video.paused && !el.video.seeking && state.pendingVideoSeekMs === null) {
      const videoMs = Math.round(el.video.currentTime * 1000);
      const sinceManual = performance.now() - state.lastManualSeekAt;
      if (sinceManual > 220 || Math.abs(videoMs - state.currentTimeMs) < 1200) {
        state.currentTimeMs = videoMs;
        handleSingleCueLoopCheck();
        updateTimeReadout();
        updateSubtitleOverlay();
        highlightPlayingRow();
        ensurePlayheadVisible(true);
        drawWaveform();
      }
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
    if (c.pos !== "top" && ms >= c.start_ms && ms <= c.end_ms) return { cue: c, idx: i };
  }
  return null;
}

function findActiveTopNoteAt(ms) {
  for (let i = 0; i < state.subtitles.length; i++) {
    const c = state.subtitles[i];
    if (c.pos === "top" && ms >= c.start_ms && ms <= c.end_ms) return { cue: c, idx: i };
  }
  return null;
}

function updateSubtitleOverlay() {
  const stageH = el.videoStage.clientHeight || 360;
  const scale = stageH / 1080; // Matches PlayResY: 1080 in exported .ass!
  const blurVal = Number(state.style.blur ?? 2.0);

  // 1. Render Top-Screen Annotation (注释-雅黑 / \an8) if active at current time
  const topOverlay = document.getElementById("subtitleOverlayTop");
  const topNoteEl = document.getElementById("subLineTopNote");
  const activeTop = findActiveTopNoteAt(state.currentTimeMs);
  if (topOverlay && topNoteEl) {
    topOverlay.style.top = `${Math.round(40 * scale)}px`;
    if (activeTop) {
      const tZh = (activeTop.cue.zh || "").trim();
      const tEn = (activeTop.cue.en || "").trim();
      const noteText = [tZh, tEn].filter(Boolean).join("\n");
      if (noteText) {
        topNoteEl.style.display = "block";
        topNoteEl.textContent = noteText;
        applyLineStyle(
          topNoteEl,
          {
            font: "Microsoft YaHei",
            size: 75,
            color: state.style.zh.color || "#B7B7B7",
            outline_color: "#000000",
            outline: 1.0,
            shadow: 1.0,
            scale_x: 90,
            bold: true,
            italic: false,
          },
          scale,
          false,
          blurVal
        );
      } else {
        topNoteEl.style.display = "none";
      }
    } else {
      topNoteEl.style.display = "none";
    }
  }

  // 2. Render Bottom Bilingual Dialogue
  el.subtitleOverlay.style.bottom = `${Math.round(state.style.margin_v * scale)}px`;
  el.subBoxWrap.style.gap = "0px";

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

  if (topTxt) {
    el.subLineTop.style.display = "block";
    el.subLineTop.textContent = topTxt;
    applyLineStyle(el.subLineTop, topCfg, scale, state.style.box_mode, blurVal);
  } else {
    el.subLineTop.style.display = "none";
  }

  if (bottomTxt) {
    const lineGap = Number(state.style.line_gap ?? 4);
    el.subLineBottom.style.display = "block";
    el.subLineBottom.textContent = bottomTxt;
    el.subLineBottom.style.marginTop = topTxt
      ? `${((lineGap - 3.5) * scale).toFixed(1)}px`
      : "0px";
    applyLineStyle(el.subLineBottom, bottomCfg, scale, state.style.box_mode, blurVal);
  } else {
    el.subLineBottom.style.display = "none";
    el.subLineBottom.style.marginTop = "0px";
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
  delete copy.is_custom;
  if (copy.line_gap === undefined) copy.line_gap = 4;
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
  const footerEl = document.getElementById("activePresetFooter");

  state.presets.forEach((p) => {
    const isActive = p.id === state.activePresetId;
    if (isActive && footerEl) {
      footerEl.textContent = `🎨 当前模板：${p.name}`;
    }
    const card = document.createElement("div");
    card.className = `preset-card ${isActive ? "active" : ""}`;
    const topIsZh = p.order !== "en_top";
    const firstColor = topIsZh ? p.zh.color : p.en.color;
    const secondColor = topIsZh ? p.en.color : p.zh.color;
    const boxBg = p.box_mode
      ? hexToRgba(p.box_color, p.box_opacity)
      : "linear-gradient(180deg, #0d1526 0%, #060911 100%)";

    card.title = p.desc || p.name;
    card.innerHTML = `
      ${p.is_custom ? '<button class="btn-del-preset" title="删除此自定义模板">✕</button>' : ""}
      ${isActive ? '<span class="preset-badge-active">当前</span>' : ""}
      <div class="preset-preview-mini" style="background:${boxBg}">
        <div style="color:${firstColor};font-weight:700;font-size:11px;text-shadow:0 1px 2px #000;">${topIsZh ? "双语字幕" : "Subtitle"}</div>
        <div style="color:${secondColor};font-size:9.5px;text-shadow:0 1px 2px #000;">${topIsZh ? "Subtitle" : "双语字幕"}</div>
      </div>
      <div class="preset-name">${p.name}</div>
    `;
    const delBtn = card.querySelector(".btn-del-preset");
    if (delBtn) {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!hasApi()) return;
        const res = await window.pywebview.api.delete_custom_preset(p.id);
        if (res.ok) {
          state.presets = res.presets;
          if (state.activePresetId === p.id && state.presets.length) {
            state.activePresetId = state.presets[0].id;
            state.style = extractStyleFromPreset(state.presets[0]);
            syncStyleControlsFromState();
            updateSubtitleOverlay();
          }
          renderPresetCards();
          showToast(`已删除自定义模板：${p.name}`);
        }
      });
    }
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

  const gapVal = s.line_gap ?? 4;
  document.getElementById("rngLineGap").value = gapVal;
  document.getElementById("lblLineGap").textContent = gapVal;

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

  document.getElementById("rngLineGap").addEventListener("input", (e) => {
    state.style.line_gap = Number(e.target.value);
    document.getElementById("lblLineGap").textContent = state.style.line_gap;
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
  const pps = getEffectivePxPerSec();
  const x = (state.currentTimeMs / 1000) * pps;
  const sc = el.waveformScroll;
  const viewLeft = sc.scrollLeft;
  const viewRight = viewLeft + sc.clientWidth;
  if (x < viewLeft + 40 || x > viewRight - 60) {
    sc.scrollLeft = Math.max(0, x - sc.clientWidth * (smoothFollow ? 0.25 : 0.45));
  }
}

function formatRulerTick(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function drawWaveform() {
  const canvas = el.waveformCanvas;
  const scrollWrap = el.waveformScroll;
  const totalSec = getTimelineTotalDurationSec();
  const desiredW = Math.max(scrollWrap.clientWidth, Math.ceil(totalSec * state.pxPerSec));
  const maxCanvasW = 32000;
  const effectivePxPerSec = desiredW > maxCanvasW ? maxCanvasW / totalSec : state.pxPerSec;
  const width = Math.max(scrollWrap.clientWidth, Math.ceil(totalSec * effectivePxPerSec));
  const height = 86;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  // Track background
  ctx.fillStyle = "#060912";
  ctx.fillRect(0, 0, width, height);

  // Top ruler band
  ctx.fillStyle = "#0b1120";
  ctx.fillRect(0, 0, width, 20);
  ctx.fillStyle = "rgba(148, 163, 184, 0.14)";
  ctx.fillRect(0, 20, width, 1);

  // Center zero-axis line
  const midY = 54;
  ctx.strokeStyle = "rgba(56, 189, 248, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY + 0.5);
  ctx.lineTo(width, midY + 0.5);
  ctx.stroke();

  const visLeftPx = Math.max(0, scrollWrap.scrollLeft - 140);
  const visRightPx = scrollWrap.scrollLeft + scrollWrap.clientWidth + 140;

  // Adaptive time ticks (never overlap even on 3-hour movies!)
  const tickCandidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
  let stepSec = 900;
  for (const cand of tickCandidates) {
    if (cand * effectivePxPerSec >= 72) {
      stepSec = cand;
      break;
    }
  }
  ctx.font = "10px Consolas, monospace";
  ctx.fillStyle = "#8b9bb4";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";

  const firstTick = Math.max(0, Math.floor(visLeftPx / effectivePxPerSec / stepSec) * stepSec);
  const lastTick = Math.min(totalSec, Math.ceil(visRightPx / effectivePxPerSec));
  for (let s = firstTick; s <= lastTick; s += stepSec) {
    const x = Math.round(s * effectivePxPerSec) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(formatRulerTick(s), x + 4, 13.5);
  }

  // Symmetrical gradient audio waveform
  const peaks = state.waveform?.peaks || [];
  const pps = state.waveform?.peaks_per_sec || 25;
  if (peaks.length > 0) {
    const maxAmp = 28;
    const waveGrad = ctx.createLinearGradient(0, midY - maxAmp, 0, midY + maxAmp);
    waveGrad.addColorStop(0, "rgba(129, 140, 248, 0.52)");
    waveGrad.addColorStop(0.5, "rgba(56, 189, 248, 0.42)");
    waveGrad.addColorStop(1, "rgba(129, 140, 248, 0.52)");
    ctx.fillStyle = waveGrad;

    const stepPx = Math.max(2, effectivePxPerSec / pps);
    const barW = Math.max(1.4, stepPx - 0.8);
    const visibleStartSec = Math.max(0, scrollWrap.scrollLeft / effectivePxPerSec - 2);
    const visibleEndSec = (scrollWrap.scrollLeft + scrollWrap.clientWidth) / effectivePxPerSec + 2;
    const iStart = Math.max(0, Math.floor(visibleStartSec * pps));
    const iEnd = Math.min(peaks.length - 1, Math.ceil(visibleEndSec * pps));

    for (let i = iStart; i <= iEnd; i++) {
      const sec = i / pps;
      const x = sec * effectivePxPerSec;
      const h = Math.max(2, (peaks[i] / 100) * maxAmp * 2);
      ctx.fillRect(x, midY - h / 2, barW, h);
    }
  }

  // Subtitle regions (viewport-culled for silky 60fps on 2000+ cues!)
  state.subtitles.forEach((cue, idx) => {
    const x1 = (cue.start_ms / 1000) * effectivePxPerSec;
    const x2 = Math.max(x1 + 6, (cue.end_ms / 1000) * effectivePxPerSec);
    if (x2 < visLeftPx || x1 > visRightPx) return;
    const w = x2 - x1;
    const isSel = idx === state.selectedIdx;
    const isTop = cue.pos === "top";

    ctx.fillStyle = isSel
      ? "rgba(37, 99, 235, 0.34)"
      : isTop
      ? "rgba(6, 182, 212, 0.22)"
      : "rgba(99, 102, 241, 0.16)";
    ctx.strokeStyle = isSel
      ? "#60a5fa"
      : isTop
      ? "rgba(34, 211, 238, 0.5)"
      : "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = isSel ? 1.5 : 1;

    ctx.beginPath();
    ctx.roundRect(x1, 24, w, 56, 5);
    ctx.fill();
    ctx.stroke();

    // Top accent strip
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x1, 24, w, 56, 5);
    ctx.clip();
    ctx.fillStyle = isSel ? "#3b82f6" : isTop ? "#06b6d4" : "rgba(139, 92, 246, 0.55)";
    ctx.fillRect(x1, 24, w, 3);

    if (isSel) {
      ctx.fillStyle = "#93c5fd";
      ctx.fillRect(x1, 24, 3, 56);
      ctx.fillRect(x2 - 3, 24, 3, 56);
    }

    if (w > 28) {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 11px 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";
      const prefix = isTop ? `[顶#${cue.id}] ` : `#${cue.id} `;
      const label = cue.zh || cue.en || "";
      ctx.fillText(`${prefix}${label}`, x1 + 6, 42);
      if (cue.zh && cue.en) {
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "10px 'Segoe UI', sans-serif";
        ctx.fillText(cue.en, x1 + 6, 58);
      }
    }
    ctx.restore();
  });

  // Translucent Playhead needle + ruler-contained timecode pill
  const playX = (state.currentTimeMs / 1000) * effectivePxPerSec;
  ctx.strokeStyle = "rgba(244, 63, 94, 0.72)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(playX, 18);
  ctx.lineTo(playX, height);
  ctx.stroke();

  const tcText = formatDisplayTime(state.currentTimeMs);
  ctx.font = "bold 9.5px Consolas, monospace";
  const badgeW = ctx.measureText(tcText).width + 10;
  const badgeX = Math.max(2, Math.min(width - badgeW - 2, playX - badgeW / 2));
  ctx.fillStyle = "#e11d48";
  ctx.beginPath();
  ctx.roundRect(badgeX, 2, badgeW, 15, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(tcText, badgeX + 5, 12.5);
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
  const prevIdx = state.selectedIdx;
  state.selectedIdx = idx;
  if (prevIdx !== idx) {
    el.subTableBody.querySelector(`.sub-row[data-idx="${prevIdx}"]`)?.classList.remove("selected");
  }
  el.subTableBody.querySelector(`.sub-row[data-idx="${idx}"]`)?.classList.add("selected");
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
  if (activeIdx === state.lastPlayingIdx) return;
  if (state.lastPlayingIdx >= 0) {
    el.subTableBody.querySelector(`.sub-row[data-idx="${state.lastPlayingIdx}"]`)?.classList.remove("playing-now");
  }
  state.lastPlayingIdx = activeIdx;
  if (activeIdx >= 0) {
    el.subTableBody.querySelector(`.sub-row[data-idx="${activeIdx}"]`)?.classList.add("playing-now");
  }
}

function formatDurSec(startMs, endMs) {
  return `${Math.max(0, (endMs - startMs) / 1000).toFixed(1)}s`;
}

function syncSingleRowTimeInputs(idx) {
  const row = el.subTableBody.querySelector(`.sub-row[data-idx="${idx}"]`);
  if (!row) return;
  const cue = state.subtitles[idx];
  const inputs = row.querySelectorAll(".time-input");
  if (inputs[0]) inputs[0].value = formatDisplayTime(cue.start_ms);
  if (inputs[1]) inputs[1].value = formatDisplayTime(cue.end_ms);
  const durEl = row.querySelector(".dur-badge");
  if (durEl) {
    const durMs = cue.end_ms - cue.start_ms;
    durEl.textContent = formatDurSec(cue.start_ms, cue.end_ms);
    durEl.classList.toggle("warn", durMs < 750);
  }
}

const ROW_ICONS = {
  play: `<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
  topPin: `<svg viewBox="0 0 24 24"><path d="M5 4h14M12 20V8m-5 5 5-5 5 5"/></svg>`,
  trans: `<svg viewBox="0 0 24 24"><path d="m5 8 6 6m-7 0 6-6 2-3M2 5h12M7 2h1m14 20-5-10-5 10m2-4h6"/></svg>`,
  split: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>`,
  insert: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  merge: `<svg viewBox="0 0 24 24"><path d="M8 6h13M8 18h13M3 6v12m0 0 3-3m-3 3-3-3"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>`,
};

function checkLineLengthWarn(zhInp, enInp) {
  const zhLen = (zhInp.value || "").replace(/\s+/g, "").length;
  const enLen = (enInp.value || "").trim().length;
  zhInp.classList.toggle("too-long", zhLen > 28);
  zhInp.title = zhLen > 28 ? `当前中文 ${zhLen} 字，单行可能放不下，建议点右侧剪刀图标拆成两句` : "";
  enInp.classList.toggle("too-long", enLen > 84);
  enInp.title = enLen > 84 ? `当前英文 ${enLen} 字符，单行可能放不下，建议点右侧剪刀图标拆成两句` : "";
}

function renderTable() {
  syncDurationFromContent();
  updateTimeReadout();
  state.lastPlayingIdx = -1;
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
    const durMs = cue.end_ms - cue.start_ms;
    const isTop = cue.pos === "top";

    row.innerHTML = `
      <div class="col-idx">${cue.id}</div>
      <div class="time-cell">
        <input type="text" class="time-input t-start" value="${formatDisplayTime(cue.start_ms)}" title="开始时间 (格式 分:秒.毫秒)" />
        <span class="time-arrow">→</span>
        <input type="text" class="time-input t-end" value="${formatDisplayTime(cue.end_ms)}" title="结束时间" />
        <span class="dur-badge ${durMs < 750 ? "warn" : ""}" title="本句持续时长">${formatDurSec(cue.start_ms, cue.end_ms)}</span>
      </div>
      <div>
        <input type="text" class="sub-input zh-inp" placeholder="输入中文台词…" />
      </div>
      <div>
        <input type="text" class="sub-input en-inp" placeholder="Enter English subtitle…" />
      </div>
      <div class="row-ops">
        <button class="op-btn act-play" title="定位并播放本句">${ROW_ICONS.play}</button>
        <button class="op-btn act-pos ${isTop ? "top-active" : ""}" title="切换位置：底部对白 ⇄ 顶部屏幕注释 (注释-雅黑)">${isTop ? "顶" : ROW_ICONS.topPin}</button>
        <button class="op-btn act-trans" title="AI 单句互译补全 (自动应用专有名词表)">${ROW_ICONS.trans}</button>
        <button class="op-btn act-split" title="智能拆句：将过长的本句按比例一分为二">${ROW_ICONS.split}</button>
        <button class="op-btn act-insert" title="在下方插入新行">${ROW_ICONS.insert}</button>
        <button class="op-btn act-merge" title="与下一句合并">${ROW_ICONS.merge}</button>
        <button class="op-btn danger act-del" title="删除本句">${ROW_ICONS.trash}</button>
      </div>
    `;

    const zhInp = row.querySelector(".zh-inp");
    const enInp = row.querySelector(".en-inp");
    zhInp.value = cue.zh || "";
    enInp.value = cue.en || "";
    checkLineLengthWarn(zhInp, enInp);

    row.addEventListener("mousedown", (e) => {
      if (e.target.closest(".row-ops")) return;
      const isIdxCell = Boolean(e.target.closest(".col-idx"));
      const isTextInput = e.target.classList.contains("sub-input") || e.target.classList.contains("time-input");
      if (isIdxCell) {
        selectRow(idx, false);
        seekToMs(cue.start_ms + 20);
        return;
      }
      if (state.selectedIdx !== idx) {
        selectRow(idx, !isTextInput || el.chkSeekOnClick.checked);
      } else if (!isTextInput && el.chkSeekOnClick.checked) {
        seekToMs(cue.start_ms + 20);
      } else if (isTextInput && el.chkSeekOnClick.checked && (state.currentTimeMs < cue.start_ms || state.currentTimeMs > cue.end_ms)) {
        seekToMs(cue.start_ms + 20);
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
        syncDurationFromContent();
        updateTimeReadout();
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
        syncDurationFromContent();
        updateTimeReadout();
        syncSingleRowTimeInputs(idx);
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
      checkLineLengthWarn(zhInp, enInp);
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

    row.querySelector(".act-pos").addEventListener("click", () => {
      pushUndoSnapshot();
      cue.pos = cue.pos === "top" ? "bottom" : "top";
      if (cue.pos === "bottom") delete cue.pos;
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast(
        cue.pos === "top"
          ? `第 #${cue.id} 句已设为「顶部屏幕注释 (注释-雅黑)」`
          : `第 #${cue.id} 句已恢复为「底部双语对白」`,
        "success"
      );
    });

    row.querySelector(".act-split").addEventListener("click", async () => {
      if (!hasApi()) return;
      const res = await window.pywebview.api.split_cue_item(cue);
      if (res.ok && res.parts && res.parts.length === 2) {
        pushUndoSnapshot();
        state.subtitles.splice(idx, 1, res.parts[0], res.parts[1]);
        reindexSubtitles();
        state.selectedIdx = idx;
        renderTable();
        updateSubtitleOverlay();
        drawWaveform();
        showToast(`已将第 #${idx + 1} 句按比例智能拆分为两句！`, "success");
      }
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
  state.pendingVideoSeekMs = null;
  state.videoName = res.video_name;
  state.videoStem = res.video_stem || "双语字幕";
  state.mediaDurationMs = res.duration_ms > 0 ? res.duration_ms : 0;
  syncDurationFromContent();

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
      if (wf.duration_ms > state.mediaDurationMs) {
        state.mediaDurationMs = wf.duration_ms;
        syncDurationFromContent();
      }
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
      if (!isPlaying() && state.subtitles.length) {
        seekToMs(state.subtitles[0].start_ms + 20);
      } else {
        updateSubtitleOverlay();
        drawWaveform();
      }
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
      if (!isPlaying() && state.subtitles.length) {
        seekToMs(state.subtitles[0].start_ms + 20);
      } else {
        updateSubtitleOverlay();
        drawWaveform();
      }
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
  document.getElementById("aiGlossary").value = s.trans_glossary || "";
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
    trans_glossary: document.getElementById("aiGlossary").value.trim(),
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
      state.mediaDurationMs = Math.round(el.video.duration * 1000);
      syncDurationFromContent();
      updateTimeReadout();
      drawWaveform();
    }
    if (state.pendingVideoSeekMs !== null) {
      const targetSec = state.pendingVideoSeekMs / 1000;
      state.pendingVideoSeekMs = null;
      try {
        el.video.currentTime = targetSec;
      } catch (_) {}
    }
  });
  el.video.addEventListener("error", () => {
    if (!state.hasRealVideo) return;
    state.hasRealVideo = false;
    state.pendingVideoSeekMs = null;
    el.demoBackdrop.classList.remove("hidden");
    syncDurationFromContent();
    updateTimeReadout();
    showToast("当前系统解码器暂不支持直接预览该视频编码，已切换为时间轴画布模式（字幕预览、打轴、AI 听写与导出均正常可用）");
  });

  document.getElementById("btnMarkStart").addEventListener("click", markCurrentStart);
  document.getElementById("btnMarkEndNext").addEventListener("click", markCurrentEndAndNext);
  document.getElementById("btnAddCueAtPlayhead").addEventListener("click", addCueAtPlayhead);

  el.inpSearch.addEventListener("input", () => {
    state.searchQuery = el.inpSearch.value;
    renderTable();
  });

  // Save Custom Style Preset
  document.getElementById("btnSaveCustomPreset")?.addEventListener("click", async () => {
    if (!hasApi()) return;
    const nameInp = document.getElementById("inpCustomPresetName");
    const nameVal = (nameInp.value || "").trim() || "我的专属美剧样式";
    const res = await window.pywebview.api.save_custom_preset(nameVal, state.style);
    if (res.ok) {
      state.presets = res.presets;
      state.activePresetId = res.new_id;
      nameInp.value = "";
      renderPresetCards();
      showToast(`已永久收藏模板：「${nameVal}」！`, "success");
    }
  });

  // 1-Click US Drama Punctuation Cleanup
  document.getElementById("btnCleanPunct")?.addEventListener("click", async () => {
    if (!hasApi() || !state.subtitles.length) return;
    const res = await window.pywebview.api.clean_us_drama_punctuation(state.subtitles);
    if (res.ok) {
      if (res.changed_count === 0) {
        showToast("检查完毕：所有标点均已符合美剧无句号空格规范！");
        return;
      }
      pushUndoSnapshot();
      state.subtitles = res.subtitles;
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      showToast(`已规范化清洗 ${res.changed_count} 句台词标点！（可按 Ctrl+Z 撤销）`, "success");
    }
  });

  // Batch Find & Replace (Ctrl+H)
  const updateFindMatchPreview = () => {
    const findStr = document.getElementById("inpFindText").value;
    const scope = document.getElementById("selFindScope").value;
    const caseSens = document.getElementById("chkFindCase").checked;
    const lbl = document.getElementById("lblFindCount");
    if (!findStr) {
      lbl.textContent = "请输入要查找的词句…";
      return;
    }
    const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, caseSens ? "g" : "gi");
    let count = 0;
    state.subtitles.forEach((c) => {
      if (scope === "both" || scope === "zh") {
        count += ((c.zh || "").match(re) || []).length;
      }
      if (scope === "both" || scope === "en") {
        count += ((c.en || "").match(re) || []).length;
      }
    });
    lbl.textContent = count > 0 ? `共找到 ${count} 处匹配项` : "未找到匹配项";
  };

  document.getElementById("btnOpenFindReplace")?.addEventListener("click", () => {
    updateFindMatchPreview();
    openModal("modalFindReplace");
    setTimeout(() => document.getElementById("inpFindText")?.focus(), 40);
  });

  ["inpFindText", "selFindScope", "chkFindCase"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateFindMatchPreview);
    document.getElementById(id)?.addEventListener("change", updateFindMatchPreview);
  });

  document.getElementById("btnRunReplaceAll")?.addEventListener("click", () => {
    const findStr = document.getElementById("inpFindText").value;
    const repStr = document.getElementById("inpReplaceText").value;
    const scope = document.getElementById("selFindScope").value;
    const caseSens = document.getElementById("chkFindCase").checked;
    if (!findStr) {
      showToast("请先输入查找内容");
      return;
    }
    const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, caseSens ? "g" : "gi");
    let replacedTotal = 0;
    let snapshotDone = false;

    state.subtitles.forEach((c) => {
      if (scope === "both" || scope === "zh") {
        const matches = ((c.zh || "").match(re) || []).length;
        if (matches > 0) {
          if (!snapshotDone) {
            pushUndoSnapshot();
            snapshotDone = true;
          }
          c.zh = (c.zh || "").replace(re, repStr);
          replacedTotal += matches;
        }
      }
      if (scope === "both" || scope === "en") {
        const matches = ((c.en || "").match(re) || []).length;
        if (matches > 0) {
          if (!snapshotDone) {
            pushUndoSnapshot();
            snapshotDone = true;
          }
          c.en = (c.en || "").replace(re, repStr);
          replacedTotal += matches;
        }
      }
    });

    if (replacedTotal > 0) {
      renderTable();
      updateSubtitleOverlay();
      drawWaveform();
      updateFindMatchPreview();
      showToast(`已成功批量替换 ${replacedTotal} 处内容！（支持 Ctrl+Z 撤销）`, "success");
    } else {
      showToast("没有找到可替换的匹配内容");
    }
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

    // Ctrl+H opens Find & Replace globally (even when inside inputs!)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
      e.preventDefault();
      document.getElementById("btnOpenFindReplace")?.click();
      return;
    }

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
    if (data.autosave_meta && data.autosave_meta.count > 0) {
      const btnRestore = document.getElementById("btnRestoreAutosave");
      if (btnRestore) {
        btnRestore.textContent = `📂 恢复上次草稿 (${data.autosave_meta.count}句 · ${data.autosave_meta.saved_at})`;
        btnRestore.classList.remove("hidden");
        btnRestore.onclick = async () => {
          const r = await window.pywebview.api.load_autosave_draft();
          if (r.ok && r.draft) {
            pushUndoSnapshot();
            if (r.draft.style) {
              state.style = extractStyleFromPreset(r.draft.style);
              syncStyleControlsFromState();
            }
            if (r.draft.subtitles && r.draft.subtitles.length) {
              state.subtitles = r.draft.subtitles;
              state.selectedIdx = 0;
            }
            if (r.draft.video_path) {
              const vRes = await window.pywebview.api.load_video_by_path(r.draft.video_path);
              if (vRes && vRes.ok) await handleVideoLoadedResponse(vRes);
            }
            btnRestore.classList.add("hidden");
            renderTable();
            updateSubtitleOverlay();
            drawWaveform();
            showToast(`已成功恢复上次草稿（共 ${state.subtitles.length} 句）！`, "success");
          }
        };
      }
    }

    // Start 25-second background crash-recovery autosave loop
    setInterval(async () => {
      if (!state.dirtyForAutosave || !hasApi() || !state.subtitles.length) return;
      state.dirtyForAutosave = false;
      const res = await window.pywebview.api.save_autosave_draft({
        video_name: state.videoName,
        style: state.style,
        subtitles: state.subtitles,
      });
      if (res && res.ok) {
        const stEl = document.getElementById("autosaveStatusText");
        if (stEl) stEl.textContent = `💾 已自动暂存 ${res.saved_at}`;
        document.getElementById("btnRestoreAutosave")?.classList.add("hidden");
      }
    }, 25000);
  } else {
    state.presets = [
      {
        id: "us_drama_default",
        name: "美剧双语经典",
        desc: "文泉驿微米黑银灰白 + ITC 暖沙金英文，93%窄字宽与柔边羽化",
        ...structuredClone(state.style),
      },
      {
        id: "cinema_classic",
        name: "经典蓝光亮白",
        desc: "纯白中文 + 浅灰英文",
        order: "zh_top", margin_v: 42, line_gap: 4, blur: 0.8, box_mode: false, box_color: "#000000", box_opacity: 0.55,
        zh: { font: "Microsoft YaHei", size: 58, color: "#FFFFFF", outline_color: "#111827", outline: 2.4, shadow: 1.6, scale_x: 100, bold: true, italic: false },
        en: { font: "Segoe UI", size: 36, color: "#E2E8F0", outline_color: "#111827", outline: 1.8, shadow: 1.4, scale_x: 100, bold: false, italic: false },
      },
      {
        id: "doc_immersive_box",
        name: "纪录片黑底盒",
        desc: "半透明暗黑衬底条",
        order: "zh_top", margin_v: 48, line_gap: 4, blur: 0, box_mode: true, box_color: "#0F172A", box_opacity: 0.72,
        zh: { font: "Microsoft YaHei", size: 52, color: "#FFFFFF", outline_color: "#0F172A", outline: 1.5, shadow: 0, scale_x: 100, bold: true, italic: false },
        en: { font: "Segoe UI", size: 32, color: "#CBD5E1", outline_color: "#0F172A", outline: 1.2, shadow: 0, scale_x: 100, bold: false, italic: false },
      },
      {
        id: "art_house",
        name: "文艺电影极简",
        desc: "宋体衬线 + 柔和投影",
        order: "zh_top", margin_v: 54, line_gap: 5, blur: 1, box_mode: false, box_color: "#000000", box_opacity: 0.5,
        zh: { font: "SimSun", size: 52, color: "#FAF8F5", outline_color: "#1E1E1E", outline: 1.8, shadow: 2.2, scale_x: 100, bold: true, italic: false },
        en: { font: "Georgia", size: 33, color: "#E7E5E4", outline_color: "#1E1E1E", outline: 1.5, shadow: 1.8, scale_x: 100, bold: false, italic: true },
      },
      {
        id: "ted_talk",
        name: "TED 公开课风",
        desc: "醒目纯白中文 + 暖橙英文",
        order: "zh_top", margin_v: 46, line_gap: 4, blur: 1, box_mode: false, box_color: "#000000", box_opacity: 0.5,
        zh: { font: "Microsoft YaHei", size: 56, color: "#FFFFFF", outline_color: "#0F172A", outline: 3.0, shadow: 1.6, scale_x: 100, bold: true, italic: false },
        en: { font: "Segoe UI", size: 35, color: "#FDBA74", outline_color: "#0F172A", outline: 2.4, shadow: 1.4, scale_x: 100, bold: true, italic: false },
      },
      {
        id: "english_learner",
        name: "英语学习主英",
        desc: "英文大字在上，中文小字在下",
        order: "en_top", margin_v: 48, line_gap: 4, blur: 1, box_mode: false, box_color: "#000000", box_opacity: 0.5,
        zh: { font: "Microsoft YaHei", size: 36, color: "#CBD5E1", outline_color: "#0F172A", outline: 2.0, shadow: 1.2, scale_x: 100, bold: false, italic: false },
        en: { font: "Segoe UI", size: 50, color: "#FEF08A", outline_color: "#0F172A", outline: 2.8, shadow: 1.8, scale_x: 100, bold: true, italic: false },
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

function bindSceneAndSplitter() {
  // Sub-tabs inside Custom Font/Color Studio (🇨🇳 中文精调 / 🇬🇧 英文精调)
  document.querySelectorAll("#customLangTabs .lang-sub-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#customLangTabs .lang-sub-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.langcard;
      document.getElementById("cardLangZh")?.classList.toggle("hidden", target !== "zh");
      document.getElementById("cardLangEn")?.classList.toggle("hidden", target !== "en");
    });
  });

  // Demo Scene Brightness Tester (Dark / Warm / Bright snow)
  document.querySelectorAll(".scene-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".scene-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      el.demoBackdrop.classList.remove("scene-dark", "scene-warm", "scene-bright");
      el.demoBackdrop.classList.add(chip.dataset.scene);
    });
  });

  // Click empty-stage hero card or header status pill to open video
  document.getElementById("dropHeroCard")?.addEventListener("click", () => {
    document.getElementById("btnOpenVideo")?.click();
  });
  el.mediaStatusText?.addEventListener("click", () => {
    document.getElementById("btnOpenVideo")?.click();
  });

  // Interactive Vertical Splitter for resizing Video/Style Deck vs Table Deck
  const splitter = document.getElementById("deckSplitter");
  const upperDeck = document.getElementById("upperDeck");
  if (!splitter || !upperDeck) return;

  let resizing = false;
  let startY = 0;
  let startH = 0;

  splitter.addEventListener("mousedown", (e) => {
    resizing = true;
    startY = e.clientY;
    startH = upperDeck.getBoundingClientRect().height;
    splitter.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const maxH = Math.floor(window.innerHeight * 0.62);
    const nextH = Math.max(235, Math.min(maxH, startH + (e.clientY - startY)));
    upperDeck.style.height = `${nextH}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    splitter.classList.remove("dragging");
    document.body.style.cursor = "";
  });
}

function init() {
  bindStyleEvents();
  bindWaveformEvents();
  bindModalsAndTopbar();
  bindTransportAndTableTools();
  bindSceneAndSplitter();
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
    let bootstrapped = false;
    const runOnce = () => {
      if (bootstrapped) return;
      bootstrapped = true;
      initBootstrap();
    };
    window.addEventListener("pywebviewready", runOnce, { once: true });
    // Plain-browser preview fallback (no desktop bridge): still show preset cards
    setTimeout(() => { if (!hasApi()) runOnce(); }, 500);
    // Fallback render right away so UI is never blank
    renderTable();
    syncStyleControlsFromState();
    updateTimeReadout();
    updateSubtitleOverlay();
    drawWaveform();
  }
}

init();
