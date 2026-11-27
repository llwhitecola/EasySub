/* AI dialog: Whisper dictation, free translation, and the film-translation agent. */

import { $, $$, byId, debounce } from "./util.js";
import { state } from "./store.js";
import { closeModal, onModalClose, openModal, toast, withBusy } from "./feedback.js";
import { call, callQuiet } from "./bridge.js";
import { bindSeg } from "./controls.js";
import { applyTaskResult, followTask, jobMark, taskRunning } from "./tasks.js";
import { filmMetadataForTranslation, initTmdb } from "./tmdb.js";

let workflow = "asr_and_translate";
let presetPrompts = null;

/* settings key → [control id, default] */
const FIELDS = {
  asr_engine: ["aiAsrEngine", "local"],
  asr_model_size: ["aiAsrModelSize", "base"],
  asr_source_lang: ["aiAsrLang", "en"],
  asr_api_base: ["aiAsrApiBase", "https://api.openai.com/v1"],
  asr_api_key: ["aiAsrApiKey", ""],
  asr_api_model: ["aiAsrApiModel", "whisper-1"],
  trans_provider: ["aiTransProvider", "free"],
  trans_preset: ["aiTransPreset", "us_drama"],
  trans_agent_mode: ["aiAgentMode", true],
  trans_custom_prompt: ["aiCustomPrompt", ""],
  trans_context: ["aiContext", ""],
  trans_glossary: ["aiGlossary", ""],
  tmdb_auto_match: ["aiTmdbAutoMatch", true],
  tmdb_credential: ["aiTmdbCredential", ""],
  llm_base: ["aiLlmBase", "https://api.deepseek.com/v1"],
  llm_key: ["aiLlmKey", ""],
  llm_model: ["aiLlmModel", "deepseek-chat"],
};

/* ---------- settings ---------- */
export function populateSettings(s) {
  state.settings = s || {};
  state.settingsLoaded = true;
  for (const [key, [id, dflt]] of Object.entries(FIELDS)) {
    const node = byId(id);
    const v = s?.[key];
    if (node.type === "checkbox") node.checked = v === undefined || v === null ? dflt : v !== false;
    else if (node.tagName === "SELECT") node.value = Array.from(node.options).some((o) => o.value === v) ? v : dflt;
    else node.value = typeof v === "string" && v ? v : dflt;
  }
  byId("wrapPrompt").hidden = byId("aiTransPreset").value !== "custom" && !byId("aiCustomPrompt").value.trim();
  syncPromptLink();
  syncVisibility();
  if (byId("aiLlmKey").value) saved("已载入本机保存的 API Key 与配置");
}

function collectSettings() {
  const out = {};
  for (const [key, [id]] of Object.entries(FIELDS)) {
    const node = byId(id);
    out[key] = node.type === "checkbox" ? node.checked : node.value.trim();
  }
  return out;
}

function saved(text, ok = true) {
  const n = byId("aiSaved");
  n.textContent = text;
  n.classList.toggle("ok", ok);
}

/** Keys and personas are kept on this computer (settings.json), never lost on close. */
async function persistNow({ tell = false } = {}) {
  persistSoon.cancel();
  if (!state.settingsLoaded) return; // never write blanks over settings that were not read yet
  const res = await callQuiet("update_user_settings", collectSettings());
  if (res.offline) return;
  if (res.ok === false) return saved("保存失败，请检查磁盘权限", false);
  saved(byId("aiLlmKey").value.trim() ? "API Key 与配置已保存在本机" : "配置已保存在本机");
  if (tell) toast("AI 配置已保存，单句互译、智能精修和批量翻译都会用它", { type: "success" });
}
const persistSoon = debounce(() => persistNow(), 450);

/* ---------- what is visible ---------- */
function syncVisibility() {
  const asr = workflow !== "translate_only";
  const trans = workflow !== "asr_only";
  byId("secAsr").hidden = !asr;
  byId("secTrans").hidden = !trans;
  byId("wrapLocalModel").hidden = byId("aiAsrEngine").value !== "local";
  byId("wrapAsrApi").hidden = byId("aiAsrEngine").value !== "api";
  const llm = byId("aiTransProvider").value === "llm";
  byId("wrapLlm").hidden = !llm;
  const base = byId("aiLlmBase").value.trim();
  for (const b of $$("#provChips [data-base]")) b.setAttribute("aria-pressed", String(llm && b.dataset.base === base));

  const hint = byId("aiHint");
  if (asr && !state.mediaLoaded) hint.textContent = "需要先打开一个视频或音频文件。";
  else if (!asr && !state.subtitles.length) hint.textContent = "需要先有一份中文或英文字幕。";
  else if (asr && state.subtitles.length && !state.isDemo) hint.textContent = `会替换当前的 ${state.subtitles.length} 句字幕，完成后可以撤销。`;
  else hint.textContent = "";
}

function setWorkflow(value) {
  workflow = value;
  for (const c of $$("#aiWorkflows .wf")) c.setAttribute("aria-checked", String(c.dataset.value === value));
  syncVisibility();
}

export function openAi(wf) {
  if (wf) setWorkflow(wf);
  syncVisibility();
  openModal("modalAi");
}

/* ---------- agent prompt ---------- */
function syncPromptLink() {
  byId("btnPrompt").textContent = byId("wrapPrompt").hidden ? "查看和微调提示词" : "收起提示词";
}
async function showBasePrompt() {
  const note = byId("promptBase");
  const id = byId("aiTransPreset").value;
  if (id === "custom") {
    note.textContent = "自定义会完全替换内置提示词。";
    return;
  }
  if (!presetPrompts) {
    const res = await callQuiet("get_agent_preset_prompts");
    presetPrompts = res.ok ? res.presets : null;
  }
  const text = presetPrompts?.[id]?.prompt;
  note.textContent = text ? `${text}` : "";
}
async function togglePrompt() {
  const wrap = byId("wrapPrompt");
  wrap.hidden = !wrap.hidden;
  syncPromptLink();
  if (!wrap.hidden) {
    await showBasePrompt();
    byId("aiCustomPrompt").focus();
  }
}

/* ---------- provider shortcuts + connection test ---------- */
function fillProvider(chip) {
  byId("aiTransProvider").value = "llm";
  byId("aiLlmBase").value = chip.dataset.base;
  byId("aiLlmModel").value = chip.dataset.model;
  syncVisibility();
  persistSoon();
  const local = chip.dataset.base.includes("127.0.0.1");
  toast(local ? `已填入 ${chip.textContent}，确认模型名后测试连接` : `已填入 ${chip.textContent} 的接口和推荐模型，请粘贴 API Key`);
  (local ? byId("aiLlmModel") : byId("aiLlmKey")).focus();
}

async function testConnection(btn) {
  return withBusy(btn, async () => {
    const label = $("span", btn);
    const name = label.textContent;
    label.textContent = "测试中…";
    persistSoon.cancel(); // the test itself saves, and its result should stay readable
    const res = await call("test_llm_connection", collectSettings());
    label.textContent = name;
    if (res.ok) {
      saved(`连接成功（${res.latency_ms} ms），配置已保存`);
      toast(`连接成功：${res.model}，用时 ${res.latency_ms} ms`, { type: "success" });
    } else if (res.error) toast(res.error, { type: "error" });
  });
}

/* ---------- run ---------- */
async function run(btn) {
  if (taskRunning()) return toast("已有任务在运行，请等它完成");
  return withBusy(btn, async () => {
    const mark = jobMark();
    const settings = collectSettings();
    const activeWorkflow = workflow;
    const filmMetadata = activeWorkflow !== "asr_only" && settings.trans_provider === "llm"
      ? await filmMetadataForTranslation() : null;
    if (state.mediaId !== mark.media || state.subtitles !== mark.cues) {
      return toast("当前影片或字幕已切换，请重新开始翻译");
    }
    const res = await call("start_ai_workflow", activeWorkflow, mark.cues, {
      settings,
      direction: byId("aiTransDir").dataset.value || "en_to_zh",
      overwrite: byId("aiOverwrite").checked,
      film_metadata: filmMetadata,
    });
    if (!res.ok) return toast(res.error || "没能启动 AI 任务", { type: "error" });
    const translateOnly = activeWorkflow === "translate_only";
    followTask({
      label: "AI",
      modal: "modalAi",
      box: byId("aiProgress"),
      onStart: () => setRunning(true),
      onEnd: () => setRunning(false),
      onDone: async (st) => {
        const subs = st.result?.subtitles;
        if (!subs) return;
        if (!subs.length) {
          toast("没有识别到语音内容，字幕没有改动");
          return;
        }
        const applied = applyTaskResult({
          subs,
          label: "AI 生成",
          mark,
          message: st.message || `AI 处理完成，共 ${subs.length} 句`,
          select: translateOnly ? state.selectedIdx : 0,
        });
        setTimeout(() => {
          byId("aiProgress").hidden = true;
          if (applied) closeModal("modalAi");
        }, 900);
      },
    });
  });
}

function setRunning(on) {
  byId("aiForm").inert = on;
  const btn = byId("btnAiRun");
  btn.disabled = on;
  $("span", btn).textContent = on ? "正在处理…" : "开始生成";
}

export function initAi() {
  initTmdb();
  byId("btnOpenAi").addEventListener("click", () => openAi());
  byId("aiWorkflows").addEventListener("click", (e) => {
    const c = e.target.closest(".wf");
    if (c) setWorkflow(c.dataset.value);
  });
  byId("aiWorkflows").addEventListener("keydown", (e) => {
    const c = e.target.closest(".wf");
    if (c && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setWorkflow(c.dataset.value);
    }
  });
  const dir = byId("aiTransDir");
  const dirSeg = bindSeg(dir, (v) => {
    dir.dataset.value = v;
  });
  dir.dataset.value = "en_to_zh";
  dirSeg.set("en_to_zh", { animate: false });

  for (const [, [id]] of Object.entries(FIELDS)) {
    const node = byId(id);
    node.addEventListener("input", () => {
      // Pasting a key means the person wants the model, not the free engine.
      if (id === "aiLlmKey" && node.value.trim().length > 5) byId("aiTransProvider").value = "llm";
      if (id === "aiLlmBase" || id === "aiLlmKey") syncVisibility();
      persistSoon();
    });
    node.addEventListener("change", () => {
      syncVisibility();
      persistSoon();
    });
  }
  byId("aiTransPreset").addEventListener("change", () => {
    if (byId("aiTransPreset").value === "custom") byId("wrapPrompt").hidden = false;
    syncPromptLink();
    if (!byId("wrapPrompt").hidden) showBasePrompt();
  });
  byId("btnPrompt").addEventListener("click", togglePrompt);
  for (const b of $$("#provChips [data-base]")) b.addEventListener("click", () => fillProvider(b));
  byId("btnTestLlm").addEventListener("click", (e) => testConnection(e.currentTarget));
  byId("btnSaveAi").addEventListener("click", () => persistNow({ tell: true }));
  byId("btnAiRun").addEventListener("click", (e) => run(e.currentTarget));
  // Closing the dialog right after typing must not lose the last keystrokes.
  onModalClose("modalAi", () => persistNow());
  for (const b of $$("[data-reveal]")) {
    b.addEventListener("click", () => {
      const inp = byId(b.dataset.reveal);
      inp.type = inp.type === "password" ? "text" : "password";
      b.setAttribute("aria-pressed", String(inp.type === "text"));
    });
  }
  setWorkflow(workflow);
}
