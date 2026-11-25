import { isMotion } from "./motion-path.js";

const RULES = {
  order: (v) => v === "zh_top" || v === "en_top",
  margin_v: Number.isFinite,
  line_gap: Number.isFinite,
  blur: Number.isFinite,
  box_mode: (v) => typeof v === "boolean",
};
const color = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const TEXT_RULES = {
  font: (v) => typeof v === "string" && Boolean(v.trim()) && !/[\r\n]/.test(v),
  size: Number.isFinite,
  scale_x: Number.isFinite,
  outline: Number.isFinite,
  shadow: Number.isFinite,
  color,
  outline_color: color,
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
