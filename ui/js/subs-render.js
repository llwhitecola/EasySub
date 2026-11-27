/**
 * Subtitle renderer for the preview.
 *
 * It mirrors core/subtitles.py → export_ass() and libass' own geometry, so what
 * you see is what lands in the exported file:
 *   · an ASS font size is the font's ascent + descent, NOT a CSS em, so every
 *     size is normalised by the font's real metrics;
 *   · each line sits at its own MarginV, computed with the exporter's formula;
 *   · \blur softens the outline and the shadow while the glyph fill stays crisp.
 */

import { hexToRgba } from "./util.js";
import { trimmed } from "./store.js";
import { cueKinetic, resolveCueStyle } from "./cue-style.js";
import { parseHex } from "./lyrics-data.js";

const PLAY_W = 1920;
const PLAY_H = 1080;
/** libass: gaussian sigma for \blur1 at script resolution (2 / sqrt(ln 256)) */
const BLUR_SIGMA = 0.849;

const probe = document.createElement("canvas").getContext("2d");
const metricsCache = new Map();
const installedCache = new Map();
const gradientTileCache = new Map();
const glyphScratch = document.createElement("canvas");
const glyphCtx = glyphScratch.getContext("2d");

function bilinearTile(corners) {
  const key = corners.join("|");
  let tile = gradientTileCache.get(key);
  if (tile) return tile;
  const N = 32;
  tile = document.createElement("canvas");
  tile.width = N;
  tile.height = N;
  const tctx = tile.getContext("2d");
  const img = tctx.createImageData(N, N);
  const [tl, tr, bl, br] = corners.map(parseHex);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    const v = y / (N - 1);
    for (let x = 0; x < N; x++) {
      const u = x / (N - 1);
      const off = (y * N + x) * 4;
      for (let c = 0; c < 3; c++) {
        d[off + c] = Math.round(
          (1 - u) * (1 - v) * tl[c] + u * (1 - v) * tr[c] + (1 - u) * v * bl[c] + u * v * br[c],
        );
      }
      d[off + 3] = 255;
    }
  }
  tctx.putImageData(img, 0, 0);
  gradientTileCache.set(key, tile);
  return tile;
}

const FONT_ALIASES = new Map([
  ["ITCAvantGardePro-Demi", ["ITC Avant Garde Gothic Pro"]],
  ["Cronos Pro", ["Cronos Pro Subhead"]],
  ["Avenir Next W1G", ["Avenir Next"]],
]);

const fontFamilyNames = (name) => [name, ...(FONT_ALIASES.get(name) ?? [])];
const quoteFontFamily = (name) => `"${String(name).replace(/["\\]/g, "")}"`;

export function fontStack(name) {
  const names = fontFamilyNames(name);
  if (name === "ITCAvantGardePro-Demi") names.push("Century Gothic");
  return [...names, "WenQuanYi Micro Hei", "Microsoft YaHei", "Segoe UI"]
    .map(quoteFontFamily)
    .join(", ") + ", sans-serif";
}

/** Check the configured name and its family aliases against generic font metrics. */
export function isFontInstalled(name) {
  if (installedCache.has(name)) return installedCache.get(name);
  const text = "永和字幕 AaGgQq 0123 Wmi";
  const width = (family) => {
    probe.font = `72px ${family}`;
    return probe.measureText(text).width;
  };
  const names = fontFamilyNames(name).map(quoteFontFamily);
  const ok = ["monospace", "serif", "sans-serif"].some((fallback) => {
    const baseline = width(fallback);
    return names.some((family) => Math.abs(width(`${family}, ${fallback}`) - baseline) > 0.4);
  });
  installedCache.set(name, ok);
  return ok;
}

function metrics(stack, weight, italic) {
  const key = `${italic}|${weight}|${stack}`;
  let m = metricsCache.get(key);
  if (!m) {
    probe.font = `${italic ? "italic " : ""}${weight} 1000px ${stack}`;
    const r = probe.measureText("国Ag");
    const asc = r.fontBoundingBoxAscent / 1000 || 0.9;
    const desc = r.fontBoundingBoxDescent / 1000 || 0.3;
    m = { asc, desc, sum: asc + desc };
    metricsCache.set(key, m);
  }
  return m;
}

/* ---------- line wrapping (ASS WrapStyle 0: evenly balanced) ---------- */
function tokenize(text) {
  // Break at spaces, and between CJK ideographs.
  return text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef][，。！？、；：,.!?…」』”’）]*|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]+|\s+/g) || [];
}

function greedy(ctx, tokens, maxW) {
  const lines = [];
  let cur = "";
  for (const tok of tokens) {
    const next = cur + tok;
    if (cur.trim() && ctx.measureText(next.trim()).width > maxW) {
      lines.push(cur.trim());
      cur = tok.trimStart();
    } else {
      cur = next;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

function wrap(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return [text];
  const tokens = tokenize(text);
  const base = greedy(ctx, tokens, maxW);
  if (base.length < 2) return base;
  let lo = maxW / base.length / 1.4;
  let hi = maxW;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (greedy(ctx, tokens, mid).length <= base.length) hi = mid;
    else lo = mid;
  }
  return greedy(ctx, tokens, hi);
}

/* ---------- export_ass() geometry, ported ---------- */
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

function estimateLines(text, size, scaleX, marginLR) {
  const avail = Math.max(600, PLAY_W - marginLR);
  const sx = Math.max(0.5, scaleX / 100);
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0) > 0x2e7f ? size * sx : size * 0.52 * sx;
  return Math.max(1, Math.ceil(w / avail));
}

/** BorderStyle 3 pads the drawn box by the same value the exporter writes as Outline. */
function boxOutline(cfg = {}) {
  return Math.max(6, num(cfg.outline, 2) * 3);
}

/* ---------- visible line gap ---------- */

const gapMetricsCache = new Map();

/** The line box the renderer will use: font size normalised to ascent + descent. */
function gapMetrics(cfg = {}) {
  const weight = cfg.bold ? 700 : 400;
  const stack = fontStack(cfg.font || "Microsoft YaHei");
  const size = num(cfg.size, 60);
  const key = `${weight}|${cfg.italic ? 1 : 0}|${stack}|${size}`;
  let m = gapMetricsCache.get(key);
  if (!m) {
    const fm = metrics(stack, weight, cfg.italic);
    const em = Math.max(0.01, size / fm.sum);
    m = { em, stack, weight, italic: Boolean(cfg.italic), asc: fm.asc * em, desc: fm.desc * em };
    gapMetricsCache.set(key, m);
  }
  return m;
}

/** Distance from a line's box top (or bottom) to where its ink starts. */
const rasterInkCache = new Map();

/** Rasterise a sample and return its real ink extents around the baseline. */
function rasterInk(cfg, sample) {
  const m = gapMetrics(cfg);
  const key = `${m.stack}|${m.weight}|${m.italic}|${m.em}|${sample}`;
  const cached = rasterInkCache.get(key);
  if (cached) return cached;
  const baseline = Math.ceil(m.asc) + 8;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(32, Math.ceil(m.em * sample.length * 1.3 + 24));
  canvas.height = Math.ceil(m.asc + m.desc + 20);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = `${m.italic ? "italic " : ""}${m.weight} ${m.em}px ${m.stack}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(sample, 8, baseline);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y++) {
    let on = false;
    const off = y * canvas.width * 4;
    for (let x = 0; x < canvas.width; x++) {
      if (data[off + x * 4 + 3] > 96) {
        on = true;
        break;
      }
    }
    if (on) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  const ink = top < 0 ? { ascent: 0, descent: 0 } : { ascent: baseline - top, descent: bottom - baseline };
  rasterInkCache.set(key, ink);
  return ink;
}

/** Distance from a line's box top (or bottom) to where its ink starts. */
function inkOffset(cfg, sample, edge) {
  const m = gapMetrics(cfg);
  const ink = rasterInk(cfg, sample);
  return edge === "top" ? m.asc - ink.ascent : m.desc - ink.descent;
}

/**
 * Ink correction for the two-line block, in script pixels: [lower top, upper bottom].
 * Aegisub has no vertical line-spacing parameter (its “Spacing” is horizontal letter
 * spacing), so the app defines the slider as the visible gap between the two lines and
 * sends the exporter the same correction the preview uses. The correction comes from
 * rasterised representative glyphs, so it follows the renderer's real ink rather than
 * the font's nominal ascent/descent.
 */
export function gapHint(style, zhText, enText) {
  const zh = String(zhText ?? "").trim();
  const en = String(enText ?? "").trim();
  const lowerIsEn = style?.order !== "en_top";
  const lowerText = lowerIsEn ? en : zh;
  const upperText = lowerIsEn ? zh : en;
  if (!lowerText || !upperText) return null;
  const lowerCfg = (lowerIsEn ? style.en : style.zh) ?? {};
  const upperCfg = (lowerIsEn ? style.zh : style.en) ?? {};
  const lowerSample = lowerIsEn ? "Hhbdk" : "国永";
  const upperSample = lowerIsEn ? "国永" : "gypq";
  return [inkOffset(lowerCfg, lowerSample, "top"), inkOffset(upperCfg, upperSample, "bottom")];
}

/**
 * Upper event's MarginV, in script pixels. `line_gap` is the visible gap between the two
 * lines' ink; the ink padding of each line comes from the font the preview draws with,
 * so the number stays a real pixel distance instead of adding the font's built-in air.
 * BorderStyle 3 measures between the drawn boxes instead.
 */
function lineMargin(style, upper = false) {
  const mv = Math.max(0, Math.trunc(num(style.margin_v, 15)));
  return upper && style.line_gap_mode === "ass_margin" ? Math.max(0, mv + Math.round(num(style.line_gap, 4))) : mv;
}

function upperMargin(style, zhText, enText, lowerIsEn) {
  if (style.line_gap_mode === "ass_margin") return lineMargin(style, true);
  const mv = lineMargin(style);
  const gap = Math.round(num(style.line_gap, 4));
  const lowerCfg = (lowerIsEn ? style.en : style.zh) ?? {};
  const upperCfg = (lowerIsEn ? style.zh : style.en) ?? {};
  const size = num(lowerCfg.size, lowerIsEn ? 47 : 70);
  const lr = lowerIsEn
    ? Math.trunc(num(lowerCfg.margin_l, 15)) + Math.trunc(num(lowerCfg.margin_r, 15))
    : Math.trunc(num(lowerCfg.margin_l, 10)) + Math.trunc(num(lowerCfg.margin_r, 11));
  const lowerText = lowerIsEn ? enText : zhText;
  const n = estimateLines(lowerText, size, num(lowerCfg.scale_x, lowerIsEn ? 95 : 93), lr);
  if (style.box_mode) {
    const pad = boxOutline(style.zh) + boxOutline(style.en);
    return Math.max(0, Math.round(mv + n * size + gap + pad));
  }
  const hint = gapHint(style, zhText, enText);
  const upperSize = num(upperCfg.size, lowerIsEn ? 70 : 47);
  const t = hint ? hint[0] : 0.25 * size;
  const b = hint ? hint[1] : 0.1 * upperSize;
  return Math.max(0, Math.round(mv + n * size - t - b + gap + 1));
}

/** How much of the frame's usable width this line takes (1 = exactly one full line). */
export function lineRatio(text, cfg) {
  const t = trimmed(text);
  if (!t || !cfg) return 0;
  const weight = cfg.bold ? 700 : 400;
  const stack = fontStack(cfg.font || "Microsoft YaHei");
  const em = num(cfg.size, 60) / metrics(stack, weight, cfg.italic).sum;
  probe.font = `${cfg.italic ? "italic " : ""}${weight} 100px ${stack}`;
  const w = (probe.measureText(t).width / 100) * em * (num(cfg.scale_x, 100) / 100);
  return w / (PLAY_W - num(cfg.margin_l, 10) - num(cfg.margin_r, 11));
}

/* ---------- drawing one event: returns its bounds ---------- */
function drawEvent(ctx, text, cfg, opt) {
  const { W, H, k, blur, box, marginV, top, scale = 1 } = opt;
  const weight = cfg.bold ? 700 : 400;
  const stack = fontStack(cfg.font || "Microsoft YaHei");
  const m = metrics(stack, weight, cfg.italic);
  const lineH = Math.max(1, num(cfg.size, 60) * k);
  const em = lineH / m.sum;
  const sx = Math.max(0.3, num(cfg.scale_x, 100) / 100);
  const ml = num(cfg.margin_l, 10) * k;
  const mr = num(cfg.margin_r, 11) * k;

  ctx.save();
  ctx.globalAlpha *= opt.opacity;
  ctx.font = `${cfg.italic ? "italic " : ""}${weight} ${em}px ${stack}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const lines = text.split("\n").flatMap((t) => wrap(ctx, t, Math.max(20, (W - ml - mr) / sx)));
  const cx = opt.x ?? (ml + (W - mr)) / 2;
  const pivotY = top ? marginV * k : H - marginV * k;
  if (Math.abs(scale - 1) > 0.001) {
    ctx.translate(cx, pivotY);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -pivotY);
  }
  const baselines = lines.map((_, i) =>
    top
      ? marginV * k + i * lineH + m.asc * em
      : H - marginV * k - (lines.length - 1 - i) * lineH - m.desc * em,
  );

  const outline = num(cfg.outline, 0) * k;
  const shadow = num(cfg.shadow, 0) * k;
  const sigma = blur * k * BLUR_SIGMA;

  const each = (fn) =>
    lines.forEach((line, i) => {
      ctx.save();
      ctx.translate(cx, baselines[i]);
      ctx.scale(sx, 1);
      fn(line);
      ctx.restore();
    });

  if (box) {
    // BorderStyle 3: one opaque box per line, padded by the outline width.
    const pad = Math.max(6, num(cfg.outline, 2) * 3) * k;
    ctx.fillStyle = hexToRgba(box.color, box.opacity);
    lines.forEach((line, i) => {
      const w = ctx.measureText(line).width * sx;
      const y = baselines[i] - m.asc * em;
      ctx.fillRect(cx - w / 2 - pad, y - pad, w + pad * 2, lineH + pad * 2);
    });
  } else {
    const ink = (color) => {
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = outline * 2;
      each((line) => {
        ctx.fillText(line, 0, 0);
        if (outline > 0.02) ctx.strokeText(line, 0, 0);
      });
    };
    const soft = sigma > 0.12 ? `blur(${sigma.toFixed(2)}px)` : "none";
    if (shadow > 0.05) {
      ctx.save();
      ctx.translate(shadow, shadow);
      ctx.filter = soft;
      ink(hexToRgba(cfg.back_color || "#000000", num(cfg.back_opacity, 1)));
      ctx.restore();
    }
    if (outline > 0.02) {
      ctx.save();
      ctx.filter = soft;
      ink(cfg.outline_color || "#000000");
      ctx.restore();
    }
    // With no outline at all, \blur softens the fill itself.
    if (outline <= 0.02) ctx.filter = soft;
  }

  const grad = Array.isArray(cfg.gradient) && cfg.gradient.length === 4 ? cfg.gradient : null;
  if (!grad || (grad[0] === grad[1] && grad[1] === grad[2] && grad[2] === grad[3])) {
    ctx.fillStyle = grad ? grad[0] : (cfg.color || "#FFFFFF");
    each((line) => ctx.fillText(line, 0, 0));
  } else if (grad[0] === grad[1] && grad[2] === grad[3]) {
    each((line) => {
      const g = ctx.createLinearGradient(0, -m.asc * em, 0, m.desc * em);
      g.addColorStop(0, grad[0]);
      g.addColorStop(1, grad[2]);
      ctx.fillStyle = g;
      ctx.fillText(line, 0, 0);
    });
  } else if (grad[0] === grad[2] && grad[1] === grad[3]) {
    each((line) => {
      const hw = Math.max(8, ctx.measureText(line).width / 2);
      const g = ctx.createLinearGradient(-hw, 0, hw, 0);
      g.addColorStop(0, grad[0]);
      g.addColorStop(1, grad[1]);
      ctx.fillStyle = g;
      ctx.fillText(line, 0, 0);
    });
  } else {
    const tile = bilinearTile(grad);
    const rawH = Math.max(12, Math.ceil((m.asc + m.desc) * em + 8));
    const baseY = Math.ceil(m.asc * em + 4);
    each((line) => {
      const rawW = Math.max(12, Math.ceil(ctx.measureText(line).width + em * 0.3));
      if (glyphScratch.width < rawW) glyphScratch.width = rawW;
      if (glyphScratch.height < rawH) glyphScratch.height = rawH;
      glyphCtx.globalCompositeOperation = "source-over";
      glyphCtx.clearRect(0, 0, rawW, rawH);
      glyphCtx.font = ctx.font;
      glyphCtx.textAlign = "center";
      glyphCtx.textBaseline = "alphabetic";
      glyphCtx.fillStyle = "#ffffff";
      glyphCtx.fillText(line, rawW / 2, baseY);
      glyphCtx.globalCompositeOperation = "source-in";
      glyphCtx.imageSmoothingEnabled = true;
      glyphCtx.drawImage(tile, 0, 0, rawW, rawH);
      ctx.drawImage(glyphScratch, 0, 0, rawW, rawH, -rawW / 2, -baseY, rawW, rawH);
    });
  }
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width)) * sx;
  ctx.restore();
  return {
    x1: cx - widest / 2,
    x2: cx + widest / 2,
    y1: baselines[0] - m.asc * em,
    y2: baselines.at(-1) + m.desc * em,
  };
}

const union = (a, b) =>
  a && b ? { x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2), y1: Math.min(a.y1, b.y1), y2: Math.max(a.y2, b.y2) } : a || b;

/**
 * Draw one cue onto a W×H canvas (device pixels). Returns its bounds, or null.
 * zoom > 1 magnifies around the bottom centre: used by the preset thumbnails.
 */
export function drawCue(ctx, { W, H, cue, style, langMode = "bilingual", zoom = 1, anchor, timeMs }) {
  style = resolveCueStyle(style, cue);
  const k = (H / PLAY_H) * zoom;
  const mainKin = cueKinetic(style, cue, timeMs, false);
  const subKin = cueKinetic(style, cue, timeMs, true);
  let zh = trimmed(cue.zh);
  let en = trimmed(cue.en);
  if (langMode === "zh_only") en = "";
  if (langMode === "en_only") zh = "";
  const zhTop = style.order !== "en_top";
  const box = style.box_mode ? { color: style.box_color, opacity: num(style.box_opacity, 0.6) } : null;

  if (anchor) {
    if (!zh) return null;
    return drawEvent(ctx, zh, style.zh, {
      W, H, k, ...mainKin, box, marginV: (1 - anchor[1]) * PLAY_H, top: false, x: anchor[0] * W,
    });
  }

  if (cue.pos === "top") {
    const text = (zhTop ? [zh, en] : [en, zh]).filter(Boolean).join("\n");
    if (!text) return null;
    return drawEvent(
      ctx,
      text,
      style.zh,
      { W, H, k, ...mainKin, box, marginV: Math.max(0, num(style.margin_v, 40)), top: true },
    );
  }

  const mv = lineMargin(style);
  const opt = (marginV, kin) => ({ W, H, k, ...kin, box, marginV, top: false });

  if (zh && en) {
    const lowerIsEn = zhTop;
    const upperMv = upperMargin(style, zh, en, lowerIsEn);
    // Layer 0 (lower line) first, then Layer 1 (upper line), as libass composites them.
    const lower = drawEvent(ctx, lowerIsEn ? en : zh, lowerIsEn ? style.en : style.zh, opt(mv, subKin));
    const upper = drawEvent(ctx, lowerIsEn ? zh : en, lowerIsEn ? style.zh : style.en, opt(upperMv, mainKin));
    return union(lower, upper);
  }
  if (zh) return drawEvent(ctx, zh, style.zh, opt(lineMargin(style, zhTop), mainKin));
  if (en) return drawEvent(ctx, en, style.en, opt(lineMargin(style, !zhTop), mainKin));
  return null;
}

/** Fit a canvas to its CSS box at device resolution. Returns { ctx, W, H, dpr }. */
export function fitCanvas(canvas, maxDpr = 2.5) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const H = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  return { ctx: canvas.getContext("2d"), W, H, dpr };
}
