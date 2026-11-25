/**
 * Lyrics Effects Workshop UI Controller (#modalLyrics)
 *
 * Implements the 3-entry Narrative Aesthetics & Bilingual Lyrics Batch workflow:
 *   1. 创作引导 (Guide): 3 narrative questions -> TOP 3 master bundle recommendations
 *   2. 精细调节 (Fine-tune): 16 director bundles + 22 MV/classic gradients + 8 kinetic anims +
 *      rhythm linkage + weak aesthetic conflict check + secondary subtitle -20% auto-dim + HDR
 *   3. 美学手册 (Handbook): 4-page interactive reader with 1-click director style trial
 */

import { $, $$, byId, clamp, h } from "./util.js";
import { capture, emit, invalidate, isTop, on, pushHistory, state, trimmed } from "./store.js";
import { bindSeg } from "./controls.js";
import { closeModal, onModalClose, openModal, toast, withBusy } from "./feedback.js";
import { call } from "./bridge.js";
import { drawCue, fitCanvas } from "./subs-render.js";
import { applyStyle, presetForCue, renderPresets, syncControls } from "./styles.js";
import { isMotion } from "./motion-path.js";
import { undoAction } from "./cues.js";
import {
  ANIMS, ANIM_BY_ID, BLURS, BUNDLES, BUNDLE_BY_ID, FADES, FADE_BY_ID, GRADIENTS, GRADIENT_BY_ID,
  GUIDE_GENRES, GUIDE_MAP, GUIDE_MOODS, HANDBOOK_PAGES, HDR_LEVELS, OUTLINES, RHYTHMS, RHYTHM_BY_ID,
  SHADOWS, checkAestheticConflict, compileLyricsStyle, cssCornerSwatch, sampleAnim,
} from "./lyrics-data.js";

const MUSIC_RE = /[♪♫♬♩♯]/;
const LYRIC_FONTS = [
  ["【嵐】蜘蛛体", "【嵐】蜘蛛体（歌词）"],
  ["__keep__", "保持当前样式字体"],
  ["WenQuanYi Micro Hei", "文泉驿微米黑"],
  ["Microsoft YaHei", "微软雅黑"],
  ["Source Han Sans CN", "思源黑体"],
  ["ZhunYuan", "准圆"],
  ["SimSun", "宋体（衬线）"],
  ["KaiTi", "楷体"],
];
const GAP_VALUES = [0, 3, 5, 7, 9, 12, 15, 20];
const DEFAULT_PREVIEW_CUE = {
  start_ms: 0,
  end_ms: 3200,
  zh: "在星尘坠落之前 再抱紧我一次",
  en: "Hold me once more before the stardust falls",
};

const cfg = {
  mode: "guide",
  genre: "daily",
  mood: "warm",
  bundleId: "b_shinkai",
  bundleFilter: "all",
  gradGroup: "director",
  gradId: "shinkai_twilight",
  animId: "shinkai_focus",
  rhythmId: "standard",
  fadeId: "soft",
  blurId: "2.5",
  outlineId: "anime_navy",
  shadowId: "shinkai_plum",
  font: "【嵐】蜘蛛体",
  lineGap: 9,
  subInherit: true,
  subAutoDim: true,
  hdrId: "off",
  target: "music",
  hbPage: 0,
};

let modeSeg;
let gradGroupSeg;
let targetSeg;
let hbSeg;
let previewRaf = 0;
let previewStartAt = 0;

function musicCueIndices() {
  const out = [];
  state.subtitles.forEach((c, i) => {
    if (!isMotion(c) && (MUSIC_RE.test(c.zh || "") || MUSIC_RE.test(c.en || ""))) out.push(i);
  });
  return out;
}

function previewCueSample() {
  const list = state.subtitles;
  const sel = !state.isDemo ? list[state.selectedIdx] : null;
  if (sel && !isMotion(sel) && !isTop(sel) && (trimmed(sel.zh) || trimmed(sel.en))) {
    return { start_ms: 0, end_ms: 3200, zh: sel.zh || DEFAULT_PREVIEW_CUE.zh, en: sel.en || DEFAULT_PREVIEW_CUE.en };
  }
  const mIdx = musicCueIndices()[0];
  if (mIdx !== undefined) {
    const mc = list[mIdx];
    return { start_ms: 0, end_ms: 3200, zh: mc.zh || DEFAULT_PREVIEW_CUE.zh, en: mc.en || "" };
  }
  return DEFAULT_PREVIEW_CUE;
}

function loadBundleIntoCfg(bundleId, { keepRhythm = true } = {}) {
  const b = BUNDLE_BY_ID.get(bundleId);
  if (!b) return;
  cfg.bundleId = b.id;
  cfg.gradId = b.gradId;
  cfg.blurId = b.blurId;
  cfg.fadeId = b.fadeId;
  cfg.outlineId = b.outlineId;
  cfg.shadowId = b.shadowId;
  cfg.animId = b.animId;
  const g = GRADIENT_BY_ID.get(b.gradId);
  if (g) cfg.gradGroup = g.group;
  if (!keepRhythm) cfg.rhythmId = "standard";
}

/* ---------- 60fps Live Mini-Stage Preview ---------- */
function stopPreviewLoop() {
  if (previewRaf) {
    cancelAnimationFrame(previewRaf);
    previewRaf = 0;
  }
}

function drawPreviewFrame(elapsedMs) {
  const canvas = byId("lyricsPreviewCanvas");
  if (!canvas || !canvas.clientWidth) return;
  const { ctx, W, H } = fitCanvas(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Subtle atmospheric cinema glow behind the subtitle so outline, blur, and gradients read clearly
  const grad = GRADIENT_BY_ID.get(cfg.gradId);
  if (grad && byId("lyricsStageBox").dataset.tone !== "light") {
    const [tl, tr] = grad.corners;
    ctx.save();
    ctx.globalAlpha = 0.22;
    const g1 = ctx.createRadialGradient(W * 0.28, H * 0.32, 0, W * 0.28, H * 0.32, W * 0.52);
    g1.addColorStop(0, tl);
    g1.addColorStop(1, "transparent");
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createRadialGradient(W * 0.72, H * 0.68, 0, W * 0.72, H * 0.68, W * 0.52);
    g2.addColorStop(0, tr);
    g2.addColorStop(1, "transparent");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  const compiled = compileLyricsStyle(cfg, state.style);
  const sample = previewCueSample();
  drawCue(ctx, {
    W,
    H,
    cue: sample,
    style: { ...compiled, margin_v: 13 },
    langMode: "bilingual",
    zoom: 2.75,
    timeMs: elapsedMs,
  });
}

function updateSpecBadges() {
  const compiled = compileLyricsStyle(cfg, state.style);
  const grad = GRADIENT_BY_ID.get(cfg.gradId);
  const anim = ANIM_BY_ID.get(cfg.animId);
  const badges = [
    grad ? grad.short : "自定义色彩",
    anim && anim.id !== "none" ? `动效 · ${anim.short}` : "静止无动效",
    compiled.fade_in_ms || compiled.fade_out_ms ? `淡入${compiled.fade_in_ms} / 淡出${compiled.fade_out_ms}ms` : "切入无淡化",
    `柔边 ${compiled.blur}`,
  ];
  if (cfg.subInherit && cfg.subAutoDim) badges.push("副字幕 -20%");
  if (cfg.hdrId !== "off") badges.push(`HDR ${HDR_LEVELS.find((x) => x.id === cfg.hdrId)?.name.split(" ")[0]}`);
  byId("lyricsSpecMeta").replaceChildren(...badges.map((t) => h("span", {}, t)));
}

export function replayLyricsPreview() {
  stopPreviewLoop();
  if (cfg.mode === "handbook") return;
  updateSpecBadges();
  const compiled = compileLyricsStyle(cfg, state.style);
  const { activeWindowMs } = sampleAnim(compiled.anim, compiled.anim_mult, compiled.blur, 0);
  const animSpan = Math.max(compiled.fade_in_ms || 0, activeWindowMs || 0);
  previewStartAt = performance.now();

  if (animSpan <= 0 && !(compiled.fade_out_ms > 0)) {
    drawPreviewFrame(1200);
    return;
  }

  const totalDemoMs = 2800;
  const step = (now) => {
    const elapsed = now - previewStartAt;
    if (elapsed <= totalDemoMs) {
      drawPreviewFrame(elapsed);
      previewRaf = requestAnimationFrame(step);
    } else {
      // Settle at steady mid-cue frame so text remains clearly visible after replay finishes!
      drawPreviewFrame(Math.min(1500, Math.max(animSpan + 80, 900)));
      previewRaf = 0;
    }
  };
  previewRaf = requestAnimationFrame(step);
}

/* ---------- Guide Mode ---------- */
function renderGuideQuestions() {
  const fillPills = (hostId, items, current, onPick) => {
    const host = byId(hostId);
    host.replaceChildren(
      ...items.map((it) =>
        h(
          "button",
          {
            class: "lyr-pill",
            type: "button",
            role: "radio",
            "aria-checked": String(it.id === current),
            onclick: () => onPick(it.id),
          },
          it.label || it.short,
        ),
      ),
    );
  };

  fillPills("guideGenreRow", GUIDE_GENRES, cfg.genre, (id) => {
    cfg.genre = id;
    const top1 = GUIDE_MAP[cfg.genre]?.[cfg.mood]?.[0];
    if (top1) loadBundleIntoCfg(top1);
    syncAllViews();
    replayLyricsPreview();
  });

  fillPills("guideMoodRow", GUIDE_MOODS, cfg.mood, (id) => {
    cfg.mood = id;
    const top1 = GUIDE_MAP[cfg.genre]?.[cfg.mood]?.[0];
    if (top1) loadBundleIntoCfg(top1);
    syncAllViews();
    replayLyricsPreview();
  });

  fillPills("guideRhythmRow", RHYTHMS, cfg.rhythmId, (id) => {
    cfg.rhythmId = id;
    syncAllViews();
    replayLyricsPreview();
  });
}

function renderGuideRecs() {
  const ids = GUIDE_MAP[cfg.genre]?.[cfg.mood] || ["b_snyder", "b_nolan_space", "b_shinkai"];
  const host = byId("guideRecCards");
  host.replaceChildren(
    ...ids.map((bid, idx) => {
      const b = BUNDLE_BY_ID.get(bid) || BUNDLES[0];
      const g = GRADIENT_BY_ID.get(b.gradId) || GRADIENTS[0];
      const active = cfg.bundleId === b.id;
      const swatch = h("div", { class: "lyr-swatch-bar" });
      swatch.style.background = cssCornerSwatch(g.corners);
      const fineLink = h(
        "span",
        {
          class: "lyr-rec-fine",
          onclick: (e) => {
            e.stopPropagation();
            loadBundleIntoCfg(b.id);
            setMode("fine");
          },
        },
        "转入精细微调 →",
      );
      return h(
        "div",
        {
          class: "lyr-rec-card",
          role: "radio",
          tabindex: "0",
          "aria-checked": String(active),
          onclick: () => {
            loadBundleIntoCfg(b.id);
            syncAllViews();
            replayLyricsPreview();
          },
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              loadBundleIntoCfg(b.id);
              syncAllViews();
              replayLyricsPreview();
            }
          },
        },
        h(
          "div",
          { class: "lyr-rec-top" },
          h("span", { class: "lyr-rank" }, idx === 0 ? "TOP 1 推荐" : `TOP ${idx + 1}`),
          h("span", { class: "lyr-theme-tag" }, `${b.theme}母题`),
        ),
        swatch,
        h("b", {}, b.name),
        h("p", { class: "lyr-rec-desc" }, b.desc),
        h("p", { class: "lyr-rec-forbid" }, `禁忌：${b.forbidden}`),
        fineLink,
      );
    }),
  );
}

/* ---------- Fine-Tune Mode ---------- */
const BUNDLE_FILTERS = [
  ["all", "全部 16"],
  ["史诗", "史诗"],
  ["犯罪", "犯罪"],
  ["文艺", "文艺"],
  ["日常", "日常"],
  ["哲思", "哲思"],
];

function renderFineBundles() {
  const filterHost = byId("fineThemeFilter");
  filterHost.replaceChildren(
    ...BUNDLE_FILTERS.map(([val, label]) =>
      h(
        "button",
        {
          class: "lyr-pill",
          type: "button",
          "aria-checked": String(cfg.bundleFilter === val),
          onclick: () => {
            cfg.bundleFilter = val;
            renderFineBundles();
          },
        },
        label,
      ),
    ),
  );

  const list = cfg.bundleFilter === "all" ? BUNDLES : BUNDLES.filter((b) => b.theme === cfg.bundleFilter);
  const grid = byId("fineBundleGrid");
  grid.replaceChildren(
    ...list.map((b) => {
      const g = GRADIENT_BY_ID.get(b.gradId) || GRADIENTS[0];
      const dot = h("i", {});
      dot.style.background = cssCornerSwatch(g.corners);
      return h(
        "button",
        {
          class: "lyr-bchip",
          type: "button",
          role: "radio",
          "aria-checked": String(cfg.bundleId === b.id),
          "data-tip": `${b.desc} · 禁忌：${b.forbidden}`,
          onclick: () => {
            loadBundleIntoCfg(b.id);
            syncAllViews();
            replayLyricsPreview();
          },
        },
        dot,
        h("span", {}, b.name),
      );
    }),
  );

  const curBundle = BUNDLE_BY_ID.get(cfg.bundleId);
  byId("fineBundleNote").textContent = curBundle ? `禁忌：${curBundle.forbidden}` : "自由组合参数 · 形式服务叙事";
}

function renderFineGradients() {
  gradGroupSeg?.set(cfg.gradGroup, { animate: false });
  const list = GRADIENTS.filter((g) => g.group === cfg.gradGroup);
  const grid = byId("fineGradGrid");
  grid.replaceChildren(
    ...list.map((g) => {
      const sw = h("i", {});
      sw.style.background = cssCornerSwatch(g.corners);
      return h(
        "button",
        {
          class: "lyr-gchip",
          type: "button",
          role: "radio",
          "aria-checked": String(cfg.gradId === g.id),
          "data-tip": `${g.key}${g.logic ? ` · ${g.logic}` : ""}`,
          onclick: () => {
            cfg.gradId = g.id;
            if (BUNDLE_BY_ID.get(cfg.bundleId)?.gradId !== g.id) cfg.bundleId = "";
            syncAllViews();
            replayLyricsPreview();
          },
        },
        sw,
        h("span", {}, g.short),
      );
    }),
  );
}

function renderConflictBanner() {
  const conflict = checkAestheticConflict(cfg);
  const box = byId("lyricsConflict");
  box.hidden = !conflict;
  if (conflict) {
    byId("lyricsConflictTitle").textContent = conflict.title;
    byId("lyricsConflictBody").textContent = conflict.detail;
  }
}

/* ---------- Handbook Mode ---------- */
function renderHandbook() {
  const page = HANDBOOK_PAGES[cfg.hbPage] || HANDBOOK_PAGES[0];
  hbSeg?.set(String(cfg.hbPage), { animate: false });
  byId("hbPageIndicator").textContent = `第 ${cfg.hbPage + 1} / ${HANDBOOK_PAGES.length} 页 · ${page.subtitle}`;
  byId("btnHbPrev").disabled = cfg.hbPage <= 0;
  byId("btnHbNext").disabled = cfg.hbPage >= HANDBOOK_PAGES.length - 1;

  const host = byId("hbContent");
  if (page.items) {
    host.replaceChildren(
      h(
        "div",
        { class: "hb-cards-2" },
        ...page.items.map((it) =>
          h("article", { class: "hb-card" }, h("span", { class: "hb-badge" }, it.badge), h("h4", {}, it.head), h("p", {}, it.body)),
        ),
      ),
    );
    return;
  }

  if (page.directors) {
    host.replaceChildren(
      h(
        "div",
        { class: "hb-dir-grid" },
        ...page.directors.map(([name, gradId, text, forbid]) => {
          const g = GRADIENT_BY_ID.get(gradId) || GRADIENTS[0];
          const bar = h("i", { class: "hb-dir-bar" });
          bar.style.background = cssCornerSwatch(g.corners);
          const matchingBundle = BUNDLES.find((b) => b.gradId === gradId);
          return h(
            "div",
            { class: "hb-dir" },
            bar,
            h("div", {}, h("b", {}, name), h("p", {}, text), h("em", {}, forbid)),
            matchingBundle
              ? h(
                  "button",
                  {
                    class: "btn btn-sm",
                    type: "button",
                    onclick: () => {
                      loadBundleIntoCfg(matchingBundle.id);
                      setMode("fine");
                    },
                  },
                  "试用",
                )
              : null,
          );
        }),
      ),
    );
    return;
  }

  host.replaceChildren(
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "hb-redlines" },
        ...page.redlines.map((line, idx) => h("div", { class: "hb-red" }, h("b", {}, `0${idx + 1}`), h("span", {}, line))),
      ),
      h(
        "div",
        { class: "lyr-rec-grid" },
        ...page.ladder.map(([stage, desc]) => h("div", { class: "hb-card" }, h("span", { class: "hb-badge" }, stage), h("p", {}, desc))),
      ),
    ),
  );
}

/* ---------- Target Scope & Sync ---------- */
function syncTargetBar() {
  const list = state.subtitles;
  const musicCount = musicCueIndices().length;
  const selCue = list[state.selectedIdx];
  byId("lyrMusicCount").textContent = `(${musicCount})`;
  byId("lyrCueNo").textContent = selCue ? `(#${selCue.id})` : "";
  targetSeg?.set(cfg.target, { animate: false });
  byId("lyricsRangeWrap").hidden = cfg.target !== "range";

  const fromInput = byId("lyrRangeFrom");
  const toInput = byId("lyrRangeTo");
  if (!fromInput.value && list.length) fromInput.value = "1";
  if (!toInput.value && list.length) toInput.value = String(list.length);
}

function syncFormControls() {
  byId("guideFont").value = cfg.font;
  byId("guideHdr").value = cfg.hdrId;
  byId("guideSubInherit").checked = cfg.subInherit;
  byId("guideSubDim").checked = cfg.subAutoDim;
  byId("guideSubDim").disabled = !cfg.subInherit;

  byId("lyrAnim").value = cfg.animId;
  byId("lyrRhythm").value = cfg.rhythmId;
  byId("lyrFade").value = cfg.fadeId;
  byId("lyrBlur").value = cfg.blurId;
  byId("lyrOutline").value = cfg.outlineId;
  byId("lyrShadow").value = cfg.shadowId;
  byId("lyrFont").value = cfg.font;
  byId("lyrGap").value = String(cfg.lineGap);
  byId("lyrHdr").value = cfg.hdrId;
  byId("lyrSubInherit").checked = cfg.subInherit;
  byId("lyrSubDim").checked = cfg.subAutoDim;
  byId("lyrSubDim").disabled = !cfg.subInherit;
}

function syncAllViews() {
  renderGuideQuestions();
  renderGuideRecs();
  renderFineBundles();
  renderFineGradients();
  renderConflictBanner();
  syncFormControls();
  syncTargetBar();
  if (cfg.mode === "handbook") renderHandbook();
}

function setMode(mode) {
  cfg.mode = mode;
  modeSeg?.set(mode);
  byId("lyricsPaneGuide").hidden = mode !== "guide";
  byId("lyricsPaneFine").hidden = mode !== "fine";
  byId("lyricsPaneHandbook").hidden = mode !== "handbook";
  byId("lyricsStageWrap").hidden = mode === "handbook";
  byId("lyricsFoot").hidden = mode === "handbook";
  syncAllViews();
  if (mode !== "handbook") requestAnimationFrame(replayLyricsPreview);
  else stopPreviewLoop();
}

/* ---------- Apply & Save as Preset ---------- */
function applyLyricsEffects() {
  const compiled = compileLyricsStyle(cfg, state.style);
  const grad = GRADIENT_BY_ID.get(cfg.gradId);
  const styleLabel = BUNDLE_BY_ID.get(cfg.bundleId)?.name || grad?.short || "歌词特效";

  if (cfg.target === "global") {
    const snap = capture({ includeStyle: true });
    pushHistory(`全片套用「${styleLabel}」`, snap);
    applyStyle(compiled, null);
    state.dirty = true;
    closeModal("modalLyrics");
    toast(`已将「${styleLabel}」设为全片全局歌词样式`, { type: "success", action: undoAction() });
    return;
  }

  const list = state.subtitles;
  if (!list.length) {
    toast("列表里还没有字幕；若想先调全局模板，请把下方范围切到「全片全局」");
    return;
  }

  let targets = [];
  if (cfg.target === "music") {
    targets = musicCueIndices();
    if (!targets.length) {
      toast("未扫描到带 ♪ ♫ 音符的歌词行；可改选「当前句」「句号区间」或「全片全局」");
      return;
    }
  } else if (cfg.target === "cue") {
    if (list[state.selectedIdx]) targets = [state.selectedIdx];
  } else if (cfg.target === "range") {
    const a = clamp(Math.round(Number(byId("lyrRangeFrom").value) || 1), 1, list.length);
    const b = clamp(Math.round(Number(byId("lyrRangeTo").value) || list.length), 1, list.length);
    const lo = Math.min(a, b) - 1;
    const hi = Math.max(a, b) - 1;
    for (let i = lo; i <= hi; i++) if (!isMotion(list[i])) targets.push(i);
  }

  if (!targets.length) {
    toast("没有可应用的目标字幕行");
    return;
  }

  pushHistory(`歌词特效 · ${styleLabel}`);
  for (const idx of targets) {
    const cue = state.subtitles[idx];
    cue.style_override = presetForCue(compiled, cue);
    delete cue.style_preset_id;
  }
  state.dirty = true;
  syncControls();
  emit("cues", {});
  invalidate("overlay", "list");
  closeModal("modalLyrics");
  toast(`已应用「${styleLabel}」到 ${targets.length} 句歌词`, { type: "success", action: undoAction() });
}

async function saveAsCustomPreset(btn) {
  return withBusy(btn, async () => {
    const input = byId("inpLyricsPresetName");
    const defaultName = BUNDLE_BY_ID.get(cfg.bundleId)?.name || GRADIENT_BY_ID.get(cfg.gradId)?.short || "我的歌词模板";
    const label = input.value.trim() || `歌词 · ${defaultName}`;
    const compiled = compileLyricsStyle(cfg, state.style);
    const res = await call("save_custom_preset", label, compiled);
    if (!res.ok) return res.error && toast(res.error, { type: "error" });
    state.presets = res.presets;
    input.value = "";
    renderPresets();
    toast(`已存入样式模板墙：「${label}」`, { type: "success" });
  });
}

export function openLyrics(initialMode = "guide") {
  // Auto-pick sensible default target scope based on current subtitle list
  const list = state.subtitles;
  if (!list.length || state.isDemo) cfg.target = "global";
  else if (musicCueIndices().length > 0) cfg.target = "music";
  else if (cfg.target === "music") cfg.target = "cue";

  if (list.length) {
    byId("lyrRangeFrom").value = String(Math.max(1, state.selectedIdx + 1));
    byId("lyrRangeTo").value = String(list.length);
  }
  openModal("modalLyrics");
  setMode(initialMode);
}

function populateSelect(id, entries) {
  const sel = byId(id);
  sel.replaceChildren(...entries.map(([val, label]) => h("option", { value: String(val) }, label)));
}

export function initLyrics() {
  populateSelect("guideFont", LYRIC_FONTS);
  populateSelect("lyrFont", LYRIC_FONTS);
  populateSelect("guideHdr", HDR_LEVELS.map((x) => [x.id, x.name]));
  populateSelect("lyrHdr", HDR_LEVELS.map((x) => [x.id, x.name]));
  populateSelect("lyrAnim", ANIMS.map((x) => [x.id, x.name]));
  populateSelect("lyrRhythm", RHYTHMS.map((x) => [x.id, `${x.name} (${x.fadeMult}×)`]));
  populateSelect("lyrFade", FADES.map((x) => [x.id, x.name]));
  populateSelect("lyrBlur", BLURS.map((x) => [x.id, x.name]));
  populateSelect("lyrOutline", OUTLINES.map((x) => [x.id, x.name]));
  populateSelect("lyrShadow", SHADOWS.map((x) => [x.id, x.name]));
  populateSelect("lyrGap", GAP_VALUES.map((v) => [String(v), v === 9 ? "9（歌词推荐）" : String(v)]));

  modeSeg = bindSeg(byId("lyricsModeSeg"), setMode);
  gradGroupSeg = bindSeg(byId("fineGradGroupSeg"), (v) => {
    cfg.gradGroup = v;
    renderFineGradients();
  });
  targetSeg = bindSeg(byId("lyricsTargetSeg"), (v) => {
    cfg.target = v;
    syncTargetBar();
  });
  hbSeg = bindSeg(byId("hbPageSeg"), (v) => {
    cfg.hbPage = Number(v) || 0;
    renderHandbook();
  });

  const bindChange = (id, apply, replay = true) => {
    byId(id).addEventListener("change", (e) => {
      apply(e.target);
      syncAllViews();
      if (replay) replayLyricsPreview();
    });
  };

  bindChange("guideFont", (el) => { cfg.font = el.value; }, false);
  bindChange("lyrFont", (el) => { cfg.font = el.value; }, false);
  bindChange("guideHdr", (el) => { cfg.hdrId = el.value; }, false);
  bindChange("lyrHdr", (el) => { cfg.hdrId = el.value; }, false);
  bindChange("guideSubInherit", (el) => { cfg.subInherit = el.checked; }, false);
  bindChange("lyrSubInherit", (el) => { cfg.subInherit = el.checked; }, false);
  bindChange("guideSubDim", (el) => { cfg.subAutoDim = el.checked; }, false);
  bindChange("lyrSubDim", (el) => { cfg.subAutoDim = el.checked; }, false);

  bindChange("lyrAnim", (el) => { cfg.animId = el.value; });
  bindChange("lyrRhythm", (el) => { cfg.rhythmId = el.value; });
  bindChange("lyrFade", (el) => { cfg.fadeId = el.value; });
  bindChange("lyrBlur", (el) => { cfg.blurId = el.value; });
  bindChange("lyrOutline", (el) => { cfg.outlineId = el.value; }, false);
  bindChange("lyrShadow", (el) => { cfg.shadowId = el.value; }, false);
  bindChange("lyrGap", (el) => { cfg.lineGap = Number(el.value) || 9; }, false);

  // Sync non-animated visual tweaks onto the preview canvas immediately
  for (const id of ["guideFont", "lyrFont", "guideHdr", "lyrHdr", "guideSubInherit", "lyrSubInherit", "guideSubDim", "lyrSubDim", "lyrOutline", "lyrShadow", "lyrGap"]) {
    byId(id).addEventListener("change", () => {
      updateSpecBadges();
      if (!previewRaf) drawPreviewFrame(1200);
    });
  }

  byId("btnLyricsReplay").addEventListener("click", replayLyricsPreview);
  for (const b of $$("#lyricsToneSwitch button")) {
    b.addEventListener("click", () => {
      byId("lyricsStageBox").dataset.tone = b.dataset.tone;
      for (const x of $$("#lyricsToneSwitch button")) x.setAttribute("aria-checked", String(x === b));
      if (!previewRaf) drawPreviewFrame(1200);
    });
  }

  byId("btnHbPrev").addEventListener("click", () => {
    if (cfg.hbPage > 0) {
      cfg.hbPage--;
      renderHandbook();
    }
  });
  byId("btnHbNext").addEventListener("click", () => {
    if (cfg.hbPage < HANDBOOK_PAGES.length - 1) {
      cfg.hbPage++;
      renderHandbook();
    }
  });

  byId("btnOpenLyrics").addEventListener("click", () => openLyrics("guide"));
  byId("btnLyricsApply").addEventListener("click", applyLyricsEffects);
  byId("btnLyricsSavePreset").addEventListener("click", (e) => saveAsCustomPreset(e.currentTarget));

  onModalClose("modalLyrics", stopPreviewLoop);
  on("cues", () => !byId("modalLyrics").hidden && syncTargetBar());
  new ResizeObserver(() => {
    if (!byId("modalLyrics").hidden && cfg.mode !== "handbook" && !previewRaf) drawPreviewFrame(1200);
  }).observe(byId("lyricsStageBox"));

  loadBundleIntoCfg("b_shinkai");
}
