"""
EasySub Studio (傻瓜双语字幕工坊) - Native Windows Desktop Application
Powered by pywebview (Edge WebView2) + local Range-capable media server.
"""

from __future__ import annotations

import json
import mimetypes
import multiprocessing
import os
import re
import socket
import sys
import tempfile
import threading
import traceback
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# In PyInstaller --noconsole mode, sys.stdout and sys.stderr are None,
# which can break tqdm / faster-whisper / logging writes unless redirected.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

# Ensure local 127.0.0.1 media/UI server bypasses any Windows system proxy
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

import webview

# Only lightweight pure-Python subtitle parser is imported at startup for instant window launch!
from core.subtitles import (
    DEFAULT_PRESETS,
    _find_best_orphan_neighbor,
    clean_sdh_and_hearing_tags,
    diagnose_bilingual_issues,
    export_ass,
    export_srt,
    fix_overlapping_timestamps,
    fix_split_orphan_lines,
    format_us_drama_punctuation,
    load_subtitle_file,
    merge_internal_bilingual_lines,
    merge_two_subtitles,
    parse_plain_text,
    read_text_auto_encoding,
    split_subtitle_cue_in_two,
)

if getattr(sys, "frozen", False):
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    APP_DIR = Path(sys.executable).resolve().parent
    USER_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "EasySubStudio"
else:
    BUNDLE_DIR = Path(__file__).resolve().parent
    APP_DIR = BUNDLE_DIR
    USER_DATA_DIR = APP_DIR

USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
UI_DIR = BUNDLE_DIR / "ui"
VERSION_PATH = BUNDLE_DIR / "version.txt"  # only inside the exe, written by tools/build_exe.py
SETTINGS_PATH = USER_DATA_DIR / "settings.json"
CUSTOM_PRESETS_PATH = USER_DATA_DIR / "custom_presets.json"
AUTOSAVE_PATH = USER_DATA_DIR / "autosave.json"
AUTOSAVE_PREV_PATH = USER_DATA_DIR / "autosave.prev.json"
WEBVIEW_STORAGE_DIR = USER_DATA_DIR / "webview_cache"
WEBVIEW_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
TEMP_MEDIA_DIR = Path(tempfile.gettempdir()) / "easysub_studio_cache"
TEMP_MEDIA_DIR.mkdir(parents=True, exist_ok=True)

# pywebview 6 moved the dialog constants into an enum and deprecated the old names.
if hasattr(webview, "FileDialog"):
    DIALOG_OPEN, DIALOG_SAVE = webview.FileDialog.OPEN, webview.FileDialog.SAVE
else:
    DIALOG_OPEN, DIALOG_SAVE = webview.OPEN_DIALOG, webview.SAVE_DIALOG

SUBTITLE_EXTS = (".srt", ".ass", ".ssa", ".vtt", ".txt", ".json")


class AppState:
    def __init__(self) -> None:
        self.server_port: int = 0
        self.window: webview.Window | None = None
        self.video_path: Path | None = None
        self.playable_path: Path | None = None
        self.draft_rotated: bool = False
        self.load_seq: int = 0  # newest load request
        self.media: dict[str, Path] = {}  # id in the /media URL → file
        self.motion_cancel: threading.Event | None = None
        self.lock = threading.Lock()
        self.task_status: dict[str, Any] = {
            "running": False,
            "message": "",
            "percent": 0,
            "error": "",
            "result": None,
        }

    def set_task(
        self,
        running: bool,
        message: str = "",
        percent: int = 0,
        error: str = "",
        result: Any = None,
    ) -> None:
        with self.lock:
            self.task_status = {
                "running": running,
                "message": message,
                "percent": percent,
                "error": error,
                "result": result,
            }

    def get_task(self) -> dict[str, Any]:
        with self.lock:
            data = dict(self.task_status)
            # Clear consumed result once read after completion
            if not data["running"] and data["result"] is not None:
                self.task_status["result"] = None
            return data


STATE = AppState()


def load_settings() -> dict[str, Any]:
    defaults = {
        "asr_engine": "local",
        "asr_model_size": "base",
        "asr_source_lang": "en",
        "asr_api_base": "https://api.openai.com/v1",
        "asr_api_key": "",
        "asr_api_model": "whisper-1",
        "trans_provider": "free",
        "trans_preset": "us_drama",
        "trans_agent_mode": True,
        "trans_context": "",
        "trans_custom_prompt": "",
        "trans_glossary": "",
        "llm_base": "https://api.deepseek.com/v1",
        "llm_key": "",
        "llm_model": "deepseek-chat",
        "ui": {},
    }
    if SETTINGS_PATH.exists():
        try:
            saved = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                defaults.update(saved)
        except Exception:
            pass
    if not isinstance(defaults.get("ui"), dict):
        defaults["ui"] = {}
    return defaults


def _build_trans_cfg(settings: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": settings.get("trans_provider", "free"),
        "preset": settings.get("trans_preset", "us_drama"),
        "agent_mode": bool(settings.get("trans_agent_mode", True)),
        "story_context": settings.get("trans_context", ""),
        "custom_prompt": settings.get("trans_custom_prompt", ""),
        "glossary": settings.get("trans_glossary", ""),
        "llm_base": settings.get("llm_base", ""),
        "llm_key": settings.get("llm_key", ""),
        "llm_model": settings.get("llm_model", ""),
    }


def load_custom_presets() -> list[dict[str, Any]]:
    if not CUSTOM_PRESETS_PATH.exists():
        return []
    try:
        items = json.loads(CUSTOM_PRESETS_PATH.read_text(encoding="utf-8"))
        if isinstance(items, list):
            for it in items:
                it["is_custom"] = True
            return items
    except Exception:
        pass
    return []


def save_custom_presets_list(items: list[dict[str, Any]]) -> None:
    CUSTOM_PRESETS_PATH.write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
    )


_SETTINGS_LOCK = threading.Lock()


def save_settings(new_settings: dict[str, Any]) -> dict[str, Any]:
    # Each bridge call runs on its own thread; read-modify-write has to be one step.
    with _SETTINGS_LOCK:
        merged = load_settings()
        merged.update(new_settings)
        SETTINGS_PATH.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return merged


_MEDIA_MIME_MAP: dict[str, str] = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}


class LocalStudioHTTPHandler(SimpleHTTPRequestHandler):
    """Serves UI static files and streams local video files with HTTP/1.1 Range support."""

    protocol_version = "HTTP/1.1"

    # Windows resolves MIME types through the registry, where ".js" is sometimes
    # mapped to text/plain; browsers refuse to run ES modules served that way.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Silence noisy per-chunk console logs
        return

    def do_HEAD(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/media":
            self._serve_media_range(send_body=False)
            return
        super().do_HEAD()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/media":
            self._serve_media_range(send_body=True)
            return
        super().do_GET()

    def _serve_media_range(self, send_body: bool = True) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        media_file = STATE.media.get((query.get("id") or [""])[0]) or STATE.playable_path
        if not media_file or not media_file.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "No media loaded")
            return

        file_size = media_file.stat().st_size
        ext = media_file.suffix.lower()
        ctype = _MEDIA_MIME_MAP.get(ext) or mimetypes.guess_type(str(media_file))[0] or "video/mp4"

        range_header = self.headers.get("Range")
        start = 0
        end = max(0, file_size - 1)
        status = HTTPStatus.OK

        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                elif m.group(2):
                    # Suffix byte-range-spec: bytes=-500
                    suffix_len = int(m.group(2))
                    start = max(0, file_size - suffix_len)
                if m.group(1) and m.group(2):
                    end = min(file_size - 1, int(m.group(2)))
                if start >= file_size and file_size > 0:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = HTTPStatus.PARTIAL_CONTENT

        length = max(0, end - start + 1) if file_size > 0 else 0
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            if not send_body or length <= 0:
                return

            with media_file.open("rb") as f:
                f.seek(start)
                remaining = length
                chunk_size = 256 * 1024
                while remaining > 0:
                    data = f.read(min(chunk_size, remaining))
                    if not data:
                        break
                    self.wfile.write(data)
                    remaining -= len(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass


def system_prefers_dark() -> bool:
    """Windows 'app mode' setting; light when it cannot be read."""
    try:
        import winreg

        key = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            return winreg.QueryValueEx(handle, "AppsUseLightTheme")[0] == 0
    except Exception:
        return False


def resolve_theme(settings: dict[str, Any]) -> str:
    pref = (settings.get("ui") or {}).get("theme", "auto")
    if pref in ("light", "dark"):
        return pref
    return "dark" if system_prefers_dark() else "light"


def paint_title_bar(theme: str, caption: str = "") -> bool:
    """Tint the native title bar so it continues the app's backdrop (Windows 11)."""
    if os.name != "nt" or not STATE.window:
        return False
    try:
        import ctypes

        form = getattr(STATE.window, "native", None)
        if form is None:
            return False
        hwnd = ctypes.c_void_p(form.Handle.ToInt64())

        def set_attr(attr: int, value: int) -> None:
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, ctypes.c_uint(attr), ctypes.byref(ctypes.c_int(value)), ctypes.c_uint(4)
            )

        dark = theme == "dark"
        set_attr(20, 1 if dark else 0)  # DWMWA_USE_IMMERSIVE_DARK_MODE
        m = re.fullmatch(r"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})", caption or "")
        if m:
            r, g, b = (int(x, 16) for x in m.groups())
            set_attr(35, r | (g << 8) | (b << 16))  # DWMWA_CAPTION_COLOR
            set_attr(36, 0xF2EEEA if dark else 0x3A2620)  # DWMWA_TEXT_COLOR (BGR)
        return True
    except Exception:
        return False


def set_window_icon() -> None:
    """Running from source, Windows would show python.exe's icon."""
    icon_file = BUNDLE_DIR / "icon.ico"
    if os.name != "nt" or not STATE.window or not icon_file.exists():
        return
    try:
        from System import Action
        from System.Drawing import Icon

        form = STATE.window.native
        form.BeginInvoke(Action(lambda: setattr(form, "Icon", Icon(str(icon_file)))))
    except Exception:
        pass


def start_local_server() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    server = ThreadingHTTPServer(("127.0.0.1", port), LocalStudioHTTPHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return port


def read_project_style(path: Path) -> dict[str, Any] | None:
    """Style block saved inside an EasySub project file, if it has a usable one."""
    try:
        data = json.loads(read_text_auto_encoding(path))
        style = data.get("style") if isinstance(data, dict) else None
        if isinstance(style, dict) and isinstance(style.get("zh"), dict) and isinstance(style.get("en"), dict):
            return style
    except Exception:
        pass
    return None


class DesktopBridgeApi:
    """Exposed to JavaScript via window.pywebview.api.*"""

    def get_initial_bootstrap(self) -> dict[str, Any]:
        STATE.draft_rotated = False  # a fresh UI offers (and later rotates) the newest draft
        autosave_meta = None
        if AUTOSAVE_PATH.exists():
            try:
                draft = json.loads(AUTOSAVE_PATH.read_text(encoding="utf-8"))
                subs = draft.get("subtitles") or []
                if len(subs) > 0:
                    autosave_meta = {
                        "saved_at": draft.get("saved_at", ""),
                        "count": len(subs),
                        "video_name": draft.get("video_name", ""),
                    }
            except Exception:
                pass

        return {
            "presets": DEFAULT_PRESETS + load_custom_presets(),
            "settings": load_settings(),
            "app_dir": str(APP_DIR),
            "version": VERSION_PATH.read_text(encoding="utf-8").strip() if VERSION_PATH.exists() else "",
            "autosave_meta": autosave_meta,
        }

    def save_custom_preset(
        self, name: str, style: dict[str, Any]
    ) -> dict[str, Any]:
        import time

        clean_name = (name or "").strip() or "我的自定义样式"
        custom_list = load_custom_presets()
        new_preset = dict(style)
        new_preset["id"] = f"custom_{int(time.time() * 1000)}"
        new_preset["name"] = clean_name
        new_preset["desc"] = f"自定义收藏 · {style.get('zh', {}).get('font', '')} + {style.get('en', {}).get('font', '')}"
        new_preset["is_custom"] = True
        custom_list.append(new_preset)
        save_custom_presets_list(custom_list)
        return {
            "ok": True,
            "new_id": new_preset["id"],
            "presets": DEFAULT_PRESETS + custom_list,
        }

    def delete_custom_preset(self, preset_id: str) -> dict[str, Any]:
        custom_list = [p for p in load_custom_presets() if p.get("id") != preset_id]
        save_custom_presets_list(custom_list)
        return {"ok": True, "presets": DEFAULT_PRESETS + custom_list}

    def save_autosave_draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        from datetime import datetime

        try:
            data = {
                "saved_at": datetime.now().strftime("%m-%d %H:%M:%S"),
                "video_path": str(STATE.video_path) if STATE.video_path else "",
                "video_name": payload.get("video_name", ""),
                "style": payload.get("style"),
                "subtitles": payload.get("subtitles") or [],
            }
            # The first save of a session moves the previous session's draft aside,
            # so it can still be restored after new work has been saved.
            if not STATE.draft_rotated:
                STATE.draft_rotated = True
                if AUTOSAVE_PATH.exists():
                    os.replace(AUTOSAVE_PATH, AUTOSAVE_PREV_PATH)
            AUTOSAVE_PATH.write_text(
                json.dumps(data, ensure_ascii=False), encoding="utf-8"
            )
            return {"ok": True, "saved_at": data["saved_at"]}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def load_autosave_draft(self) -> dict[str, Any]:
        draft_file = AUTOSAVE_PREV_PATH if STATE.draft_rotated else AUTOSAVE_PATH
        if not draft_file.exists():
            return {"ok": False, "error": "未找到自动保存草稿"}
        try:
            data = json.loads(draft_file.read_text(encoding="utf-8"))
            return {"ok": True, "draft": data}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def clear_autosave_draft(self) -> dict[str, Any]:
        try:
            if AUTOSAVE_PATH.exists():
                AUTOSAVE_PATH.unlink()
        except Exception:
            pass
        return {"ok": True}

    def clean_us_drama_punctuation(
        self, subtitles: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return format_us_drama_punctuation(subtitles)

    def split_cue_item(self, cue: dict[str, Any]) -> dict[str, Any]:
        parts = split_subtitle_cue_in_two(cue)
        return {"ok": True, "parts": parts}

    def diagnose_subtitle_issues(
        self, subtitles: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return diagnose_bilingual_issues(subtitles)

    def smart_fix_single_orphan_or_translate(
        self, subtitles: list[dict[str, Any]], row_idx: int
    ) -> dict[str, Any]:
        """
        If row_idx is a 1-to-2 split-sentence orphan overlapping its neighbor (like row #19 + #20),
        semantically split the neighbor's long text into both rows and repair overlapping timestamps!
        Otherwise fall back to normal single-row AI translation.
        """
        from core.media_ai import translate_single_cue_with_context, translate_texts_list

        if row_idx < 0 or row_idx >= len(subtitles):
            return {"ok": False, "error": "行号超出范围"}

        settings = load_settings()
        trans_cfg = _build_trans_cfg(settings)

        nb, _ = _find_best_orphan_neighbor(subtitles, row_idx)
        if nb >= 0:
            fi, si = (row_idx, nb) if row_idx < nb else (nb, row_idx)
            pair_slice = [dict(subtitles[fi]), dict(subtitles[si])]
            try:
                fixed_pair, cnt = fix_split_orphan_lines(
                    pair_slice,
                    mode="ai_split",
                    translator_fn=lambda txts, d: translate_texts_list(txts, d, trans_cfg),
                )
                if cnt > 0 and len(fixed_pair) == 2:
                    updated = [dict(x) for x in subtitles]
                    fixed_pair[0]["id"] = fi + 1
                    fixed_pair[1]["id"] = si + 1
                    updated[fi] = fixed_pair[0]
                    updated[si] = fixed_pair[1]
                    return {
                        "ok": True,
                        "mode": "split_neighbor",
                        "subtitles": updated,
                        "message": f"已智能识别上下句断句关联，自动从第 #{nb + 1} 句切分对应译文并消除时间重叠！",
                    }
            except Exception:
                pass

        cue = subtitles[row_idx]
        has_en = bool((cue.get("en") or "").strip())
        has_zh = bool((cue.get("zh") or "").strip())
        if not has_en and not has_zh:
            return {"ok": False, "error": "请先输入中文或英文任意一栏"}
        direction = "en_to_zh" if (has_en and not has_zh) else ("zh_to_en" if (has_zh and not has_en) else "en_to_zh")
        try:
            out_txt = translate_single_cue_with_context(
                subtitles, row_idx, direction=direction, config=trans_cfg
            )
            updated = [dict(x) for x in subtitles]
            if direction == "en_to_zh":
                updated[row_idx]["zh"] = out_txt
            else:
                updated[row_idx]["en"] = out_txt
            engine_tag = "AI 翻译 Agent (结合上下文)" if trans_cfg["provider"] == "llm" and trans_cfg["llm_key"] else "神经网络翻译"
            return {"ok": True, "mode": "single_trans", "subtitles": updated, "message": f"{engine_tag} 单句补全完成！"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def start_smart_bilingual_autofix(
        self, subtitles: list[dict[str, Any]], options: dict[str, Any]
    ) -> dict[str, Any]:
        """
        One-click Foolproof Bilingual Subtitle Fixer Wizard:
          - clean_sdh: Strip English SDH tags '(grunts)', '[sighs]' and remove empty noise rows
          - orphan_mode: 'merge' (combine into 1 sentence) | 'ai_split' (split long sentence into 2 short cues) | 'none'
          - fix_overlaps: Clamp overlapping bottom timestamps
          - fill_missing_ai: AI-translate remaining untranslated single-language rows
          - skip_foreign_notes: Skip '(哈克南语)...' alien/foreign-annotated rows when AI-translating
        """
        if STATE.get_task()["running"]:
            return {"ok": False, "error": "已有后台任务正在运行中，请稍候…"}
        STATE.set_task(True, "正在扫描并精修双语字幕…", 3)

        def worker() -> None:
            try:
                from core.media_ai import translate_subtitles, translate_texts_list

                STATE.set_task(True, "正在扫描并精修双语字幕…", 10)
                work = [dict(x) for x in subtitles]
                summary_parts: list[str] = []

                settings = load_settings()
                trans_cfg = _build_trans_cfg(settings)

                # 1. Clean SDH sound-effect tags first so '(grunts)' rows don't interfere with orphan pairing!
                if options.get("clean_sdh", True):
                    STATE.set_task(True, "正在清理听障音效与括号噪音 (SDH)…", 25)
                    work, sdh_st = clean_sdh_and_hearing_tags(
                        work, remove_empty_rows=True, clean_inline=True
                    )
                    if sdh_st["removed_rows"] or sdh_st["cleaned_inline"]:
                        summary_parts.append(
                            f"清理音效空行 {sdh_st['removed_rows']} 条、行内括号 {sdh_st['cleaned_inline']} 处"
                        )

                # 2. Fix 1-to-2 split-sentence orphans (merge or AI semantic split)
                orphan_mode = options.get("orphan_mode", "merge")
                if orphan_mode in ("merge", "ai_split"):
                    STATE.set_task(
                        True,
                        "正在合并断句孤行…" if orphan_mode == "merge" else "正在通过 AI 语义切分补齐断句孤行…",
                        50,
                    )
                    work, fixed_orphans = fix_split_orphan_lines(
                        work,
                        mode=orphan_mode,
                        translator_fn=(
                            (lambda txts, d: translate_texts_list(txts, d, trans_cfg))
                            if orphan_mode == "ai_split"
                            else None
                        ),
                    )
                    if fixed_orphans > 0:
                        action_lbl = "吸附合并断句孤行" if orphan_mode == "merge" else "AI 切分对齐断句孤行"
                        summary_parts.append(f"{action_lbl} {fixed_orphans} 处")

                # 3. Repair remaining overlapping timestamps
                if options.get("fix_overlaps", True):
                    work, ov_cnt = fix_overlapping_timestamps(work)
                    if ov_cnt > 0:
                        summary_parts.append(f"消除时间轴重叠 {ov_cnt} 处")

                # 4. Optional AI batch fill for remaining missing translations
                if options.get("fill_missing_ai", False):
                    skip_foreign = bool(options.get("skip_foreign_notes", True))
                    before_missing = sum(
                        1 for r in work if bool((r.get("zh") or "").strip()) ^ bool((r.get("en") or "").strip())
                    )
                    STATE.set_task(True, "正在调用 AI 自动补全剩余缺失译文…", 72)
                    work = translate_subtitles(
                        work,
                        direction="en_to_zh",
                        overwrite_existing=False,
                        config=trans_cfg,
                        progress=lambda msg, pct: STATE.set_task(True, msg, min(88, pct)),
                        skip_foreign_notes=skip_foreign,
                    )
                    work = translate_subtitles(
                        work,
                        direction="zh_to_en",
                        overwrite_existing=False,
                        config=trans_cfg,
                        progress=lambda msg, pct: STATE.set_task(True, msg, min(97, pct)),
                        skip_foreign_notes=skip_foreign,
                    )
                    after_missing = sum(
                        1 for r in work if bool((r.get("zh") or "").strip()) ^ bool((r.get("en") or "").strip())
                    )
                    filled = max(0, before_missing - after_missing)
                    if filled > 0:
                        summary_parts.append(f"AI 补全漏译 {filled} 句")

                msg = (
                    "一键精修完成：" + "，".join(summary_parts) + "！（可按 Ctrl+Z 撤销）"
                    if summary_parts
                    else "检查完毕：当前双语字幕已非常整洁，无需额外修复！"
                )
                STATE.set_task(False, msg, 100, result={"subtitles": work})
            except Exception as exc:
                traceback.print_exc()
                STATE.set_task(False, "", 0, error=str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True}

    def update_user_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        merged = save_settings(settings or {})
        return {"ok": True, "settings": merged}

    def test_llm_connection(self, settings: dict[str, Any]) -> dict[str, Any]:
        from core.media_ai import test_llm_api_connection

        merged = save_settings(settings or {})
        return test_llm_api_connection(
            api_base=merged.get("llm_base", ""),
            api_key=merged.get("llm_key", ""),
            model=merged.get("llm_model", ""),
        )

    def get_agent_preset_prompts(self) -> dict[str, Any]:
        from core.media_ai import TRANSLATION_AGENT_PRESETS

        return {"ok": True, "presets": TRANSLATION_AGENT_PRESETS}

    def set_window_theme(self, theme: str, caption: str = "") -> dict[str, Any]:
        return {"ok": paint_title_bar(theme, caption)}

    def get_task_status(self) -> dict[str, Any]:
        return STATE.get_task()

    def track_visual_annotation(self, request: dict[str, Any]) -> dict[str, Any]:
        from core.motion import TrackingCancelled, track_motion

        with STATE.lock:
            path = STATE.media.get(str(request.get("media_id", "")))
            if path is None or path != STATE.playable_path:
                return {"ok": False, "error": "视频已经换了，请重新框选"}
            if STATE.motion_cancel is not None:
                return {"ok": False, "error": "正在追踪，请稍候"}
            cancel = STATE.motion_cancel = threading.Event()
        try:
            result = track_motion(
                path,
                int(request["start_ms"]),
                int(request["end_ms"]),
                [float(v) for v in request["box"]],
                [int(v) for v in request["video_size"]],
                cancelled=lambda: cancel.is_set() or STATE.playable_path != path,
            )
            if cancel.is_set() or STATE.playable_path != path:
                return {"ok": False, "cancelled": True}
            return {"ok": True, **result}
        except TrackingCancelled:
            return {"ok": False, "cancelled": True}
        except ImportError:
            return {"ok": False, "error": "无法加载 OpenCV 追踪组件，请检查程序依赖"}
        except Exception as exc:
            return {"ok": False, "error": f"追踪失败：{exc}"}
        finally:
            with STATE.lock:
                STATE.motion_cancel = None

    def cancel_visual_annotation(self) -> dict[str, Any]:
        with STATE.lock:
            if STATE.motion_cancel is not None:
                STATE.motion_cancel.set()
        return {"ok": True}

    def choose_video_file(self) -> dict[str, Any]:
        """Only show the dialog, so the UI can display progress while the file is prepared."""
        if not STATE.window:
            return {"ok": False}
        file_types = (
            "音视频文件 (*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.flv;*.mp3;*.wav;*.m4a)",
            "所有文件 (*.*)",
        )
        selected = STATE.window.create_file_dialog(
            DIALOG_OPEN, allow_multiple=False, file_types=file_types
        )
        if not selected:
            return {"ok": False, "cancelled": True}
        return {"ok": True, "path": str(selected[0])}

    def pick_video_file(self) -> dict[str, Any]:
        picked = self.choose_video_file()
        return self.load_video_by_path(picked["path"]) if picked.get("ok") else picked

    def load_video_by_path(self, raw_path: str) -> dict[str, Any]:
        from core.media_ai import ensure_playable_video, probe_media_duration

        path = Path(raw_path)
        if not path.is_file():
            return {"ok": False, "error": f"找不到文件: {raw_path}"}

        # Preparing a large file takes a while; a newer request makes this one obsolete.
        with STATE.lock:
            STATE.load_seq += 1
            seq = STATE.load_seq
        try:
            playable = ensure_playable_video(path, TEMP_MEDIA_DIR)
        except FileNotFoundError:
            # ffmpeg is not installed: the file itself may still play in the preview.
            playable = path
        except Exception as exc:
            return {"ok": False, "error": f"打开文件失败: {exc}"}
        with STATE.lock:
            if seq != STATE.load_seq:
                return {"ok": False, "superseded": True}
            STATE.video_path = path
            STATE.playable_path = playable
            STATE.media[str(seq)] = playable
            for old in [k for k in STATE.media if int(k) < seq - 2]:
                del STATE.media[old]
        duration_sec = probe_media_duration(playable)

        # Look for matching same-name subtitle file automatically if present!
        auto_sub_path = None
        for ext in (".ass", ".srt", ".vtt"):
            candidate = path.with_suffix(ext)
            if candidate.exists():
                auto_sub_path = str(candidate)
                break

        media_url = (
            f"http://127.0.0.1:{STATE.server_port}/media?id={seq}&v={playable.stat().st_mtime_ns}"
        )
        return {
            "ok": True,
            "video_name": path.name,
            "video_stem": path.stem,
            "video_path": str(path),
            "media_url": media_url,
            "duration_ms": int(round(duration_sec * 1000)),
            "matching_subtitle_path": auto_sub_path,
        }

    def get_video_waveform(self) -> dict[str, Any]:
        from core.media_ai import extract_waveform_peaks

        target = STATE.video_path or STATE.playable_path
        if not target or not target.exists():
            return {"ok": False, "peaks": []}
        wf = extract_waveform_peaks(target, peaks_per_sec=25)
        wf["ok"] = True
        return wf

    def pick_subtitle_file(
        self,
        action: str = "replace",
        lang_hint: str = "auto",
        align_mode: str = "time",
        current_subtitles: list[dict[str, Any]] | None = None,
        time_base: str = "union",
        tolerance_ms: int = 800,
    ) -> dict[str, Any]:
        """
        action: 'replace' | 'merge'
        """
        if not STATE.window:
            return {"ok": False}
        file_types = (
            "字幕与文本文件 (*.srt;*.ass;*.ssa;*.vtt;*.txt;*.json)",
            "所有文件 (*.*)",
        )
        selected = STATE.window.create_file_dialog(
            DIALOG_OPEN, allow_multiple=False, file_types=file_types
        )
        if not selected:
            return {"ok": False, "cancelled": True}
        return self.load_subtitle_by_path(
            selected[0],
            action=action,
            lang_hint=lang_hint,
            align_mode=align_mode,
            current_subtitles=current_subtitles,
            time_base=time_base,
            tolerance_ms=tolerance_ms,
        )

    def load_subtitle_by_path(
        self,
        raw_path: str,
        action: str = "replace",
        lang_hint: str = "auto",
        align_mode: str = "time",
        current_subtitles: list[dict[str, Any]] | None = None,
        time_base: str = "union",
        tolerance_ms: int = 800,
    ) -> dict[str, Any]:
        try:
            path = Path(raw_path)
            loaded = load_subtitle_file(path, lang_hint=lang_hint)
            if action == "merge" and current_subtitles:
                merged, stats = merge_two_subtitles(
                    current_subtitles,
                    loaded,
                    secondary_lang=lang_hint,
                    align_mode=align_mode,
                    time_base=time_base,
                    tolerance_ms=int(tolerance_ms),
                    return_stats=True,
                )
                return {
                    "ok": True,
                    "file_name": path.name,
                    "subtitles": merged,
                    "count": len(merged),
                    "matched_count": stats["matched_count"],
                    "unmatched_secondary": stats["unmatched_secondary"],
                }
            result = {
                "ok": True,
                "file_name": path.name,
                "subtitles": loaded,
                "count": len(loaded),
            }
            if path.suffix.lower() == ".json":
                style = read_project_style(path)
                if style:
                    result["style"] = style
            return result
        except Exception as exc:
            return {"ok": False, "error": f"解析字幕文件失败: {exc}"}

    def merge_table_bilingual_rows(
        self,
        subtitles: list[dict[str, Any]],
        tolerance_ms: int = 200,
        time_base: str = "union",
        match_mode: str = "tolerance",
        preview_only: bool = False,
    ) -> dict[str, Any]:
        """Smartly pair & merge separate CN and EN rows inside the current subtitle table."""
        try:
            return merge_internal_bilingual_lines(
                subtitles=subtitles,
                tolerance_ms=int(tolerance_ms),
                time_base=time_base,
                match_mode=match_mode,
                preview_only=bool(preview_only),
            )
        except Exception as exc:
            return {"ok": False, "error": f"合并失败: {exc}"}

    def import_pasted_script(
        self,
        raw_text: str,
        mode: str = "auto_pair",
        merge_into_current: bool = False,
        current_subtitles: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        try:
            parsed = parse_plain_text(raw_text, mode=mode)
            if merge_into_current and current_subtitles:
                sec_lang = "zh" if mode == "zh_only" else ("en" if mode == "en_only" else "auto")
                merged = merge_two_subtitles(
                    current_subtitles, parsed, secondary_lang=sec_lang, align_mode="index"
                )
                return {"ok": True, "subtitles": merged, "count": len(merged)}
            return {"ok": True, "subtitles": parsed, "count": len(parsed)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def start_ai_workflow(
        self,
        workflow_type: str,
        current_subtitles: list[dict[str, Any]],
        options: dict[str, Any],
    ) -> dict[str, Any]:
        """
        workflow_type:
          - 'asr_and_translate': Extract speech from loaded video + translate to bilingual
          - 'asr_only': Extract speech from loaded video only
          - 'translate_only': Translate existing subtitles (en->zh or zh->en)
        """
        # Always persist user settings FIRST so API Keys/Agent prompts are never lost even if video isn't loaded!
        settings = save_settings(options.get("settings") or {})

        if STATE.get_task()["running"]:
            return {"ok": False, "error": "已有 AI 任务正在运行中，请稍候…"}

        if workflow_type in ("asr_and_translate", "asr_only"):
            if not STATE.video_path or not STATE.video_path.exists():
                return {"ok": False, "error": "配置已自动保存！如需语音听写请先打开一个音视频文件，或切换上方为「只翻译」。"}
        STATE.set_task(True, "正在启动 AI 双语助手…", 3)

        def worker() -> None:
            try:
                from core.media_ai import transcribe_video, translate_subtitles

                STATE.set_task(True, "正在启动 AI 双语助手…", 5)
                subs = list(current_subtitles)

                if workflow_type in ("asr_and_translate", "asr_only"):
                    asr_cfg = {
                        "engine": settings.get("asr_engine", "local"),
                        "model_size": settings.get("asr_model_size", "base"),
                        "source_lang": settings.get("asr_source_lang", "en"),
                        "api_base": settings.get("asr_api_base", ""),
                        "api_key": settings.get("asr_api_key", ""),
                        "api_model": settings.get("asr_api_model", "whisper-1"),
                    }
                    subs = transcribe_video(
                        STATE.video_path,  # type: ignore[arg-type]
                        asr_cfg,
                        progress=lambda msg, pct: STATE.set_task(True, msg, pct),
                    )
                    motion_rows = [row for row in current_subtitles if row.get("motion")]
                    if motion_rows:
                        subs.extend(motion_rows)
                        subs.sort(key=lambda row: row["start_ms"])

                if workflow_type in ("asr_and_translate", "translate_only"):
                    direction = options.get("direction", "en_to_zh")
                    overwrite = bool(options.get("overwrite", False))
                    trans_cfg = _build_trans_cfg(settings)
                    subs = translate_subtitles(
                        subs,
                        direction=direction,
                        overwrite_existing=overwrite,
                        config=trans_cfg,
                        progress=lambda msg, pct: STATE.set_task(True, msg, pct),
                    )

                STATE.set_task(
                    False,
                    f"AI 处理完成！共生成 {len(subs)} 句字幕",
                    100,
                    result={"subtitles": subs},
                )
            except Exception as exc:
                traceback.print_exc()
                STATE.set_task(False, "", 0, error=str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True}

    def translate_single_row(
        self, text: str, direction: str = "en_to_zh"
    ) -> dict[str, Any]:
        from core.media_ai import translate_subtitles

        settings = load_settings()
        dummy = [
            {
                "id": 1,
                "start_ms": 0,
                "end_ms": 2000,
                "en": text if direction == "en_to_zh" else "",
                "zh": text if direction == "zh_to_en" else "",
            }
        ]
        try:
            res = translate_subtitles(
                dummy,
                direction=direction,
                overwrite_existing=True,
                config=_build_trans_cfg(settings),
            )
            target_field = "zh" if direction == "en_to_zh" else "en"
            return {"ok": True, "translated": res[0].get(target_field, "")}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def export_subtitle_dialog(
        self,
        fmt: str,
        lang_mode: str,
        subtitles: list[dict[str, Any]],
        style: dict[str, Any],
        default_stem: str = "双语字幕",
    ) -> dict[str, Any]:
        """
        fmt: 'ass' | 'srt' | 'project'
        lang_mode: 'bilingual' | 'zh_only' | 'en_only'
        """
        if not STATE.window:
            return {"ok": False}

        suffix_label = {
            "bilingual": "中英双语",
            "zh_only": "中文字幕",
            "en_only": "英文字幕",
        }.get(lang_mode, "双语")

        stem = STATE.video_path.stem if STATE.video_path else default_stem
        default_dir = str(STATE.video_path.parent) if STATE.video_path else os.path.expanduser("~")

        if fmt == "ass":
            ext = ".ass"
            ftypes = ("ASS 特效双语字幕 (*.ass)", "所有文件 (*.*)")
            suggested = f"{stem}.{suffix_label}.ass"
        elif fmt == "srt":
            ext = ".srt"
            ftypes = ("SRT 通用字幕 (*.srt)", "所有文件 (*.*)")
            suggested = f"{stem}.{suffix_label}.srt"
        else:
            ext = ".ebsub.json"
            ftypes = ("EasySub 项目工程 (*.json)", "所有文件 (*.*)")
            suggested = f"{stem}.ebsub.json"

        save_target = STATE.window.create_file_dialog(
            DIALOG_SAVE,
            directory=default_dir,
            save_filename=suggested,
            file_types=ftypes,
        )
        if not save_target:
            return {"ok": False, "cancelled": True}

        out_path = Path(save_target if isinstance(save_target, str) else save_target[0])
        if out_path.suffix.lower() not in (".ass", ".srt", ".json"):
            out_path = Path(str(out_path) + ext)

        try:
            if fmt == "ass":
                content = export_ass(subtitles, style=style, lang_mode=lang_mode, title=stem)
                # UTF-8 with BOM ensures 100% Chinese compatibility in PotPlayer, MPC-HC, Aegisub & Windows
                out_path.write_text(content, encoding="utf-8-sig")
            elif fmt == "srt":
                content = export_srt(
                    subtitles, order=style.get("order", "zh_top"), lang_mode=lang_mode
                )
                out_path.write_text(content, encoding="utf-8-sig")
            else:
                payload = {"style": style, "subtitles": subtitles}
                out_path.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            return {"ok": True, "saved_path": str(out_path)}
        except Exception as exc:
            return {"ok": False, "error": f"导出保存失败: {exc}"}

    def export_current_to_sup_dialog(
        self,
        lang_mode: str,
        subtitles: list[dict[str, Any]],
        style: dict[str, Any],
        resolution: str = "1080p",
        fps: str = "23.976",
        default_stem: str = "双语字幕",
    ) -> dict[str, Any]:
        """Export current editor subtitles + style directly into a Blu-ray PGS .sup file."""
        if not STATE.window:
            return {"ok": False}
        if STATE.get_task()["running"]:
            return {"ok": False, "error": "后台已有任务正在运行中，请稍候…"}
        if not subtitles:
            return {"ok": False, "error": "当前字幕列表为空，请先输入或导入字幕！"}
        if lang_mode != "en_only" and any(row.get("motion") for row in subtitles):
            return {"ok": False, "error": "跟随标注的动态位置请使用 ASS 导出"}

        suffix_label = {
            "bilingual": "中英双语",
            "zh_only": "中文字幕",
            "en_only": "英文字幕",
        }.get(lang_mode, "双语")
        stem = STATE.video_path.stem if STATE.video_path else default_stem
        default_dir = str(STATE.video_path.parent) if STATE.video_path else os.path.expanduser("~")
        suggested = f"{stem}.{suffix_label}.{resolution}.sup"

        save_target = STATE.window.create_file_dialog(
            DIALOG_SAVE,
            directory=default_dir,
            save_filename=suggested,
            file_types=("蓝光原盘图形字幕 (*.sup)", "所有文件 (*.*)"),
        )
        if not save_target:
            return {"ok": False, "cancelled": True}

        out_path = Path(save_target if isinstance(save_target, str) else save_target[0])
        if out_path.suffix.lower() != ".sup":
            out_path = Path(str(out_path) + ".sup")
        STATE.set_task(True, "正在启动蓝光 PGS (.sup) 图形字幕压制引擎…", 2)

        def worker() -> None:
            try:
                from core.sup_export import export_editor_subtitles_to_sup

                STATE.set_task(True, "正在启动蓝光 PGS (.sup) 图形字幕压制引擎…", 4)
                res = export_editor_subtitles_to_sup(
                    subtitles=subtitles,
                    style=style,
                    lang_mode=lang_mode,
                    out_sup_path=out_path,
                    resolution=resolution,
                    fps=fps,
                    title=stem,
                    progress=lambda msg, pct: STATE.set_task(True, msg, pct),
                )
                STATE.set_task(
                    False,
                    f"SUP 导出完成！({res['events_written']} 幕, {res['file_size_mb']} MB) ➔ {out_path.name}",
                    100,
                    result={"sup_done": True, "saved_path": str(out_path), "details": res},
                )
            except Exception as exc:
                traceback.print_exc()
                STATE.set_task(False, "", 0, error=f"SUP 压制失败: {exc}")

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "started": True}

    def pick_and_convert_ass_to_sup(
        self,
        resolution: str = "1080p",
        fps: str = "23.976",
    ) -> dict[str, Any]:
        """Pick 1 or multiple local .ass/.ssa files and convert them directly into .sup files!"""
        if not STATE.window:
            return {"ok": False}
        if STATE.get_task()["running"]:
            return {"ok": False, "error": "后台已有任务正在运行中，请稍候…"}

        selected = STATE.window.create_file_dialog(
            DIALOG_OPEN,
            allow_multiple=True,
            file_types=("ASS 特效字幕 (*.ass;*.ssa)", "所有文件 (*.*)"),
        )
        if not selected:
            return {"ok": False, "cancelled": True}

        ass_files = [Path(p) for p in selected]

        # If single file picked, let user confirm/choose output .sup path; if batch, save alongside each .ass!
        single_out_path: Path | None = None
        if len(ass_files) == 1:
            src = ass_files[0]
            save_target = STATE.window.create_file_dialog(
                DIALOG_SAVE,
                directory=str(src.parent),
                save_filename=f"{src.stem}.sup",
                file_types=("蓝光原盘图形字幕 (*.sup)", "所有文件 (*.*)"),
            )
            if not save_target:
                return {"ok": False, "cancelled": True}
            single_out_path = Path(
                save_target if isinstance(save_target, str) else save_target[0]
            )
            if single_out_path.suffix.lower() != ".sup":
                single_out_path = Path(str(single_out_path) + ".sup")
        STATE.set_task(True, "正在读取 ASS 文件…", 2)

        def worker() -> None:
            try:
                from core.sup_export import convert_ass_file_to_sup

                total_files = len(ass_files)
                converted_paths: list[str] = []
                for idx, src_ass in enumerate(ass_files):
                    target_sup = (
                        single_out_path
                        if (total_files == 1 and single_out_path is not None)
                        else src_ass.with_suffix(".sup")
                    )

                    def sub_prog(msg: str, pct: int, i: int = idx, name: str = src_ass.name) -> None:
                        overall = int(((i * 100) + pct) / total_files)
                        prefix = f"[{i + 1}/{total_files}] {name} · " if total_files > 1 else ""
                        STATE.set_task(True, prefix + msg, max(3, min(99, overall)))

                    res = convert_ass_file_to_sup(
                        ass_path=src_ass,
                        out_sup_path=target_sup,
                        resolution=resolution,
                        fps=fps,
                        progress=sub_prog,
                    )
                    converted_paths.append(res["saved_path"])

                summary = (
                    f"已成功转换生成：{Path(converted_paths[0]).name}"
                    if total_files == 1
                    else f"批量转换完成！共成功生成 {total_files} 个蓝光 .SUP 文件"
                )
                STATE.set_task(
                    False,
                    summary,
                    100,
                    result={"sup_done": True, "converted_paths": converted_paths},
                )
            except Exception as exc:
                traceback.print_exc()
                STATE.set_task(False, "", 0, error=f"ASS 转 SUP 失败: {exc}")

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "started": True, "file_count": len(ass_files)}


def bind_drag_and_drop(window: webview.Window, api: DesktopBridgeApi) -> None:
    """Bind native file drag-and-drop onto WebView2 window so users can drag MP4/SRT straight in!"""
    try:
        from webview.dom import DOMEventHandler

        def on_drop(e: dict[str, Any]) -> None:
            files = e.get("dataTransfer", {}).get("files", [])
            paths = [f.get("pywebviewFullPath") or f.get("path") for f in files]
            paths = [p for p in paths if p]
            # First media file, then first subtitle: the UI queues them in that order.
            media = next((p for p in paths if Path(p).suffix.lower() not in SUBTITLE_EXTS), None)
            subtitle = next((p for p in paths if Path(p).suffix.lower() in SUBTITLE_EXTS), None)
            for kind, full_path in (("video", media), ("subtitle", subtitle)):
                if full_path:
                    window.evaluate_js(f"window.onNativeFileDropped('{kind}', {json.dumps(full_path)})")

        window.dom.document.events.dragover += DOMEventHandler(
            lambda e: None, prevent_default=True
        )
        window.dom.document.events.drop += DOMEventHandler(
            on_drop, prevent_default=True, stop_propagation=True
        )
    except Exception:
        pass

    # Warm up numpy / httpx / PIL in background AFTER window is visible so first click is instant
    def _warm_heavy_modules() -> None:
        import time

        time.sleep(1.2)
        try:
            import core.media_ai  # noqa: F401
            import core.sup_export  # noqa: F401
        except Exception:
            pass

    threading.Thread(target=_warm_heavy_modules, daemon=True).start()


def main() -> None:
    port = start_local_server()
    STATE.server_port = port
    api = DesktopBridgeApi()
    theme = resolve_theme(load_settings())

    window = webview.create_window(
        title="EasySub Studio · 傻瓜双语字幕工坊",
        url=f"http://127.0.0.1:{port}/index.html?theme={theme}",
        js_api=api,
        width=1440,
        height=900,
        min_size=(1120, 720),
        background_color="#131A2B" if theme == "dark" else "#E8EEFB",
        text_select=True,
    )
    STATE.window = window

    def on_shown(*_: Any) -> None:
        set_window_icon()
        paint_title_bar(theme, "#131A2B" if theme == "dark" else "#DFE6F8")

    window.events.shown += on_shown
    webview.start(
        func=lambda: bind_drag_and_drop(window, api),
        debug=False,
        storage_path=str(WEBVIEW_STORAGE_DIR),
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if os.name == "nt":
        try:
            import ctypes

            # Own taskbar identity instead of being grouped under python.exe
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("EasySub.Studio")
        except Exception:
            pass
    main()
