/* The empty stage speaks two languages: a small rotating bilingual headline. */

import { byId, h, prefersReducedMotion } from "./util.js";

const LINES = [
  ["让每一句，都被听懂", "So every line is understood"],
  ["听见，然后看见", "Heard, then seen"],
  ["两种语言，一条时间线", "Two languages, one timeline"],
  ["把对白放到恰好的那一帧", "Dialogue, on exactly the right frame"],
];
const HOLD_MS = 5600;

let at = 0;
let timer = 0;

/** Characters arrive one by one; Latin text moves word by word so kerning survives. */
function spell(host, text, delay, step, byWord) {
  const units = byWord ? text.split(/(?<= )/) : [...text];
  host.replaceChildren(...units.map((u, i) => h("span", { class: "ch", style: `animation-delay:${Math.round(delay + i * step)}ms` }, u)));
}

function show() {
  const [zh, en] = LINES[at];
  const zhEl = byId("heroZh");
  const enEl = byId("heroEn");
  if (prefersReducedMotion()) {
    zhEl.textContent = zh;
    enEl.textContent = en;
    return;
  }
  spell(zhEl, zh, 0, 46, false);
  spell(enEl, en, 260, 70, true);
}

function idle() {
  const root = document.documentElement.classList;
  return document.hidden || root.contains("has-media") || root.contains("is-playing");
}

export function startHero() {
  show();
  clearInterval(timer);
  timer = setInterval(() => {
    if (idle()) return;
    const host = byId("stageHero");
    host.classList.add("swap");
    setTimeout(() => {
      at = (at + 1) % LINES.length;
      show();
      host.classList.remove("swap");
    }, 320);
  }, HOLD_MS);
}
