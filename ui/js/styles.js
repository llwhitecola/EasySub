/* Style tab: preset wall, layout controls, per-language type controls. */

import { $, $$, byId, h, icon } from "./util.js";
import { emit, invalidate, on, registerDraw, state } from "./store.js";
import { bindSeg, makeFader, makeWell } from "./controls.js";
import { confirmBox, toast, withBusy } from "./feedback.js";
import { call } from "./bridge.js";
import { drawCue, fitCanvas, fontStack, isFontInstalled } from "./subs-render.js";
import { sceneHues } from "./scenes.js";

const ZH_FONTS = [
  ["WenQuanYi Micro Hei", "文泉驿微米黑（美剧默认）"],
  ["Microsoft YaHei", "微软雅黑（清晰百搭）"],
  ["ZhunYuan", "准圆"],
  ["Source Han Sans CN", "思源黑体"],
  ["SimHei", "黑体"],
  ["SimSun", "宋体（文艺电影感）"],
  ["KaiTi", "楷体（温润纪录片）"],
  ["DengXian", "等线（现代极简）"],
];
const EN_FONTS = [
  ["ITCAvantGardePro-Demi", "ITC Avant Garde（美剧默认）"],
  ["Cronos Pro", "Cronos Pro（天空英语）"],
  ["Avenir Next W1G", "Avenir Next W1G"],
  ["Segoe UI", "Segoe UI（现代无衬线）"],
  ["Arial", "Arial（经典百搭）"],
  ["Georgia", "Georgia（优雅衬线）"],
  ["Trebuchet MS", "Trebuchet MS"],
  ["WenQuanYi Micro Hei", "文泉驿微米黑"],
];

const THUMB_CUE = { zh: "双语字幕", en: "Bilingual" };
const ui = { zh: {}, en: {} };
let orderSeg;
let langSeg;

/* ---------- preset ⇄ style ---------- */
export function styleFromPreset(p) {
  const s = structuredClone(p);
  for (const k of ["id", "name", "desc", "is_custom"]) delete s[k];
  s.line_gap ??= 4;
  s.blur ??= 0.8;
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

function styleChanged() {
  state.dirty = true;
  emit("style", {});
  invalidate("presetstate");
}

/* ---------- preset wall ---------- */
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
  for (const card of $$(".preset")) {
    const on_ = card.dataset.id === state.activePresetId;
    card.setAttribute("aria-checked", String(on_));
    card.classList.toggle("active", on_);
  }
  const p = activePreset();
  const mod = isModified();
  const name = p ? p.name : "自定义样式";
  byId("presetNow").textContent = name;
  byId("presetModified").hidden = !mod;
  byId("btnStyleReset").hidden = !mod;
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
    state.style[lang].font = sel.value;
    sync(sel.value);
    styleChanged();
  });
  return { root: h("div", { class: "lbl" }, h("span", {}, "字体"), sel, hint), set: sync };
}

function buildLangCard(lang) {
  const root = byId(lang === "zh" ? "cardZh" : "cardEn");
  const u = ui[lang];
  const bindNum = (field) => (v) => {
    state.style[lang][field] = v;
    styleChanged();
  };
  u.font = fontSelect(lang, lang === "zh" ? ZH_FONTS : EN_FONTS);
  u.size = makeFader({ label: "字号", min: lang === "zh" ? 26 : 18, max: lang === "zh" ? 110 : 90, onInput: bindNum("size") });
  u.scale_x = makeFader({ label: "字宽", unit: "%", min: 75, max: 115, onInput: bindNum("scale_x") });
  u.outline = makeFader({ label: "描边", min: 0, max: 6, step: 0.1, onInput: bindNum("outline") });
  u.shadow = makeFader({ label: "阴影", min: 0, max: 6, step: 0.1, onInput: bindNum("shadow") });
  u.color = makeWell({ label: "文字", onInput: (v) => { state.style[lang].color = v; styleChanged(); } });
  u.outline_color = makeWell({ label: "描边", onInput: (v) => { state.style[lang].outline_color = v; styleChanged(); } });
  for (const key of ["bold", "italic"]) {
    const btn = h("button", {
      class: "icon-btn", type: "button", "data-tip": key === "bold" ? "粗体" : "斜体", "aria-label": key === "bold" ? "粗体" : "斜体",
      onclick: () => {
        state.style[lang][key] = !state.style[lang][key];
        btn.setAttribute("aria-pressed", String(Boolean(state.style[lang][key])));
        styleChanged();
      },
    }, icon(key));
    u[key] = btn;
  }
  root.append(
    h(
      "header", {},
      h("b", {}, lang === "zh" ? "中文" : "英文"),
      h("div", { class: "lang-toggles" }, u.bold, u.italic),
    ),
    u.font.root,
    h("div", { class: "fader-grid" }, u.size.root, u.scale_x.root, u.outline.root, u.shadow.root),
    h("div", { class: "well-grid" }, u.color.root, u.outline_color.root),
  );
}

function syncControls() {
  const s = state.style;
  orderSeg.set(s.order === "en_top" ? "en_top" : "zh_top");
  langSeg.set(state.langMode);
  byId("chkBox").checked = Boolean(s.box_mode);
  ui.margin.set(s.margin_v);
  ui.gap.set(s.line_gap);
  ui.blur.set(s.blur);
  byId("faderBlur").classList.toggle("muted", Boolean(s.box_mode));
  const base = activePreset() ? styleFromPreset(activePreset()) : null;
  ui.margin.setReset(base?.margin_v ?? null);
  ui.gap.setReset(base?.line_gap ?? null);
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
  const grid = byId("presetGrid");
  const pick = (card) => {
    const p = state.presets.find((x) => x.id === card.dataset.id);
    if (!p) return;
    applyStyle(p, p.id);
    state.dirty = true;
  };
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".preset");
    if (!card) return;
    if (e.target.closest(".preset-del")) {
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
    state.style.order = v;
    styleChanged();
  });
  langSeg = bindSeg(byId("langSeg"), (v) => {
    state.langMode = v;
    emit("style", {});
  });
  byId("chkBox").addEventListener("change", (e) => {
    state.style.box_mode = e.target.checked;
    byId("faderBlur").classList.toggle("muted", e.target.checked);
    styleChanged();
  });

  const fader = (slot, opt, key) => {
    const f = makeFader({ ...opt, onInput: (v) => { state.style[key] = v; styleChanged(); } });
    byId(slot).append(f.root);
    return f;
  };
  ui.margin = fader("faderMargin", { label: "距底高度", min: 0, max: 400 }, "margin_v");
  ui.gap = fader("faderGap", { label: "中英间距", min: -8, max: 28 }, "line_gap");
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
    if (info?.from === "stage") ui.margin.set(state.style.margin_v);
    invalidate("presetstate");
  });
  new ResizeObserver(() => invalidate("thumbs")).observe(grid);
  syncControls();
}

export { syncControls };
