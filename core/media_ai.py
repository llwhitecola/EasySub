"""
FFmpeg audio waveform extraction, container compatibility remuxing,
AI Whisper speech-to-text (local faster-whisper + OpenAI-compatible API),
and AI bilingual translation (zero-config Edge/Google/MyMemory + LLM API).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any, Callable

import httpx
import numpy as np

from core.subtitles import has_cjk

ProgressCallback = Callable[[str, int], None]

# Subprocess creation flags on Windows to hide flashing console windows
WIN_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

# Cache loaded faster-whisper model instances across runs
_WHISPER_CACHE: dict[str, Any] = {}


def probe_media_duration(video_path: str | Path) -> float:
    """Get media duration in seconds via ffprobe."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=WIN_NO_WINDOW,
        )
        return max(0.0, float(res.stdout.strip()))
    except Exception:
        return 0.0


def ensure_playable_video(video_path: str | Path, temp_dir: Path) -> Path:
    """
    HTML5 WebView2 plays .mp4, .webm, .m4v, .mov, .mp3, .wav, .m4a natively.
    For .mkv, .avi, .flv, .ts, .wmv, fast-remux (or lightweight audio transcode) to MP4
    so video preview & audio playback always work smoothly.
    """
    src = Path(video_path)
    ext = src.suffix.lower()
    if ext in (".mp4", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".ogg"):
        return src

    temp_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^A-Za-z0-9_\-\u4e00-\u9fff]", "_", src.stem)
    target = temp_dir / f"preview_{safe_stem}_{src.stat().st_mtime_ns}.mp4"
    if target.exists() and target.stat().st_size > 1024:
        return target

    # Try fast stream copy video + AAC audio first (very fast for MKV/MOV/TS with H.264)
    cmd_remux = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(target),
    ]
    res = subprocess.run(
        cmd_remux, capture_output=True, creationflags=WIN_NO_WINDOW
    )
    if res.returncode == 0 and target.exists() and target.stat().st_size > 1024:
        return target

    # Fallback full fast transcode if codec isn't MP4-compatible (e.g. WMV / AVI MPEG4)
    cmd_transcode = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vf",
        "scale='min(1280,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "25",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(target),
    ]
    subprocess.run(cmd_transcode, capture_output=True, creationflags=WIN_NO_WINDOW)
    return target if target.exists() else src


def extract_waveform_peaks(
    video_path: str | Path, peaks_per_sec: int = 25
) -> dict[str, Any]:
    """
    Extract downsampled audio waveform envelope via FFmpeg stdout pipe -> NumPy.
    Returns { peaks_per_sec, duration_ms, peaks: [0..100 int list] }.
    """
    sample_rate = peaks_per_sec * 80  # e.g. 2000 Hz mono PCM
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "-",
    ]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            timeout=90,
            creationflags=WIN_NO_WINDOW,
        )
        raw = res.stdout
        if not raw:
            return {"peaks_per_sec": peaks_per_sec, "duration_ms": 0, "peaks": []}

        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
        window = 80
        usable = (len(samples) // window) * window
        if usable == 0:
            return {"peaks_per_sec": peaks_per_sec, "duration_ms": 0, "peaks": []}

        reshaped = np.abs(samples[:usable]).reshape(-1, window)
        peaks = reshaped.max(axis=1)
        p98 = float(np.percentile(peaks, 98.5)) if len(peaks) > 10 else float(peaks.max())
        denom = max(p98, 500.0)
        norm = np.clip(np.round((peaks / denom) * 100.0), 0, 100).astype(int).tolist()
        duration_ms = int(round(len(norm) * (1000.0 / peaks_per_sec)))
        return {
            "peaks_per_sec": peaks_per_sec,
            "duration_ms": duration_ms,
            "peaks": norm,
        }
    except Exception:
        return {"peaks_per_sec": peaks_per_sec, "duration_ms": 0, "peaks": []}


def extract_16k_wav(video_path: str | Path, wav_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    res = subprocess.run(cmd, capture_output=True, creationflags=WIN_NO_WINDOW)
    if res.returncode != 0 or not wav_path.exists():
        err = res.stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"FFmpeg 提取音频失败: {err[:300]}")


def _load_local_whisper_model(model_size: str, progress: ProgressCallback | None = None):
    if model_size in _WHISPER_CACHE:
        return _WHISPER_CACHE[model_size]

    from faster_whisper import WhisperModel

    def try_load(endpoint: str | None, device: str, compute_type: str):
        if endpoint:
            os.environ["HF_ENDPOINT"] = endpoint
        return WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            cpu_threads=max(2, (os.cpu_count() or 4) - 1),
        )

    if progress:
        progress(f"正在加载本地语音模型 ({model_size})，首次使用会自动下载模型文件…", 15)

    # Try CPU int8 directly first for rock-solid compatibility without requiring external cuDNN DLLs,
    # unless CUDA works cleanly on first shot.
    endpoints = [os.environ.get("HF_ENDPOINT", ""), "https://hf-mirror.com"]
    last_err = None
    for ep in endpoints:
        for dev, ctype in (("cuda", "float16"), ("cpu", "int8")):
            try:
                model = try_load(ep if ep else None, dev, ctype)
                # Verify inference engine works (catches missing cublas/cudnn DLLs early)
                if dev == "cuda":
                    test_audio = np.zeros(16000, dtype=np.float32)
                    segs, _ = model.transcribe(test_audio, language="en")
                    list(segs)
                _WHISPER_CACHE[model_size] = model
                return model
            except Exception as exc:
                last_err = exc
                continue

    raise RuntimeError(f"无法加载本地 Whisper 模型 ({model_size}): {last_err}")


def transcribe_video(
    video_path: str | Path,
    config: dict[str, Any],
    progress: ProgressCallback | None = None,
) -> list[dict[str, Any]]:
    """
    Transcribe video/audio into subtitle cues.
    config:
      - engine: 'local' | 'api'
      - model_size: 'tiny' | 'base' | 'small' | 'medium' (for local)
      - source_lang: 'en' | 'zh' | 'auto'
      - api_base: e.g. 'https://api.openai.com/v1'
      - api_key: str
      - api_model: e.g. 'whisper-1'
    """
    engine = config.get("engine", "local")
    source_lang = config.get("source_lang", "en")
    lang_arg = None if source_lang == "auto" else source_lang

    with tempfile.TemporaryDirectory(prefix="easysub_asr_") as tmp_dir:
        wav_path = Path(tmp_dir) / "audio_16k.wav"
        if progress:
            progress("正在从视频中提取高清人声音轨…", 8)
        extract_16k_wav(video_path, wav_path)

        total_dur = max(1.0, probe_media_duration(wav_path))

        if engine == "api":
            api_base = (config.get("api_base") or "https://api.openai.com/v1").rstrip("/")
            api_key = (config.get("api_key") or "").strip()
            api_model = (config.get("api_model") or "whisper-1").strip()
            if not api_key:
                raise ValueError("使用云端语音识别接口时，请填写 API Key（或切换为免费的本地离线识别）。")

            if progress:
                progress("正在上传音频至云端 AI 语音识别服务…", 28)

            url = f"{api_base}/audio/transcriptions"
            data: dict[str, Any] = {
                "model": api_model,
                "response_format": "verbose_json",
            }
            if lang_arg:
                data["language"] = lang_arg

            with wav_path.open("rb") as f, httpx.Client(timeout=300.0) as client:
                resp = client.post(
                    url,
                    headers={"Authorization": f"Bearer {api_key}"},
                    data=data,
                    files={"file": ("audio.wav", f, "audio/wav")},
                )
                resp.raise_for_status()
                payload = resp.json()

            segments = payload.get("segments") or []
            cues: list[dict[str, Any]] = []
            if not segments and payload.get("text"):
                txt = payload["text"].strip()
                is_zh = has_cjk(txt)
                cues.append(
                    {
                        "id": 1,
                        "start_ms": 0,
                        "end_ms": int(total_dur * 1000),
                        "zh": txt if is_zh else "",
                        "en": "" if is_zh else txt,
                    }
                )
                return cues

            for seg in segments:
                txt = (seg.get("text") or "").strip()
                if not txt:
                    continue
                s_ms = int(round(float(seg.get("start", 0.0)) * 1000))
                e_ms = int(round(float(seg.get("end", 0.0)) * 1000))
                is_zh = source_lang == "zh" or (source_lang == "auto" and has_cjk(txt))
                cues.append(
                    {
                        "id": len(cues) + 1,
                        "start_ms": s_ms,
                        "end_ms": max(e_ms, s_ms + 400),
                        "zh": txt if is_zh else "",
                        "en": "" if is_zh else txt,
                    }
                )
            return cues

        # Local faster-whisper engine
        model_size = config.get("model_size", "base")
        model = _load_local_whisper_model(model_size, progress=progress)

        if progress:
            progress("正在进行 AI 语音识别与自动断句打轴…", 25)

        segments_gen, info = model.transcribe(
            str(wav_path),
            language=lang_arg,
            beam_size=4,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 420},
        )

        detected_lang = getattr(info, "language", source_lang) or source_lang
        cues = []
        for seg in segments_gen:
            txt = (seg.text or "").strip()
            if not txt:
                continue
            s_ms = int(round(seg.start * 1000))
            e_ms = int(round(seg.end * 1000))
            is_zh = detected_lang.startswith("zh") or has_cjk(txt)
            cues.append(
                {
                    "id": len(cues) + 1,
                    "start_ms": s_ms,
                    "end_ms": max(e_ms, s_ms + 400),
                    "zh": txt if is_zh else "",
                    "en": "" if is_zh else txt,
                }
            )
            if progress:
                pct = min(88, 25 + int((seg.end / total_dur) * 63))
                progress(f"已识别 {len(cues)} 句台词 ({seg.end:.1f}s / {total_dur:.1f}s)…", pct)

        return cues


# ---------------------------------------------------------------------------
# Translation Engines (Free Zero-Config Edge/Google/MyMemory + LLM API)
# ---------------------------------------------------------------------------


def _translate_batch_google_clients5(texts: list[str], to_lang: str) -> list[str]:
    """
    Fast, zero-config batch translation via Google clients5 JSON array endpoint.
    Passing repeated ('q', line) parameters returns an exact 1-to-1 translated array!
    """
    target = "zh-CN" if to_lang == "zh" else "en"
    results: list[str] = []
    timeout = httpx.Timeout(connect=4.0, read=12.0, write=8.0, pool=4.0)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        )
    }
    with httpx.Client(timeout=timeout, headers=headers) as client:
        chunk_size = 25
        for i in range(0, len(texts), chunk_size):
            chunk = texts[i : i + chunk_size]
            params: list[tuple[str, str]] = [
                ("client", "dict-chrome-ex"),
                ("sl", "auto"),
                ("tl", target),
            ]
            for line in chunk:
                params.append(("q", line))
            resp = client.post("https://clients5.google.com/translate_a/t", data=params)
            resp.raise_for_status()
            data = resp.json()
            # When len(chunk) == 1, data may be ["trans"] or [["trans", "src"]]
            if len(chunk) == 1:
                if isinstance(data, list) and data:
                    first = data[0]
                    results.append((first[0] if isinstance(first, list) else str(first)).strip())
                else:
                    results.append("")
            else:
                for item in data:
                    if isinstance(item, list) and item:
                        results.append(str(item[0]).strip())
                    else:
                        results.append(str(item).strip())
    return results


def _translate_batch_mymemory(texts: list[str], to_lang: str) -> list[str]:
    from concurrent.futures import ThreadPoolExecutor

    langpair = "en|zh-CN" if to_lang == "zh" else "zh-CN|en"
    timeout = httpx.Timeout(connect=4.0, read=10.0, write=6.0, pool=4.0)

    def fetch_one(client: httpx.Client, text: str) -> str:
        resp = client.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text, "langpair": langpair},
        )
        resp.raise_for_status()
        data = resp.json()
        return (data.get("responseData", {}).get("translatedText") or "").strip()

    with httpx.Client(timeout=timeout) as client:
        with ThreadPoolExecutor(max_workers=6) as pool:
            return list(pool.map(lambda t: fetch_one(client, t), texts))


def _translate_batch_llm(
    texts: list[str],
    to_lang: str,
    api_base: str,
    api_key: str,
    model: str,
    progress: ProgressCallback | None = None,
) -> list[str]:
    """
    Context-aware cinema subtitle translation via any OpenAI-compatible Chat Completions API
    (DeepSeek, OpenAI, SiliconFlow, Qwen, Moonshot, Ollama, etc.).
    """
    target_desc = "地道、自然、简练的简体中文影视字幕" if to_lang == "zh" else "natural, concise English movie subtitles"
    url = f"{api_base.rstrip('/')}/chat/completions"
    results: list[str] = [""] * len(texts)
    chunk_size = 25

    with httpx.Client(timeout=90.0) as client:
        for start in range(0, len(texts), chunk_size):
            chunk = texts[start : start + chunk_size]
            numbered_input = {str(idx): line for idx, line in enumerate(chunk)}
            sys_prompt = (
                f"你是一位资深影视双语字幕翻译专家。请将用户提供的 JSON 字典中的每句台词结合前后语境翻译为{target_desc}。\n"
                "严格要求：\n"
                "1. 必须仅输出合法的 JSON 对象，键名与输入完全一致（如 \"0\", \"1\"...），值为翻译后的单行字符串。\n"
                "2. 不要合并或遗漏任何一行，字幕末尾不要加句号，保持口语自然流畅。"
            )
            resp = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "temperature": 0.3,
                    "messages": [
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": json.dumps(numbered_input, ensure_ascii=False)},
                    ],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            # Strip markdown code fences if present
            content = re.sub(r"^```(?:json)?\s*", "", content)
            content = re.sub(r"\s*```$", "", content)
            parsed = json.loads(content)
            for offset in range(len(chunk)):
                val = parsed.get(str(offset), "")
                results[start + offset] = str(val).strip()

            if progress:
                pct = min(98, 20 + int(((start + len(chunk)) / max(1, len(texts))) * 78))
                progress(f"大模型精翻进度：{min(len(texts), start + len(chunk))} / {len(texts)} 句…", pct)

    return results


def translate_subtitles(
    subtitles: list[dict[str, Any]],
    direction: str = "en_to_zh",
    overwrite_existing: bool = False,
    config: dict[str, Any] | None = None,
    progress: ProgressCallback | None = None,
) -> list[dict[str, Any]]:
    """
    Translate missing (or all) bilingual fields across subtitles.
    direction: 'en_to_zh' | 'zh_to_en'
    config:
      - provider: 'free' | 'llm'
      - llm_base: e.g. 'https://api.deepseek.com/v1'
      - llm_key: str
      - llm_model: e.g. 'deepseek-chat'
    """
    cfg = config or {}
    provider = cfg.get("provider", "free")
    src_field = "en" if direction == "en_to_zh" else "zh"
    dst_field = "zh" if direction == "en_to_zh" else "en"
    to_lang = "zh" if direction == "en_to_zh" else "en"

    updated = [dict(item) for item in subtitles]
    indices_to_translate: list[int] = []
    source_texts: list[str] = []

    for idx, item in enumerate(updated):
        src_txt = (item.get(src_field) or "").strip()
        dst_txt = (item.get(dst_field) or "").strip()
        if src_txt and (overwrite_existing or not dst_txt):
            indices_to_translate.append(idx)
            source_texts.append(src_txt)

    if not source_texts:
        return updated

    if progress:
        progress(f"准备翻译 {len(source_texts)} 句台词…", 15)

    translated_list: list[str] = []
    if provider == "llm":
        llm_base = (cfg.get("llm_base") or "https://api.deepseek.com/v1").strip()
        llm_key = (cfg.get("llm_key") or "").strip()
        llm_model = (cfg.get("llm_model") or "deepseek-chat").strip()
        if not llm_key:
            raise ValueError("使用 AI 大模型精翻时，请先填写 API Key（或切换为“免配置极速翻译”）。")
        translated_list = _translate_batch_llm(
            source_texts, to_lang, llm_base, llm_key, llm_model, progress=progress
        )
    else:
        # Automatic multi-engine zero-config translation: Google clients5 -> MyMemory
        last_err = None
        for fn_name, fn in (
            ("极速神经网络批量翻译", _translate_batch_google_clients5),
            ("MyMemory 并发翻译", _translate_batch_mymemory),
        ):
            try:
                if progress:
                    progress(f"正在通过{fn_name}批量生成双语字幕…", 45)
                translated_list = fn(source_texts, to_lang)
                if len(translated_list) == len(source_texts):
                    break
            except Exception as exc:
                last_err = exc
                continue
        if len(translated_list) != len(source_texts):
            raise RuntimeError(f"在线翻译请求失败，请检查网络连接或配置大模型 API：{last_err}")

    for idx, trans_text in zip(indices_to_translate, translated_list):
        # Remove trailing full-stop period in Chinese movie subtitles for cleaner look
        if to_lang == "zh":
            trans_text = re.sub(r"[。\.]$", "", trans_text.strip())
        updated[idx][dst_field] = trans_text

    if progress:
        progress("双语翻译全部完成！", 100)

    return updated
