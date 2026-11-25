/* Thin wrapper around window.pywebview.api.* */

import { toast } from "./feedback.js";

export const hasApi = () => typeof window.pywebview?.api?.get_initial_bootstrap === "function";

/** Resolves once the desktop bridge is usable. A slow machine may take many seconds. */
export function whenReady() {
  if (hasApi()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!hasApi()) return;
      clearInterval(poll);
      window.removeEventListener("pywebviewready", check);
      resolve();
    };
    // The module may load after pywebviewready already fired, so poll as well.
    const poll = setInterval(check, 80);
    window.addEventListener("pywebviewready", check);
  });
}

/**
 * Call a backend method. Never throws: failures come back as { ok: false, error }.
 * A missing bridge shows one clear message instead of doing nothing.
 */
export async function call(method, ...args) {
  const fn = window.pywebview?.api?.[method];
  if (typeof fn !== "function") {
    toast("桌面后端尚未就绪，请在 EasySub 客户端窗口中使用此功能", { type: "error" });
    return { ok: false, offline: true };
  }
  try {
    return (await fn(...args)) ?? { ok: false };
  } catch (err) {
    console.error(`[bridge:${method}]`, err);
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Same as call() but stays silent when the bridge is missing (background work). */
export async function callQuiet(method, ...args) {
  if (typeof window.pywebview?.api?.[method] !== "function") return { ok: false, offline: true };
  return call(method, ...args);
}
