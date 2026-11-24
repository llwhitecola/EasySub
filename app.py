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

import webview

from core.media_ai import (
    ensure_playable_video,
    extract_waveform_peaks,
    probe_media_duration,
    transcribe_video,
    translate_subtitles,
)
from core.subtitles import (
    DEFAULT_PRESETS,
    export_ass,
    export_srt,
    load_subtitle_file,
    merge_two_subtitles,
    parse_plain_text,
)
from core.sup_export import (
    convert_ass_file_to_sup,
    export_editor_subtitles_to_sup,
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
SETTINGS_PATH = USER_DATA_DIR / "settings.json"
WEBVIEW_STORAGE_DIR = USER_DATA_DIR / "webview_cache"
WEBVIEW_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
TEMP_MEDIA_DIR = Path(tempfile.gettempdir()) / "easysub_studio_cache"
TEMP_MEDIA_DIR.mkdir(parents=True, exist_ok=True)


class AppState:
    def __init__(self) -> None:
        self.server_port: int = 0
        self.window: webview.Window | None = None
        self.video_path: Path | None = None
        self.playable_path: Path | None = None
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
        "llm_base": "https://api.deepseek.com/v1",
        "llm_key": "",
        "llm_model": "deepseek-chat",
    }
    if SETTINGS_PATH.exists():
        try:
            saved = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                defaults.update(saved)
        except Exception:
            pass
    return defaults


def save_settings(new_settings: dict[str, Any]) -> dict[str, Any]:
    merged = load_settings()
    merged.update(new_settings)
    SETTINGS_PATH.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return merged


class LocalStudioHTTPHandler(SimpleHTTPRequestHandler):
    """Serves UI static files and streams local video files with HTTP Range support."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Silence noisy per-chunk console logs
        return

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/media":
            self._serve_media_range(parsed.query)
            return
        super().do_GET()

    def _serve_media_range(self, query_str: str) -> None:
        media_file = STATE.playable_path
        if not media_file or not media_file.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "No media loaded")
            return

        file_size = media_file.stat().st_size
        ctype, _ = mimetypes.guess_type(str(media_file))
        if not ctype:
            ctype = "video/mp4"

        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        status = HTTPStatus.OK

        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(file_size - 1, int(m.group(2)))
                if start < file_size:
                    status = HTTPStatus.PARTIAL_CONTENT

        length = max(0, end - start + 1)
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

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


def start_local_server() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    server = ThreadingHTTPServer(("127.0.0.1", port), LocalStudioHTTPHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return port


class DesktopBridgeApi:
    """Exposed to JavaScript via window.pywebview.api.*"""

    def get_initial_bootstrap(self) -> dict[str, Any]:
        return {
            "presets": DEFAULT_PRESETS,
            "settings": load_settings(),
            "app_dir": str(APP_DIR),
        }

    def update_user_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        return save_settings(settings)

    def get_task_status(self) -> dict[str, Any]:
        return STATE.get_task()

    def pick_video_file(self) -> dict[str, Any]:
        if not STATE.window:
            return {"ok": False}
        file_types = (
            "音视频文件 (*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.flv;*.mp3;*.wav;*.m4a)",
            "所有文件 (*.*)",
        )
        selected = STATE.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False, file_types=file_types
        )
        if not selected:
            return {"ok": False, "cancelled": True}
        return self.load_video_by_path(selected[0])

    def load_video_by_path(self, raw_path: str) -> dict[str, Any]:
        path = Path(raw_path)
        if not path.exists():
            return {"ok": False, "error": f"找不到文件: {raw_path}"}

        STATE.video_path = path
        playable = ensure_playable_video(path, TEMP_MEDIA_DIR)
        STATE.playable_path = playable
        duration_sec = probe_media_duration(playable)

        # Look for matching same-name subtitle file automatically if present!
        auto_sub_path = None
        for ext in (".ass", ".srt", ".vtt"):
            candidate = path.with_suffix(ext)
            if candidate.exists():
                auto_sub_path = str(candidate)
                break

        media_url = (
            f"http://127.0.0.1:{STATE.server_port}/media?v={playable.stat().st_mtime_ns}"
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
            webview.OPEN_DIALOG, allow_multiple=False, file_types=file_types
        )
        if not selected:
            return {"ok": False, "cancelled": True}
        return self.load_subtitle_by_path(
            selected[0],
            action=action,
            lang_hint=lang_hint,
            align_mode=align_mode,
            current_subtitles=current_subtitles,
        )

    def load_subtitle_by_path(
        self,
        raw_path: str,
        action: str = "replace",
        lang_hint: str = "auto",
        align_mode: str = "time",
        current_subtitles: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        try:
            path = Path(raw_path)
            loaded = load_subtitle_file(path, lang_hint=lang_hint)
            if action == "merge" and current_subtitles:
                merged = merge_two_subtitles(
                    current_subtitles,
                    loaded,
                    secondary_lang=lang_hint,
                    align_mode=align_mode,
                )
                return {
                    "ok": True,
                    "file_name": path.name,
                    "subtitles": merged,
                    "count": len(merged),
                }
            return {
                "ok": True,
                "file_name": path.name,
                "subtitles": loaded,
                "count": len(loaded),
            }
        except Exception as exc:
            return {"ok": False, "error": f"解析字幕文件失败: {exc}"}

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
        if STATE.get_task()["running"]:
            return {"ok": False, "error": "已有 AI 任务正在运行中，请稍候…"}

        if workflow_type in ("asr_and_translate", "asr_only"):
            if not STATE.video_path or not STATE.video_path.exists():
                return {"ok": False, "error": "请先导入一个音视频文件，再启动 AI 语音听写！"}

        settings = save_settings(options.get("settings") or {})

        def worker() -> None:
            try:
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

                if workflow_type in ("asr_and_translate", "translate_only"):
                    direction = options.get("direction", "en_to_zh")
                    overwrite = bool(options.get("overwrite", False))
                    trans_cfg = {
                        "provider": settings.get("trans_provider", "free"),
                        "llm_base": settings.get("llm_base", ""),
                        "llm_key": settings.get("llm_key", ""),
                        "llm_model": settings.get("llm_model", ""),
                    }
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
                config={
                    "provider": settings.get("trans_provider", "free"),
                    "llm_base": settings.get("llm_base", ""),
                    "llm_key": settings.get("llm_key", ""),
                    "llm_model": settings.get("llm_model", ""),
                },
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
            webview.SAVE_DIALOG,
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

        suffix_label = {
            "bilingual": "中英双语",
            "zh_only": "中文字幕",
            "en_only": "英文字幕",
        }.get(lang_mode, "双语")
        stem = STATE.video_path.stem if STATE.video_path else default_stem
        default_dir = str(STATE.video_path.parent) if STATE.video_path else os.path.expanduser("~")
        suggested = f"{stem}.{suffix_label}.{resolution}.sup"

        save_target = STATE.window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=default_dir,
            save_filename=suggested,
            file_types=("蓝光原盘图形字幕 (*.sup)", "所有文件 (*.*)"),
        )
        if not save_target:
            return {"ok": False, "cancelled": True}

        out_path = Path(save_target if isinstance(save_target, str) else save_target[0])
        if out_path.suffix.lower() != ".sup":
            out_path = Path(str(out_path) + ".sup")

        def worker() -> None:
            try:
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
            webview.OPEN_DIALOG,
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
                webview.SAVE_DIALOG,
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

        def worker() -> None:
            try:
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
            if not files:
                return
            first = files[0]
            full_path = first.get("pywebviewFullPath") or first.get("path")
            if not full_path:
                return
            ext = Path(full_path).suffix.lower()
            escaped = json.dumps(full_path)
            if ext in (".srt", ".ass", ".ssa", ".vtt", ".txt", ".json"):
                window.evaluate_js(f"window.onNativeFileDropped('subtitle', {escaped})")
            else:
                window.evaluate_js(f"window.onNativeFileDropped('video', {escaped})")

        window.dom.document.events.dragover += DOMEventHandler(
            lambda e: None, prevent_default=True
        )
        window.dom.document.events.drop += DOMEventHandler(
            on_drop, prevent_default=True, stop_propagation=True
        )
    except Exception:
        pass


def main() -> None:
    port = start_local_server()
    STATE.server_port = port
    api = DesktopBridgeApi()

    window = webview.create_window(
        title="EasySub Studio · 傻瓜双语字幕工坊",
        url=f"http://127.0.0.1:{port}/index.html",
        js_api=api,
        width=1440,
        height=900,
        min_size=(1120, 720),
        background_color="#0B0F19",
        text_select=True,
    )
    STATE.window = window
    webview.start(
        func=lambda: bind_drag_and_drop(window, api),
        debug=False,
        storage_path=str(WEBVIEW_STORAGE_DIR),
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
