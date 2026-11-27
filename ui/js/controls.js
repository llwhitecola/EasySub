/* Reusable controls: segmented, fader, colour well. */

import { $$, clamp, h } from "./util.js";

/* ---------- segmented control ---------- */
export function bindSeg(root, onChange, attr = "aria-checked") {
  const buttons = $$("button", root);
  const paint = (animate = true) => {
    const active = buttons.find((b) => b.getAttribute(attr) === "true");
    if (!active || !active.offsetWidth) return;
    root.classList.toggle("no-anim", !animate);
    root.style.setProperty("--x", `${active.offsetLeft}px`);
    root.style.setProperty("--w", `${active.offsetWidth}px`);
  };
  const set = (value, { silent = true, animate = true } = {}) => {
    for (const b of buttons) {
      const on = b.dataset.value === value;
      b.setAttribute(attr, String(on));
      b.tabIndex = on ? 0 : -1;
    }
    paint(animate);
    if (!silent) onChange?.(value);
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && root.contains(b) && b.getAttribute(attr) !== "true") set(b.dataset.value, { silent: false });
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const usable = buttons.filter((b) => !b.hidden);
    const at = usable.indexOf(document.activeElement);
    const next = usable[(at + (e.key === "ArrowRight" ? 1 : -1) + usable.length) % usable.length];
    next.focus();
    set(next.dataset.value, { silent: false });
  });
  // Hidden tabs measure 0 wide; re-measure as soon as they become visible.
  new ResizeObserver(() => paint(false)).observe(root);
  return { set, paint };
}

/* ---------- fader: slider + typed value ---------- */
export function makeFader({ label, min, max, step = 1, unit = "", onInput, tip = "" }) {
  const range = h("input", { class: "range", type: "range", min: String(min), max: String(max), step: String(step), "aria-label": label });
  const num = h("input", { class: "fader-num", type: "number", min: String(min), max: String(max), step: String(step), "aria-label": `${label}数值` });
  const decimals = (String(step).split(".")[1] || "").length;
  let reset = null;

  const root = h(
    "div",
    { class: "fader" },
    h("div", { class: "fader-head" }, h("span", tip ? { "data-tip": tip } : {}, label + (unit ? ` ${unit}` : "")), num),
    range,
  );
  const fill = () => range.style.setProperty("--p", `${((Number(range.value) - min) / (max - min)) * 100}%`);
  const show = (v) => {
    const fixed = Number(v).toFixed(decimals);
    if (document.activeElement !== num) num.value = decimals ? String(Number(fixed)) : fixed;
  };
  const set = (v) => {
    range.value = String(v);
    show(v);
    fill();
  };
  const apply = (v) => {
    const val = Number(clamp(v, min, max).toFixed(decimals));
    set(val);
    onInput(val);
  };
  range.addEventListener("input", () => {
    show(range.value);
    fill();
    onInput(Number(range.value));
  });
  range.addEventListener("dblclick", () => reset !== null && apply(reset));
  range.addEventListener("wheel", (e) => {
    if (document.activeElement !== range) return; // never hijack panel scrolling
    e.preventDefault();
    apply(Number(range.value) + (e.deltaY < 0 ? step : -step));
  }, { passive: false });
  const commitNum = () => {
    const v = Number(num.value);
    if (num.value.trim() === "" || !Number.isFinite(v)) set(Number(range.value));
    else apply(v);
    num.value = decimals ? String(Number(Number(range.value).toFixed(decimals))) : String(Number(range.value));
  };
  num.addEventListener("change", commitNum);
  num.addEventListener("keydown", (e) => {
    if (e.key === "Enter") num.blur();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      apply(Number(num.value || range.value) + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1));
      num.value = String(Number(Number(range.value).toFixed(decimals)));
    }
  });
  num.addEventListener("focus", () => num.select());
  const setLimits = (lower, upper) => {
    if (min === lower && max === upper) return;
    min = lower;
    max = upper;
    range.min = num.min = String(min);
    range.max = num.max = String(max);
    fill();
  };
  return { root, set, setLimits, setReset: (v) => { reset = v; } };
}

/* ---------- colour well ---------- */
export function makeWell({ label, onInput }) {
  const picker = h("input", { type: "color", "aria-label": label });
  const text = h("input", { type: "text", maxlength: "7", spellcheck: "false", "aria-label": `${label}色值` });
  const root = h("div", { class: "lbl" }, h("span", {}, label), h("div", { class: "well" }, picker, text));
  const set = (hex) => {
    const v = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex.toUpperCase() : "#000000";
    picker.value = v;
    if (document.activeElement !== text) text.value = v;
  };
  picker.addEventListener("input", () => {
    set(picker.value);
    onInput(picker.value.toUpperCase());
  });
  text.addEventListener("input", () => {
    let v = text.value.trim();
    if (v && !v.startsWith("#")) v = `#${v}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      picker.value = v;
      onInput(v.toUpperCase());
    }
  });
  text.addEventListener("change", () => {
    text.value = picker.value.toUpperCase();
  });
  text.addEventListener("keydown", (e) => e.key === "Enter" && text.blur());
  return { root, set };
}

/* ---------- plain range fill (for ranges written in HTML) ---------- */
export function paintRange(range) {
  const min = Number(range.min || 0);
  const max = Number(range.max || 100);
  range.style.setProperty("--p", `${((Number(range.value) - min) / (max - min)) * 100}%`);
}
