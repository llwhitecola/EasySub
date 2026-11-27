/* Style tab: preset wall, layout controls, per-language type controls. */

import { $, $$, byId, h, icon } from "./util.js";
import { emit, historyMark, invalidate, on, pushHistory, registerDraw, state } from "./store.js";
import { bindSeg, makeFader, makeWell } from "./controls.js";
import { confirmBox, toast, withBusy } from "./feedback.js";
import { call } from "./bridge.js";
import { drawCue, fitCanvas, fontStack, isFontInstalled } from "./subs-render.js";
import { sceneHues } from "./scenes.js";
import { inheritedCueStyle, isStaticNote, normalizeCueStyle, resolveCueStyle } from "./cue-style.js";
import { isMotion } from "./motion-path.js";
import { pause, seekTo } from "./player.js";

const ZH_FONTS = [
  ["WenQuanYi Micro Hei", "文泉驿微米黑（美剧默认）"],
  ["【嵐】蜘蛛体", "【嵐】蜘蛛体（歌词）"],
  ["Microsoft YaHei", "微软雅黑（清晰百搭）"],
  ["ZhunYuan", "准圆"],
  ["Source Han Sans CN", "思源黑体"],
  ["SimHei", "黑体"],
  ["SimSun", "宋体"],
  ["KaiTi", "楷体（温润纪录片）"],
  ["DengXian", "等线（现代极简）"],
];
const EN_FONTS = [
  ["ITCAvantGardePro-Demi", "ITC Avant Garde（美剧默认）"],
  ["【嵐】蜘蛛体", "【嵐】蜘蛛体（歌词）"],
  ["Cronos Pro", "Cronos Pro（天空英语）"],
  ["Avenir Next W1G", "Avenir Next W1G"],
  ["Segoe UI", "Segoe UI（现代无衬线）"],
  ["Arial", "Arial（经典百搭）"],
  ["Georgia", "Georgia（优雅衬线）"],
  ["Trebuchet MS", "Trebuchet MS"],
  ["WenQuanYi Micro Hei", "文泉驿微米黑"],
];

const THUMB_CUE = { zh: "双语字幕", en: "Bilingual" };
const INK_GAP_TIP = "上行文字底部到下文字顶部的可见像素距离。0 表示刚好相接，负数表示重叠。";
const ui = { zh: {}, en: {} };
let orderSeg;
let langSeg;
let scopeSeg;
let scope = "global";
let lastStyleEdit;
const selectedCue = () => state.isDemo ? null : state.subtitles[state.selectedIdx];
const scopedCue = () => scope === "cue" ? selectedCue() : null;

/* ---------- preset ⇄ style ---------- */
export function styleFromPreset(p) {
  const s = structuredClone(p);
  for (const k of ["id", "name", "desc", "is_custom"]) delete s[k];
  s.line_gap ??= 4;
  s.line_gap_mode ??= "ink";
  s.blur ??= 0.8;
  s.fade_in_ms ??= 0;
  s.fade_out_ms ??= 0;
  s.anim ??= "none";
  s.anim_mult ??= 1;
  s.sub_anim ??= true;
  s.ycbcr_matrix ??= "None";
  s.box_color ??= "#0F172A";
  s.box_opacity ??= 0.6;
  for (const lang of ["zh", "en"]) {
    s[lang] ??= {};
    s[lang].scale_x ??= 100;
    s[lang].outline ??= 1;
    s[lang].shadow ??= 1;
    s[lang].outline_color ??= "#000000";
    s[lang].color ??= "#FFFFFF";
    s[lang].gradient = Array.isArray(s[lang].gradient) && s[lang].gradient.length === 4 ? [...s[lang].gradient] : null;
    s[lang].size ??= 50;
    s[lang].font ??= "Microsoft YaHei";
  }
  return s;
}
const activePreset = () => state.presets.find((p) => p.id === state.activePresetId);

const stable = (o) =>
  o && typeof o === "object" && !Array.isArray(o)
    ? `{${Object.keys(o).sort().map((k) => `${k}:${stable(o[k])}`).join(",")}}`
    : JSON.stringify(o);

function isModified() {
  const p = activePreset();
  return Boolean(p) && stable(styleFromPreset(p)) !== stable(state.style);
}

export function applyStyle(style, presetId = null) {
  state.style = styleFromPreset(style);
  if (presetId !== null) state.activePresetId = presetId;
  else {
    const match = state.presets.find((p) => stable(styleFromPreset(p)) === stable(state.style));
    if (match) state.activePresetId = match.id;
  }
  syncControls();
  paintPresetState();
  emit("style", {});
}

function styleChanged(from) {
  state.dirty = true;
  emit("style", { from });
  invalidate("presetstate");
}

function writeCueStyle(cue, override, field, from, presetId = cue.style_preset_id) {
  const now = performance.now();
  if (!field || lastStyleEdit?.cue !== cue || lastStyleEdit.field !== field ||
      lastStyleEdit.mark !== historyMark() || now - lastStyleEdit.at > 850) {
    pushHistory(override ? "修改本句样式" : "清除本句样式");
  }
  lastStyleEdit = field ? { cue, field, mark: historyMark(), at: now } : null;
  if (override) cue.style_override = override;
  else delete cue.style_override;
  if (override && presetId) cue.style_preset_id = presetId;
  else delete cue.style_preset_id;
  state.dirty = true;
  emit("cue", { idx: state.selectedIdx, what: "style", from });
}

function setStyleField(key, value, lang, from) {
  const cue = scopedCue();
  if (!cue) {
    const target = lang ? state.style[lang] : state.style;
    target[key] = value;
    if (key === "color" && lang) target.gradient = null;
    styleChanged(from);
    return;
  }
  const effective = resolveCueStyle(state.style, cue);
  if ((lang ? effective[lang] : effective)[key] === value && !(key === "color" && lang && effective[lang]?.gradient)) return;
  const inherited = inheritedCueStyle(state.style, cue);
  const override = { ...cue.style_override };
  if (lang) override[lang] = { ...override[lang] };
  const patch = lang ? override[lang] : override;
  const gapModeDiffers = key === "line_gap" &&
    (effective.line_gap_mode ?? "ink") !== (inherited.line_gap_mode ?? "ink");
  if (!gapModeDiffers && value === (lang ? inherited[lang] : inherited)[key]) delete patch[key];
  else patch[key] = value;
  if (key === "line_gap" && "line_gap" in patch) patch.line_gap_mode = effective.line_gap_mode ?? "ink";
  if (key === "color" && lang) {
    if (inherited[lang]?.gradient) patch.gradient = null;
    else delete patch.gradient;
  }
  writeCueStyle(cue, normalizeCueStyle(override), lang ? `${lang}.${key}` : key, from);
}

export function stageMargin(idx) {
  const cue = scopedCue();
  if (!cue) return state.style.margin_v;
  return state.subtitles[idx] === cue ? resolveCueStyle(state.style, cue).margin_v : null;
}

export function setStageMargin(idx, value) {
  if (stageMargin(idx) !== null) setStyleField("margin_v", value, undefined, "stage");
}

function paintScope() {
  const cue = scopedCue();
  byId("cueStyleTarget").textContent = cue ? `第 ${cue.id} 句` : "";
  byId("cueStyleTarget").hidden = !cue;
  byId("btnCueStyleReset").hidden = !cue?.style_override;
}

/* ---------- preset wall ---------- */
export function presetForCue(preset, cue) {
  const style = styleFromPreset(preset);
  const motion = isMotion(cue);
  if (motion || isStaticNote(cue)) {
    delete style.en;
    delete style.line_gap;
    delete style.line_gap_mode;
  }
  if (motion) {
    delete style.order;
    delete style.margin_v;
  }
  for (const lang of ["zh", "en"]) {
    const text = style[lang];
    if (!text) continue;
    text.secondary_color ??= "#000000";
    text.back_color ??= "#000000";
    text.back_opacity ??= 1;
    text.margin_l ??= 10;
    text.margin_r ??= 11;
    text.bold ??= false;
    text.italic ??= false;
  }
  return normalizeCueStyle(style);
}

export function renderPresets() {
  const grid = byId("presetGrid");
  grid.replaceChildren(
    ...state.presets.map((p) => {
      const card = h(
        "div",
        { class: "preset", role: "radio", tabindex: "0", dataset: { id: p.id }, "data-tip": p.desc || p.name },
        h("canvas", { class: "preset-thumb" }),
        h("span", { class: "preset-name" }, p.name),
        p.is_custom
          ? h("button", { class: "preset-del", type: "button", "data-tip": "删除这个模板", "aria-label": `删除模板 ${p.name}` }, icon("close"))
          : null,
      );
      return card;
    }),
  );
  paintPresetState();
  paintThumbs();
}

function paintThumbs() {
  for (const card of $$(".preset")) {
    const p = state.presets.find((x) => x.id === card.dataset.id);
    const canvas = $("canvas", card);
    if (!p || !canvas.clientWidth) continue;
    const { ctx, W, H } = fitCanvas(canvas);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const hues = sceneHues();
    ctx.fillStyle = `oklch(0.22 0.045 ${hues[0]})`;
    ctx.fillRect(0, 0, W, H);
    for (const [x, y, r, i] of [[0.2, 0.15, 0.75, 0], [0.88, 0.25, 0.65, 1], [0.62, 1, 0.65, 3]]) {
      const g = ctx.createRadialGradient(W * x, H * y, 0, W * x, H * y, W * r);
      g.addColorStop(0, `oklch(0.42 0.09 ${hues[i]} / 0.85)`);
      g.addColorStop(1, `oklch(0.42 0.09 ${hues[i]} / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    drawCue(ctx, { W, H, cue: THUMB_CUE, style: styleFromPreset(p), zoom: 3.9 });
  }
}

function paintPresetState() {
  const cue = scopedCue();
  let matched;
  if (cue?.style_override) {
    const patch = stable(cue.style_override);
    const matches = (p) => stable(presetForCue(p, cue)) === patch;
    const chosen = state.presets.find((p) => p.id === cue.style_preset_id);
    matched = chosen && matches(chosen) ? chosen : state.presets.find(matches);
  }
  for (const card of $$(".preset")) {
    const on_ = card.dataset.id === (cue ? matched?.id : state.activePresetId);
    card.setAttribute("aria-checked", String(on_));
    card.classList.toggle("active", on_);
  }
  const p = activePreset();
  const mod = isModified();
  const name = p ? p.name : "自定义样式";
  byId("presetNow").textContent = cue ? (matched?.name || (cue.style_override ? "本句自定义样式" : "沿用全局样式")) : name;
  byId("presetModified").hidden = Boolean(cue) || !mod;
  byId("btnStyleReset").hidden = Boolean(cue) || !mod;
  byId("footPreset").textContent = mod ? `${name}（已调整）` : name;
}

async function removePreset(p) {
  const yes = await confirmBox({
    title: "删除这个模板？",
    body: `「${p.name}」会从你的模板收藏里移除，这一步不能撤销。已经套用到当前字幕的样式不受影响。`,
    okLabel: "删除模板",
    danger: true,
  });
  if (!yes) return;
  const res = await call("delete_custom_preset", p.id);
  if (!res.ok) return res.error && toast(res.error, { type: "error" });
  state.presets = res.presets;
  if (state.activePresetId === p.id && state.presets.length) state.activePresetId = state.presets[0].id;
  renderPresets();
  toast(`已删除模板「${p.name}」`);
}

/* ---------- per-language cards ---------- */
function fontSelect(lang, fonts) {
  const sel = h("select", { class: "field field-sm", "aria-label": "字体" });
  const addOption = (value, label) => {
    const opt = h("option", { value }, isFontInstalled(value) ? label : `${label} · 未安装`);
    opt.style.fontFamily = fontStack(value);
    sel.append(opt);
  };
  fonts.forEach(([v, l]) => addOption(v, l));
  const hint = h("p", { class: "font-hint", hidden: true });
  const sync = (value) => {
    if (value && !Array.from(sel.options).some((o) => o.value === value)) addOption(value, value);
    sel.value = value;
    const missing = value && !isFontInstalled(value);
    hint.hidden = !missing;
    hint.textContent = missing ? "本机未安装此字体，预览用近似字体代替；在装有它的设备上会正常显示。" : "";
  };
  sel.addEventListener("change", () => {
    setStyleField("font", sel.value, lang);
    sync(sel.value);
  });
  return { root: h("div", { class: "lbl" }, h("span", {}, "字体"), sel, hint), set: sync };
}

function buildLangCard(lang) {
  const root = byId(lang === "zh" ? "cardZh" : "cardEn");
  const u = ui[lang];
  const bindField = (field) => (value) => setStyleField(field, value, lang);
  u.font = fontSelect(lang, lang === "zh" ? ZH_FONTS : EN_FONTS);
  u.size = makeFader({ label: "字号", min: lang === "zh" ? 26 : 18, max: lang === "zh" ? 110 : 90, onInput: bindField("size") });
  u.scale_x = makeFader({ label: "字宽", unit: "%", min: 75, max: 115, onInput: bindField("scale_x") });
  u.outline = makeFader({ label: "描边", min: 0, max: 6, step: 0.1, onInput: bindField("outline") });
  u.shadow = makeFader({ label: "阴影", min: 0, max: 6, step: 0.1, onInput: bindField("shadow") });
  u.color = makeWell({ label: "文字", onInput: bindField("color") });
  u.outline_color = makeWell({ label: "描边", onInput: bindField("outline_color") });
  for (const key of ["bold", "italic"]) {
    const btn = h("button", {
      class: "icon-btn", type: "button", "data-tip": key === "bold" ? "粗体" : "斜体", "aria-label": key === "bold" ? "粗体" : "斜体",
      onclick: () => {
        const value = !resolveCueStyle(state.style, scopedCue())[lang][key];
        setStyleField(key, value, lang);
        btn.setAttribute("aria-pressed", String(value));
      },
    }, icon(key));
    u[key] = btn;
  }
  root.append(
    h(
      "header", {},
      u.title = h("b", {}, lang === "zh" ? "中文" : "英文"),
      h("div", { class: "lang-toggles" }, u.bold, u.italic),
    ),
    u.font.root,
    h("div", { class: "fader-grid" }, u.size.root, u.scale_x.root, u.outline.root, u.shadow.root),
    h("div", { class: "well-grid" }, u.color.root, u.outline_color.root),
  );
}

function syncControls() {
  const selected = selectedCue();
  if (!selected) scope = "global";
  const cue = scopedCue();
  const note = isStaticNote(cue);
  const motion = isMotion(cue);
  const s = resolveCueStyle(state.style, cue);
  byId("styleScope").querySelector('[data-value="cue"]').hidden = !selected;
  scopeSeg.set(scope);
  byId("presetSave").hidden = Boolean(cue);
  byId("presetGrid").classList.toggle("for-cue", Boolean(cue));
  byId("presetGrid").setAttribute("aria-label", cue ? "本句模板" : "全局模板");
  byId("langSeg").hidden = Boolean(cue);
  byId("orderSeg").hidden = motion;
  byId("faderMargin").hidden = motion;
  byId("faderGap").hidden = note || motion;
  const marginLabel = note ? "距顶高度" : "距底高度";
  $(".fader-head span", ui.margin.root).textContent = marginLabel;
  $('input[type="range"]', ui.margin.root).setAttribute("aria-label", marginLabel);
  $('input[type="number"]', ui.margin.root).setAttribute("aria-label", `${marginLabel}数值`);
  byId("cardEn").hidden = note || motion;
  byId("styleLangCards").classList.toggle("single", note || motion);
  ui.zh.title.textContent = note || motion ? "标注文字" : "中文";
  paintScope();
  invalidate("presetstate");
  orderSeg.set(s.order === "en_top" ? "en_top" : "zh_top");
  langSeg.set(state.langMode);
  byId("chkBox").checked = Boolean(s.box_mode);
  ui.margin.set(s.margin_v);
  const assSpacing = s.line_gap_mode === "ass_margin";
  const gapLabel = assSpacing ? "上下行高度差" : "中英间距";
  const gapName = $(".fader-head span", ui.gap.root);
  gapName.textContent = gapLabel;
  gapName.dataset.tip = assSpacing ? "原 ASS 的上下行距底高度之差，以 1920×1080 脚本像素计。" : INK_GAP_TIP;
  $('input[type="range"]', ui.gap.root).setAttribute("aria-label", gapLabel);
  $('input[type="number"]', ui.gap.root).setAttribute("aria-label", `${gapLabel}数值`);
  ui.gap.setLimits(assSpacing ? 0 : -30, assSpacing ? 400 : 28);
  ui.gap.set(s.line_gap);
  ui.blur.set(s.blur);
  byId("faderBlur").classList.toggle("muted", Boolean(s.box_mode));
  const preset = activePreset();
  const base = cue ? inheritedCueStyle(state.style, cue) : preset ? styleFromPreset(preset) : null;
  ui.margin.setReset(base?.margin_v ?? null);
  ui.gap.setReset(base && (base.line_gap_mode === "ass_margin") === assSpacing ? base.line_gap : null);
  ui.blur.setReset(base?.blur ?? null);
  for (const lang of ["zh", "en"]) {
    const cfg = s[lang];
    const u = ui[lang];
    u.font.set(cfg.font);
    for (const f of ["size", "scale_x", "outline", "shadow"]) {
      u[f].set(cfg[f]);
      u[f].setReset(base?.[lang]?.[f] ?? null);
    }
    u.color.set(cfg.color);
    u.outline_color.set(cfg.outline_color);
    u.bold.setAttribute("aria-pressed", String(Boolean(cfg.bold)));
    u.italic.setAttribute("aria-pressed", String(Boolean(cfg.italic)));
  }
}

export function setLangMode(mode) {
  state.langMode = mode;
  langSeg.set(mode);
  emit("style", {});
}

export function initStyles() {
  scopeSeg = bindSeg(byId("styleScope"), (value) => {
    scope = value;
    lastStyleEdit = null;
    syncControls();
    const cue = scopedCue();
    if (!cue) return;
    pause();
    if (state.currentTimeMs < cue.start_ms || state.currentTimeMs >= cue.end_ms) {
      seekTo(cue.start_ms + Math.min(20, Math.floor((cue.end_ms - cue.start_ms) / 2)));
    }
    invalidate("overlay");
  });
  byId("btnCueStyleReset").addEventListener("click", () => {
    const cue = scopedCue();
    if (!cue?.style_override) return;
    writeCueStyle(cue, undefined);
    syncControls();
  });
  const grid = byId("presetGrid");
  const pick = (card) => {
    const p = state.presets.find((x) => x.id === card.dataset.id);
    if (!p) return;
    const cue = scopedCue();
    if (cue) {
      const patch = presetForCue(p, cue);
      if (cue.style_preset_id !== p.id || stable(patch) !== stable(cue.style_override)) {
        writeCueStyle(cue, patch, undefined, undefined, p.id);
      }
      syncControls();
      return;
    }
    applyStyle(p, p.id);
    state.dirty = true;
  };
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".preset");
    if (!card) return;
    if (e.target.closest(".preset-del")) {
      if (scopedCue()) return;
      const p = state.presets.find((x) => x.id === card.dataset.id);
      if (p) removePreset(p);
      return;
    }
    pick(card);
  });
  grid.addEventListener("keydown", (e) => {
    const card = e.target.closest(".preset");
    if (!card || e.target !== card) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      pick(card);
    }
  });

  orderSeg = bindSeg(byId("orderSeg"), (v) => {
    setStyleField("order", v);
  });
  langSeg = bindSeg(byId("langSeg"), (v) => {
    state.langMode = v;
    emit("style", {});
  });
  byId("chkBox").addEventListener("change", (e) => {
    setStyleField("box_mode", e.target.checked);
    byId("faderBlur").classList.toggle("muted", e.target.checked);
  });

  const fader = (slot, opt, key) => {
    const f = makeFader({ ...opt, onInput: (v) => setStyleField(key, v) });
    byId(slot).append(f.root);
    return f;
  };
  ui.margin = fader("faderMargin", { label: "距底高度", min: 0, max: 400 }, "margin_v");
  ui.gap = fader("faderGap", {
    label: "中英间距",
    min: -30,
    max: 28,
    tip: INK_GAP_TIP,
  }, "line_gap");
  ui.blur = fader("faderBlur", { label: "柔边羽化", min: 0, max: 5, step: 0.5 }, "blur");
  buildLangCard("zh");
  buildLangCard("en");

  byId("btnStyleReset").addEventListener("click", () => {
    const p = activePreset();
    if (!p) return;
    applyStyle(p, p.id);
    state.dirty = true;
  });

  const save = byId("btnSavePreset");
  const name = byId("inpPresetName");
  save.addEventListener("click", () =>
    withBusy(save, async () => {
      const label = name.value.trim() || "我的专属样式";
      const res = await call("save_custom_preset", label, state.style);
      if (!res.ok) return res.error && toast(res.error, { type: "error" });
      state.presets = res.presets;
      state.activePresetId = res.new_id;
      name.value = "";
      renderPresets();
      syncControls();
      $(`.preset[data-id="${res.new_id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      toast(`已收藏模板「${label}」`, { type: "success" });
    }),
  );
  name.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && save.click());

  registerDraw("presetstate", paintPresetState);
  registerDraw("thumbs", paintThumbs);
  on("palette", () => invalidate("thumbs"));
  on("dpr", () => invalidate("thumbs"));
  on("style", (info) => {
    if (info?.from === "stage" && !scopedCue()) ui.margin.set(state.style.margin_v);
    invalidate("presetstate");
  });
  on("select", syncControls);
  on("cues", syncControls);
  on("dock-tab", (tab) => {
    if (tab === "style" || scope === "global") return;
    scope = "global";
    lastStyleEdit = null;
    syncControls();
  });
  on("cue", ({ idx, what, from }) => {
    const cue = scopedCue();
    if (!cue || idx !== state.selectedIdx) return;
    if (what === "pos") syncControls();
    if (what === "style") {
      paintScope();
      invalidate("presetstate");
      if (from === "stage") ui.margin.set(resolveCueStyle(state.style, cue).margin_v);
    }
  });
  new ResizeObserver(() => invalidate("thumbs")).observe(grid);
  syncControls();
}

export { syncControls };
