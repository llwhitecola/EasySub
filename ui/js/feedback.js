/* Toasts, tooltips, modal manager, confirm dialog, menus. */

import { $, $$, byId, clamp, h, icon } from "./util.js";

/* ---------- toasts ---------- */
const MAX_TOASTS = 3;
const TOAST_ICON = { success: "check", error: "alert", info: "info" };

export function toast(message, { type = "info", action = null, ms = 0, key = "" } = {}) {
  const box = byId("toasts");
  if (!box || !message) return;

  // Same-key toasts update in place instead of stacking up.
  if (key) {
    const twin = $(`[data-key="${key}"]`, box);
    if (twin) twin.remove();
  }
  const node = h(
    "div",
    { class: `toast toast-${type}`, role: type === "error" ? "alert" : "status", dataset: key ? { key } : {} },
    icon(TOAST_ICON[type] || "info"),
    h("span", {}, message),
  );
  if (action) {
    node.append(
      h("button", {
        class: "toast-act",
        type: "button",
        onclick: () => {
          dismiss();
          action.run();
        },
      }, action.label),
    );
  }
  let timer = 0;
  const life = ms || (type === "error" ? 6500 : action ? 5200 : 3200);
  const dismiss = () => {
    clearTimeout(timer);
    if (node.classList.contains("out")) return;
    node.classList.add("out");
    setTimeout(() => node.remove(), 240);
  };
  const arm = () => {
    timer = setTimeout(dismiss, life);
  };
  node.addEventListener("pointerenter", () => clearTimeout(timer));
  node.addEventListener("pointerleave", arm);
  box.prepend(node);
  arm();
  const live = $$(".toast:not(.out)", box);
  live.slice(MAX_TOASTS).forEach((n) => {
    n.classList.add("out");
    setTimeout(() => n.remove(), 240);
  });
}

/* ---------- tooltips (data-tip / data-keys) ---------- */
export function initTooltips() {
  const tip = byId("tip");
  let timer = 0;
  let current = null;
  let warmUntil = 0;

  const hide = () => {
    clearTimeout(timer);
    if (current) warmUntil = performance.now() + 260;
    current = null;
    tip.classList.remove("on");
  };
  const place = (target) => {
    if (!target.isConnected) return hide();
    tip.textContent = target.dataset.tip;
    const keys = (target.dataset.keys || "").split(" ").filter(Boolean);
    if (keys.length) tip.append(h("span", { class: "tip-keys" }, ...keys.map((k) => h("kbd", {}, k))));
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const ht = tip.offsetHeight;
    const x = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8);
    const below = r.bottom + 8 + ht < innerHeight - 4;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(below ? r.bottom + 8 : r.top - ht - 8)}px`;
    tip.classList.add("on");
  };
  document.addEventListener("pointerover", (e) => {
    const target = e.target.closest?.("[data-tip]");
    if (target === current) return;
    hide();
    if (!target || !target.dataset.tip || e.pointerType === "touch") return;
    current = target;
    timer = setTimeout(() => current === target && place(target), performance.now() < warmUntil ? 60 : 480);
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  window.addEventListener("blur", hide);
  document.addEventListener("scroll", hide, true);
}

/* ---------- modals ---------- */
const stack = [];
const closeHooks = new Map();

// Keyboard users get their place back after a dialog; mouse users should not be
// left with a focus ring on the button they clicked a minute ago.
let lastInput = "pointer";
document.addEventListener("pointerdown", () => { lastInput = "pointer"; }, true);
document.addEventListener("keydown", () => { lastInput = "key"; }, true);

export const modalOpen = () => stack.length > 0;

export function openModal(id) {
  const node = byId(id);
  if (!node || stack.includes(node)) return;
  closeMenus();
  node._returnFocus = document.activeElement;
  node._byKey = lastInput === "key";
  node.hidden = false;
  clearTimeout(node._hideTimer);
  stack.push(node);
  syncInert();
  // Two frames: let the browser commit the hidden→visible change before transitioning.
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("open")));
  // rAF is paused in background windows; make sure the dialog never stays invisible.
  setTimeout(() => stack.includes(node) && node.classList.add("open"), 80);
  const focusTarget = $("[data-autofocus]", node) || $(".modal-x", node);
  setTimeout(() => stack.at(-1) === node && focusTarget?.focus({ preventScroll: true }), 40);
}

export function closeModal(id) {
  const node = byId(id);
  const at = stack.indexOf(node);
  if (at < 0) return;
  stack.splice(at, 1);
  node.classList.remove("open");
  node._hideTimer = setTimeout(() => {
    node.hidden = true;
  }, 220);
  syncInert();
  const back = node._returnFocus;
  if (!stack.length) {
    if (node._byKey && back?.isConnected) back.focus?.({ preventScroll: true });
    else document.activeElement?.blur?.();
  }
  closeHooks.get(id)?.();
}
export const onModalClose = (id, fn) => closeHooks.set(id, fn);

function syncInert() {
  byId("app").inert = stack.length > 0;
  const top = stack.at(-1);
  for (const m of stack) m.inert = m !== top;
}

export function initModals() {
  document.addEventListener("click", (e) => {
    const closer = e.target.closest?.("[data-close]");
    if (closer) closeModal(closer.closest(".modal").id);
  });
  for (const m of $$(".modal")) {
    let downOnBackdrop = false;
    m.addEventListener("pointerdown", (e) => {
      downOnBackdrop = e.target === m;
    });
    m.addEventListener("click", (e) => {
      // Only when press and release are both on the backdrop: dragging a text
      // selection out of a field must not throw the dialog away.
      if (e.target === m && downOnBackdrop) closeModal(m.id);
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (!stack.length) return;
      const top = stack.at(-1);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeModal(top.id);
      } else if (e.key === "Tab") {
        const items = $$('button, input, select, textarea, [tabindex]:not([tabindex="-1"])', top).filter(
          (n) => !n.disabled && n.offsetParent !== null,
        );
        if (!items.length) return;
        const first = items[0];
        const last = items.at(-1);
        if (!top.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    true,
  );
}

let confirmQueue = Promise.resolve();
/** Promise<boolean>; a second question waits for the first one to be answered. */
export function confirmBox(options) {
  const next = confirmQueue.then(() => ask(options));
  confirmQueue = next.catch(() => {});
  return next;
}
function ask({ title, body, okLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    byId("confirmTitle").textContent = title;
    byId("confirmBody").textContent = body;
    const ok = byId("confirmOk");
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    let answer = false;
    ok.onclick = () => {
      answer = true;
      closeModal("modalConfirm");
    };
    onModalClose("modalConfirm", () => resolve(answer));
    openModal("modalConfirm"); // focus starts on Cancel: a stray Enter or Space is harmless
  });
}

/* ---------- popover menus ---------- */
function closeMenus() {
  for (const m of $$(".menu.open")) {
    m.classList.remove("open");
    m.previousElementSibling?.setAttribute("aria-expanded", "false");
  }
}
export function initMenus() {
  const closeAll = closeMenus;
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest?.("[data-menu]");
    if (trigger) {
      const menu = byId(trigger.dataset.menu);
      const willOpen = !menu.classList.contains("open");
      closeAll();
      menu.classList.toggle("open", willOpen);
      trigger.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) $("button", menu)?.focus({ preventScroll: true });
      return;
    }
    closeAll();
  });
  document.addEventListener("keydown", (e) => {
    const menu = $(".menu.open");
    if (!menu) return;
    const items = $$("button", menu);
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      menu.previousElementSibling?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  }, true);
}

/** Run an async job while its button shows it is busy; ignores repeat clicks. */
export async function withBusy(button, job) {
  if (button?.dataset.busy) return undefined;
  if (button) {
    button.dataset.busy = "1";
    button.setAttribute("aria-busy", "true");
  }
  try {
    return await job();
  } finally {
    if (button) {
      delete button.dataset.busy;
      button.removeAttribute("aria-busy");
    }
  }
}
