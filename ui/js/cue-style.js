import { isMotion } from "./motion-path.js";
import { ANIM_BY_ID, sampleAnim } from "./lyrics-data.js";

const color = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const fadeTime = (v) => Number.isInteger(v) && v >= 0;
const RULES = {
  order: (v) => v === "zh_top" || v === "en_top",
  margin_v: Number.isFinite,
  line_gap: Number.isFinite,
  blur: Number.isFinite,
  box_mode: (v) => typeof v === "boolean",
  box_color: color,
  box_opacity: Number.isFinite,
  fade_in_ms: fadeTime,
  fade_out_ms: fadeTime,
  anim: (v) => typeof v === "string" && ANIM_BY_ID.has(v),
  anim_mult: (v) => Number.isFinite(v) && v > 0,
  sub_anim: (v) => typeof v === "boolean",
};
const TEXT_RULES = {
  font: (v) => typeof v === "string" && Boolean(v.trim()) && !/[\r\n]/.test(v),
  size: Number.isFinite,
  scale_x: Number.isFinite,
  outline: Number.isFinite,
  shadow: Number.isFinite,
  color,
  gradient: (v) => v === null || (Array.isArray(v) && v.length === 4 && v.every(color)),
  outline_color: color,
  secondary_color: color,
  back_color: color,
  back_opacity: Number.isFinite,
  margin_l: Number.isFinite,
  margin_r: Number.isFinite,
  bold: (v) => typeof v === "boolean",
  italic: (v) => typeof v === "boolean",
};

function validFields(value, rules) {
  return Object.fromEntries(Object.entries(rules).filter(([key, valid]) => valid(value?.[key]))
    .map(([key]) => [key, value[key]]));
}

export function normalizeCueStyle(value) {
  const result = validFields(value, RULES);
  for (const lang of ["zh", "en"]) {
    const fields = validFields(value?.[lang], TEXT_RULES);
    if (Object.keys(fields).length) result[lang] = fields;
  }
  return Object.keys(result).length ? result : undefined;
}

export const isStaticNote = (cue) => cue?.pos === "top" && !isMotion(cue);

export function inheritedCueStyle(style, cue) {
  if (!isStaticNote(cue)) return style;
  return {
    ...style, margin_v: 40, box_mode: false, blur: style.box_mode ? 0 : style.blur,
    zh: {
      font: "Microsoft YaHei", size: 75, color: style.zh?.color || "#B7B7B7",
      outline_color: "#000000", back_color: "#000000", outline: 1, shadow: 1,
      scale_x: 90, margin_l: 10, margin_r: 10, bold: true, italic: false,
    },
  };
}

export function resolveCueStyle(style, cue) {
  const base = inheritedCueStyle(style, cue);
  const override = cue?.style_override;
  if (!override) return base;
  return {
    ...base, ...override,
    zh: { ...base.zh, ...override.zh },
    en: { ...base.en, ...override.en },
  };
}

export function cueOpacity(style, cue, ms) {
  const duration = cue.end_ms - cue.start_ms;
  if (!(duration > 0) || !Number.isFinite(ms)) return 1;
  const fadeIn = Math.max(0, Number(style.fade_in_ms) || 0);
  const fadeOut = Math.max(0, Number(style.fade_out_ms) || 0);
  if (!fadeIn && !fadeOut) return 1;
  const scale = Math.min(1, duration / (fadeIn + fadeOut));
  const ramp = Math.floor(fadeIn * scale);
  const tail = Math.floor(fadeOut * scale);
  return Math.max(0, Math.min(1, ramp ? (ms - cue.start_ms) / ramp : 1, tail ? (cue.end_ms - ms) / tail : 1));
}

export function cueKinetic(style, cue, ms, isSub = false) {
  const baseBlur = style.box_mode ? 0 : Math.max(0, Number(style.blur) || 0);
  const fadeAlpha = cue ? cueOpacity(style, cue, ms) : 1;
  const animId = isSub && style.sub_anim === false ? "none" : (style.anim || "none");
  const elapsed = cue && Number.isFinite(ms) && Number.isFinite(cue.start_ms) ? Math.max(0, ms - cue.start_ms) : Infinity;
  const k = sampleAnim(animId, style.anim_mult ?? 1, baseBlur, elapsed);
  return {
    opacity: fadeAlpha * k.alpha,
    scale: k.scale,
    blur: style.box_mode ? 0 : k.blur,
  };
}

export function cueNeedsTick(style, cue, ms) {
  if (!cue || !Number.isFinite(ms)) return false;
  if (cueOpacity(style, cue, ms) < 1) return true;
  const animId = style.anim;
  if (!animId || animId === "none") return false;
  const { activeWindowMs } = sampleAnim(animId, style.anim_mult ?? 1, 0, 0);
  return ms >= cue.start_ms && ms <= cue.start_ms + activeWindowMs + 50;
}
