/* Small, dependency-free helpers shared by every module. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const byId = (id) => document.getElementById(id);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const pad2 = (n) => String(n).padStart(2, "0");

/** Create an element: h("div", { class: "x", onclick }, child, "text") */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (val === undefined || val === null || val === false) continue;
    if (key === "class") node.className = val;
    else if (key === "dataset") Object.assign(node.dataset, val);
    else if (key.startsWith("on") && typeof val === "function") node.addEventListener(key.slice(2), val);
    else if (key in node && typeof val !== "string") node[key] = val;
    else node.setAttribute(key, val === true ? "" : val);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function icon(name, extra = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `i ${extra}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
export const iconHtml = (name, extra = "") =>
  `<svg class="i ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/** mm:ss.cc, or h:mm:ss.cc past an hour */
export function fmtTime(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  const totalSec = Math.floor(ms / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  const tail = `${pad2(mm)}:${pad2(ss)}.${pad2(cs)}`;
  return hh > 0 ? `${hh}:${tail}` : tail;
}

/** Ruler label: no fractions unless asked */
export function fmtRuler(sec, withTenths = false) {
  const s = Math.max(0, sec);
  const whole = Math.floor(s + 1e-6);
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const base = hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
  return withTenths ? `${base}.${Math.round((s - whole) * 10) % 10}` : base;
}

export const fmtDur = (ms) => `${Math.max(0, ms / 1000).toFixed(1)}s`;

/** Accepts "1:02.5", "00:01:02,50", "62.5", full-width punctuation. Returns ms or null. */
export function parseTime(str) {
  if (typeof str !== "string") return null;
  const clean = str.trim().replace(/[,，。]/g, ".").replace(/：/g, ":");
  if (!/^\d*(?::\d*){0,2}(?:\.\d*)?$/.test(clean) || !/\d/.test(clean)) return null;
  const parts = clean.split(":").map((p) => (p === "" ? 0 : Number(p)));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const sec = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Math.round(sec * 1000);
}

export function debounce(fn, wait) {
  let t = 0;
  const run = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  run.cancel = () => clearTimeout(t);
  return run;
}

export function cssVar(name, root = document.documentElement) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

export function hexToRgba(hex, alpha = 1) {
  let c = String(hex || "#000000").replace("#", "");
  if (c.length === 3) c = [...c].map((ch) => ch + ch).join("");
  const n = /^[0-9a-f]{6}$/i.test(c) ? parseInt(c, 16) : 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Deterministic PRNG, so generated scenes look the same every launch. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
