/* Window shell: theme, dock tabs, splitters, preferences, status bar, shortcuts. */

import { $$, byId, clamp, debounce, prefersReducedMotion } from "./util.js";
import { canRedo, canUndo, emit, invalidate, on, redo, redoLabel, state, undo, undoLabel } from "./store.js";
import { modalOpen, openModal, toast } from "./feedback.js";
import { bindSeg } from "./controls.js";
import { callQuiet } from "./bridge.js";
import { jumpCue, nudge, replayCue, seekTo, setVolume, togglePlay } from "./player.js";
import { deleteCue, markEndNext, markStart, selectCue, addCueAt } from "./cues.js";
import { inTheatre, setGuides, setSample, toggleTheatre } from "./stage.js";
import { setScene } from "./scenes.js";
import { refreshTimelineColors, setFollow } from "./timeline.js";
import { cueVisible, setSeekOnClick, stepCue } from "./script.js";
import { closeFind, openFind } from "./find.js";
import { openExport } from "./exporter.js";
import { openVideoDialog } from "./media.js";
import { openImport } from "./importer.js";
import { openPalette } from "./palette.js";
import { setMood, titleBarColor } from "./aura.js";

/* ---------- preferences: stored by the backend, because the local port (and
   therefore localStorage) changes every launch ---------- */
const persist = debounce(() => callQuiet("update_user_settings", { ui: state.prefs }), 500);
export function savePref(patch) {
  Object.assign(state.prefs, patch);
  if (state.settingsLoaded) persist(); // before that, saving would replace what is on disk
}

/* ---------- theme: light / dark, following the system until the user picks one ---------- */
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const THEMES = ["auto", "light", "dark"];
let themePref = "auto";

const systemTheme = () => (systemDark.matches ? "dark" : "light");
const resolveTheme = () => (themePref === "auto" ? systemTheme() : themePref);

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  refreshTimelineColors();
  emit("theme", theme);
  paintTitleBar();
}
// The native title bar continues the backdrop's colour.
const paintTitleBar = debounce(() => callQuiet("set_window_theme", resolveTheme(), titleBarColor()), 260);
let themeSeg;
function labelTheme() {
  themeSeg?.set(themePref);
}
function chooseTheme(pref) {
  const now = resolveTheme();
  themePref = pref;
  labelTheme();
  savePref({ theme: themePref });
  const next = resolveTheme();
  if (next === now) return;
  if (!document.startViewTransition || prefersReducedMotion() || document.hidden) return setTheme(next);

  // The new light opens out from the look button.
  const r = byId("btnTheme").getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document
    .startViewTransition(() => setTheme(next))
    .ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(.3,.6,.2,1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}
export function toggleTheme() {
  chooseTheme(resolveTheme() === "dark" ? "light" : "dark");
}
function bindLook() {
  themeSeg = bindSeg(byId("themeSeg"), chooseTheme);
  for (const b of $$("#moodList button")) {
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // keep the menu open so moods can be compared
      setMood(b.dataset.mood);
      savePref({ mood: b.dataset.mood });
    });
  }
  byId("themeSeg").addEventListener("click", (e) => e.stopPropagation());
}
systemDark.addEventListener("change", () => themePref === "auto" && setTheme(resolveTheme()));

/* ---------- dock tabs ---------- */
let tabSeg;
let tab = "script";
export function showTab(name) {
  if (inTheatre()) toggleTheatre(); // the dock is not on screen in focus mode
  if (name === tab) return;
  tab = name;
  tabSeg.set(name);
  for (const p of $$("#dock [data-tabpane]")) {
    const on_ = p.dataset.tabpane === name;
    p.hidden = !on_;
    if (on_ && !prefersReducedMotion()) {
      p.animate([{ opacity: 0, transform: `translateX(${name === "style" ? 14 : -14}px)` }, { opacity: 1, transform: "none" }], {
        duration: 240,
        easing: "cubic-bezier(.2,.75,.2,1)",
      });
    }
  }
  setSample(name === "style");
  invalidate("list", "thumbs");
}

/* ---------- splitters ---------- */
const DOCK_MIN = 420;
const REEL_MIN = 112;
let dockW = 0; // 0 = automatic
let reelH = 0;

function applySizes() {
  const root = byId("studio");
  const maxDock = Math.max(DOCK_MIN, innerWidth - 520);
  const maxReel = Math.max(REEL_MIN, innerHeight - 440);
  if (dockW) root.style.setProperty("--dock-w", `${clamp(dockW, DOCK_MIN, maxDock)}px`);
  else root.style.removeProperty("--dock-w");
  if (reelH) root.style.setProperty("--reel-h", `${clamp(reelH, REEL_MIN, maxReel)}px`);
  else root.style.removeProperty("--reel-h");
}
function bindSplitters() {
  const drag = (handle, onMove, onReset) => {
    let active = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      active = true;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("drag");
      document.body.classList.add("resizing");
    });
    handle.addEventListener("pointermove", (e) => {
      if (active && !(e.buttons & 1)) end();
      if (active) onMove(e);
    });
    const end = () => {
      if (!active) return;
      active = false;
      handle.classList.remove("drag");
      document.body.classList.remove("resizing");
      savePref({ dockW, reelH });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    handle.addEventListener("dblclick", () => {
      onReset();
      applySizes();
      savePref({ dockW, reelH });
    });
    handle.addEventListener("keydown", (e) => {
      const dir = { ArrowLeft: 1, ArrowUp: 1, ArrowRight: -1, ArrowDown: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      onMove(null, dir * 16);
      savePref({ dockW, reelH });
    });
  };
  drag(
    byId("splitV"),
    (e, step) => {
      const cur = byId("dock").offsetWidth;
      dockW = clamp(e ? innerWidth - e.clientX : cur + step, DOCK_MIN, Math.max(DOCK_MIN, innerWidth - 520));
      applySizes();
    },
    () => { dockW = 0; },
  );
  drag(
    byId("splitH"),
    (e, step) => {
      const box = byId("stripWrap").getBoundingClientRect();
      const toolbar = byId("reelBar").offsetHeight;
      const bottom = box.bottom;
      const cur = box.height;
      reelH = clamp(e ? bottom - e.clientY - toolbar : cur + step, REEL_MIN, Math.max(REEL_MIN, innerHeight - 440));
      applySizes();
    },
    () => { reelH = 0; },
  );
  addEventListener("resize", applySizes);
}

/* ---------- history buttons ---------- */
export function doUndo() {
  const label = undo();
  if (label === null) toast("没有可以撤销的操作", { key: "undo" });
  else emit("status", `已撤销：${label}`);
}
export function doRedo() {
  const label = redo();
  if (label !== null) emit("status", `已重做：${label}`);
}
function paintHistory() {
  const u = byId("btnUndo");
  const r = byId("btnRedo");
  u.disabled = !canUndo();
  r.disabled = !canRedo();
  u.dataset.tip = canUndo() ? `撤销：${undoLabel()}` : "没有可撤销的操作";
  r.dataset.tip = canRedo() ? `重做：${redoLabel()}` : "没有可重做的操作";
}

/* ---------- status line ---------- */
let statusTimer = 0;
function showStatus(text) {
  const n = byId("footStatus");
  n.textContent = text;
  n.classList.remove("ping");
  void n.offsetWidth;
  n.classList.add("ping");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => n.classList.remove("ping"), 2600);
}

/* ---------- shortcuts ---------- */
/** The on-screen button dips when its key is pressed. */
function tapButton(id) {
  const b = byId(id);
  b.classList.add("hit");
  setTimeout(() => b.classList.remove("hit"), 130);
}

const isTyping = (t) => t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.tagName === "INPUT" && !["checkbox", "range", "radio", "color", "button"].includes(t.type)));

function bindKeys() {
  addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Stop the browser's own reload / find / print / history keys everywhere.
    if (["F3", "F5", "F7"].includes(e.key) || (mod && ["f", "h", "p", "r", "s", "o", "j", "u", "g", "d", "k"].includes(key))) e.preventDefault();
    if (modalOpen()) return;

    const typing = isTyping(e.target);
    if (mod) {
      if (key === "k") return openPalette();
      if (key === "h") return openFind();
      if (key === "f") {
        showTab("script");
        byId("inpSearch").focus();
        return byId("inpSearch").select();
      }
      if (key === "o") return openVideoDialog(byId("btnOpenVideo"));
      if (key === "i" && !typing) return openImport("open");
      if (key === "s") return openExport();
      if (!typing && key === "z") {
        e.preventDefault();
        return e.shiftKey ? doRedo() : doUndo();
      }
      if (!typing && key === "y") {
        e.preventDefault();
        return doRedo();
      }
      return;
    }
    if (e.altKey) return;

    // Holding a key must not mark one line after another.
    const ONCE = ["F2", "F3", "F4", "F5", "F1"];
    const ONCE_IDLE = [" ", "[", "]", "t", "T", "Insert", "Delete", "Enter", "?"];
    if (e.repeat && (ONCE.includes(e.key) || (!typing && ONCE_IDLE.includes(e.key)))) return e.preventDefault();

    // Timing keys work while typing in a subtitle box.
    switch (e.key) {
      case "F2": e.preventDefault(); return togglePlay();
      case "F3": tapButton("btnMarkStart"); return markStart();
      case "F4": e.preventDefault(); tapButton("btnMarkEnd"); return markEndNext();
      case "F5": return replayCue();
      case "F1": e.preventDefault(); return openModal("modalKeys");
      case "F11": return undefined;
    }
    if (typing) return;

    // A focused control keeps its own keys.
    const t = e.target;
    const onControl = t.matches?.("select, input[type=range], [role=radio], .seg > button, .split");
    const step = e.shiftKey ? 100 : 1500;
    switch (e.key) {
      case " ":
        // Space always means play / pause; it never re-fires the last clicked button.
        if (t.matches?.("input[type=checkbox], select, [role=radio]")) return;
        e.preventDefault();
        return togglePlay();
      case "[": e.preventDefault(); tapButton("btnMarkStart"); return markStart();
      case "]": e.preventDefault(); tapButton("btnMarkEnd"); return markEndNext();
      case "ArrowLeft": if (onControl) return; e.preventDefault(); return nudge(-step);
      case "ArrowRight": if (onControl) return; e.preventDefault(); return nudge(step);
      case "ArrowUp": if (onControl) return; e.preventDefault(); return selectCue(stepCue(-1), { seek: true });
      case "ArrowDown": if (onControl) return; e.preventDefault(); return selectCue(stepCue(1), { seek: true });
      case "PageUp": if (onControl) return; e.preventDefault(); return jumpCue(-1);
      case "PageDown": if (onControl) return; e.preventDefault(); return jumpCue(1);
      case "Home": if (onControl) return; e.preventDefault(); return seekTo(0);
      case "End": if (onControl) return; e.preventDefault(); return seekTo(state.durationMs);
      case "Delete":
        if (onControl || t.closest?.(".pane-style, .bar, .find")) return;
        e.preventDefault();
        if (!cueVisible(state.selectedIdx) && state.subtitles.length) return toast("选中的这一句被筛选隐藏了，没有删除", { key: "hidden-del" });
        return deleteCue(state.selectedIdx);
      case "Insert": e.preventDefault(); return addCueAt(state.currentTimeMs);
      case "Enter":
        if (t === document.body || t === document.documentElement) {
          e.preventDefault();
          return selectCue(state.selectedIdx, { focus: "zh" });
        }
        return;
      case "t": case "T": return toggleTheatre();
      case "?": return openModal("modalKeys");
      case "Escape":
        if (inTheatre()) return toggleTheatre();
        return closeFind();
    }
  });
  // Ctrl + wheel zooms the timeline; it must never zoom the page.
  addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  // Buttons react on keyup for Space; we use Space for playback, so swallow it there too.
  addEventListener("keyup", (e) => {
    if (e.key === " " && !isTyping(e.target) && !modalOpen() && e.target.matches?.("button:not([role=radio])")) e.preventDefault();
  });
}

/* ---------- boot ---------- */
export function applyPrefs(prefs = {}) {
  // Choices made before the settings arrived win over what was stored.
  const early = state.prefs;
  state.prefs = { ...prefs, ...early };
  if (Object.keys(early).length) persist();
  prefs = state.prefs;
  if (THEMES.includes(prefs.theme)) themePref = prefs.theme;
  setTheme(resolveTheme());
  labelTheme();
  if (prefs.mood) setMood(prefs.mood);
  if (Number.isFinite(prefs.dockW)) dockW = prefs.dockW;
  if (Number.isFinite(prefs.reelH)) reelH = prefs.reelH;
  applySizes();
  if (Number.isFinite(prefs.volume)) setVolume(prefs.volume, prefs.volume === 0);
  if (typeof prefs.guides === "boolean") setGuides(prefs.guides);
  if (typeof prefs.follow === "boolean") setFollow(prefs.follow);
  if (typeof prefs.seekOnClick === "boolean") setSeekOnClick(prefs.seekOnClick);
  if (["mid", "light"].includes(prefs.scene)) {
    setScene(prefs.scene);
    for (const b of $$("#sceneSwitch button")) b.setAttribute("aria-checked", String(b.dataset.scene === prefs.scene));
  }
}

export function initShell() {
  tabSeg = bindSeg(byId("dockTabs"), showTab, "aria-selected");
  on("show-tab", showTab);
  bindSplitters();
  bindKeys();
  bindLook();
  labelTheme();
  byId("btnUndo").addEventListener("click", doUndo);
  byId("btnRedo").addEventListener("click", doRedo);
  byId("btnKeys").addEventListener("click", () => openModal("modalKeys"));
  on("history", paintHistory);
  on("do-undo", doUndo);
  on("status", showStatus);
  on("pref", savePref);
  on("palette", paintTitleBar);
  setVolume(1, false);
  paintHistory();
  applySizes();
}

