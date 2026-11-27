/* TMDB lookup for the active video or a subtitle-only project. */
import { byId, h } from "./util.js";
import { callQuiet } from "./bridge.js";
import { on, state } from "./store.js";

let source = "";
let sourceRevision = 0;
let request = 0;
let pending = null;
let metadata = null;
let candidates = [];

function status(text) {
  byId("tmdbStatus").textContent = text;
}

function label(item) {
  const episode = Number.isInteger(item.episode) ? `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}` : "";
  const original = item.original_title && item.original_title !== item.title ? item.original_title : "";
  return [item.title, original, item.year, episode, item.episode_title].filter(Boolean).join(" · ");
}

function paintCandidates(items) {
  candidates = items;
  const list = byId("tmdbCandidates");
  list.replaceChildren(h("option", { value: "" }, "选择影视条目"));
  items.forEach((item, i) => {
    list.append(h("option", { value: String(i) }, `${label(item)} · ${item.kind === "tv" ? "剧集" : "电影"}`));
  });
  byId("tmdbCandidateRow").hidden = items.length === 0;
  byId("btnTmdbAttach").disabled = true;
}

function paintMetadata(item) {
  metadata = item;
  byId("tmdbMatch").hidden = !item;
  if (!item) return;
  byId("tmdbTitle").textContent = label(item);
  byId("tmdbOverview").textContent = item.episode_overview || item.overview || "暂无梗概";
  byId("tmdbRoles").textContent = (item.roles || []).map((role) => role.character).join("、");
  byId("tmdbRoles").hidden = !byId("tmdbRoles").textContent;
  const sources = byId("tmdbSources");
  sources.replaceChildren();
  const link = (name, href) => sources.append(h("a", { href, target: "_blank", rel: "noopener noreferrer" }, name));
  if (/^https:\/\/www\.themoviedb\.org\/(?:movie|tv)\/\d+(?:\/season\/\d+\/episode\/\d+)?$/.test(item.tmdb_url)) {
    link("TMDB", item.tmdb_url);
  }
  const ids = item.external_ids || {};
  const imdb = ids.episode?.imdb_id || ids.work?.imdb_id;
  const wiki = ids.work?.wikidata_id;
  if (/^tt\d+$/.test(imdb || "")) link("IMDb", `https://www.imdb.com/title/${imdb}/`);
  if (/^Q\d+$/.test(wiki || "")) link("Wikidata", `https://www.wikidata.org/wiki/${wiki}`);
  const tvdb = ids.episode?.tvdb_id || ids.work?.tvdb_id;
  if (Number.isInteger(tvdb)) sources.append(h("span", {}, `TVDB ${tvdb}`));
}

const credential = () => byId("aiTmdbCredential").value.trim();

async function attach(candidate, id, token) {
  status("正在读取影视背景…");
  const result = await callQuiet("load_tmdb_metadata", candidate, token);
  if (id !== request) return;
  if (!result.ok) {
    status(result.error || "无法读取影视资料");
    return;
  }
  paintMetadata(result.metadata);
  status("已关联 · AI 影视精翻会使用此资料");
}

function track(job) {
  const task = job(++request);
  pending = task;
  task.finally(() => {
    if (pending === task) pending = null;
  });
  return task;
}

function lookup(query, fromFile) {
  paintMetadata(null);
  paintCandidates([]);
  status("正在从 TMDB 查找片名…");
  return track(async (id) => {
    const token = credential();
    const result = await callQuiet("lookup_tmdb_media", query, fromFile, token);
    if (id !== request) return;
    if (!result.ok) {
      status(result.needs_credential ? "填入 TMDB 读取令牌或 API Key 后可匹配" : result.error || "无法连接 TMDB");
      return;
    }
    paintCandidates(result.candidates || []);
    if (result.match) {
      const index = candidates.findIndex((item) => item.kind === result.match.kind && item.id === result.match.id);
      byId("tmdbCandidates").value = String(index);
      await attach(result.match, id, token);
    } else if (result.query?.multiple) {
      paintCandidates([]);
      status("文件名包含多集，请手动搜索要翻译的季集");
    } else {
      status(candidates.length ? "有多个可能结果或片名不完全一致，请选择" : "没有匹配结果，可搜索原名或加上年份");
    }
  });
}

function clearMatch(message) {
  request++;
  pending = null;
  paintCandidates([]);
  paintMetadata(null);
  status(message);
}

function setSource(name) {
  source = name || "";
  sourceRevision++;
  byId("tmdbQuery").value = "";
  clearMatch("输入片名即可手动搜索");
  if (source && byId("aiTmdbAutoMatch").checked) lookup(source, true);
}

export async function filmMetadataForTranslation() {
  const revision = sourceRevision;
  while (pending && revision === sourceRevision) await pending;
  return revision === sourceRevision ? metadata : null;
}

export function initTmdb() {
  on("media-changed", () => setSource(state.videoName));
  on("subtitle-source", (name) => {
    if (!state.mediaLoaded) setSource(name);
  });
  const search = () => {
    const query = byId("tmdbQuery").value.trim();
    if (query) lookup(query, false);
    else if (source) lookup(source, true);
    else status("请输入片名，可加年份或季集号");
  };
  byId("btnTmdbSearch").addEventListener("click", search);
  byId("tmdbQuery").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    search();
  });
  byId("tmdbCandidates").addEventListener("change", () => {
    byId("btnTmdbAttach").disabled = !byId("tmdbCandidates").value;
  });
  byId("btnTmdbAttach").addEventListener("click", () => {
    const value = byId("tmdbCandidates").value;
    if (!value || !candidates[Number(value)]) return;
    paintMetadata(null);
    track((id) => attach(candidates[Number(value)], id, credential()));
  });
  byId("btnTmdbClear").addEventListener("click", () => clearMatch("已取消关联，可手动搜索"));
  byId("aiTmdbAutoMatch").addEventListener("change", (event) => {
    if (event.currentTarget.checked && source) lookup(source, true);
    else if (pending && !metadata) clearMatch("自动匹配已关闭，可手动搜索");
  });
  byId("aiTmdbCredential").addEventListener("change", () => {
    if (source && byId("aiTmdbAutoMatch").checked) lookup(source, true);
  });
}
