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
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable

import httpx
import numpy as np

from core.subtitles import has_cjk, is_foreign_lang_annotated, is_pure_sdh_noise

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
    if ext in (".mp4", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".ogg", ".flac"):
        return src
    # Stream large MKV/MOV files (>1.2 GB, e.g. Blu-ray REMUX) directly without copying tens of GBs to Temp!
    if ext in (".mkv", ".mov") and src.stat().st_size > 1_200_000_000:
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

    import sys
    import types

    # PyAV (68MB of video codecs) is unnecessary since we feed 16kHz float32 PCM directly from FFmpeg WAV
    if "av" not in sys.modules:
        try:
            import av  # noqa: F401
        except ImportError:
            sys.modules["av"] = types.ModuleType("av")

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

        # Local faster-whisper engine (feed 16kHz mono float32 PCM directly, zero PyAV overhead)
        import wave

        model_size = config.get("model_size", "base")
        model = _load_local_whisper_model(model_size, progress=progress)

        if progress:
            progress("正在进行 AI 语音识别与自动断句打轴…", 25)

        with wave.open(str(wav_path), "rb") as wf:
            pcm_bytes = wf.readframes(wf.getnframes())
        audio_np = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        segments_gen, info = model.transcribe(
            audio_np,
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


def parse_glossary_pairs(glossary_raw: str) -> list[tuple[str, str]]:
    """
    Parse user glossary like 'Will=威尔, Sylvia=西尔维娅' into [(src, dst), ...] sorted longest-first.
    """
    if not glossary_raw or not glossary_raw.strip():
        return []
    pairs: list[tuple[str, str]] = []
    for token in re.split(r"[,，;；\n]+", glossary_raw):
        token = token.strip()
        if not token:
            continue
        m = re.split(r"\s*(?:=|->|➔|:|：)\s*", token, maxsplit=1)
        if len(m) == 2 and m[0].strip() and m[1].strip():
            pairs.append((m[0].strip(), m[1].strip()))
    pairs.sort(key=lambda x: len(x[0]), reverse=True)
    return pairs


def _apply_glossary_placeholders(
    texts: list[str], pairs: list[tuple[str, str]]
) -> list[str]:
    if not pairs:
        return texts
    masked: list[str] = []
    for t in texts:
        cur = t
        for idx, (src, _dst) in enumerate(pairs):
            placeholder = f"[[EZG{idx}]]"
            if re.match(r"^[A-Za-z0-9_ ]+$", src):
                cur = re.sub(rf"\b{re.escape(src)}\b", placeholder, cur, flags=re.IGNORECASE)
            else:
                cur = cur.replace(src, placeholder)
        masked.append(cur)
    return masked


def _restore_glossary_placeholders(
    texts: list[str], pairs: list[tuple[str, str]]
) -> list[str]:
    if not pairs:
        return texts
    restored: list[str] = []
    for t in texts:
        cur = t
        for idx, (_src, dst) in enumerate(pairs):
            cur = re.sub(rf"\[\s*\[\s*EZG{idx}\s*\]\s*\]", dst, cur, flags=re.IGNORECASE)
        restored.append(cur)
    return restored


TRANSLATION_AGENT_PRESETS: dict[str, dict[str, str]] = {
    "us_drama": {
        "name": "🎬 美剧 / 好莱坞大片精翻 Agent (默认推荐)",
        "prompt": (
            "你是一位拥有十年经验的顶级影视双语字幕组译制总监（人人/衣柜字幕组标准）。\n"
            "【译制准则】\n"
            "1. 口语化与去翻译腔：对白必须符合人物身份、情绪与说话口吻，干脆利落，严禁生硬欧化长句或逐词死译。\n"
            "2. 语境指代精准还原：必须结合前后文（prev_context / next_context）判断人称代词（区分 you=你/你们/您，it/they 具体指代）及英语省略句的隐含宾语。\n"
            "3. 跨行断句顺畅衔接：当一句完整英文被拆成上下两行字幕时，两行译文单独可读、连读更要自然顺畅，绝不生硬倒装。\n"
            "4. 语速与阅读舒适度：参考每行时长（dur），短促呼喊（<1.2s）译文务必精炼有力（2~6字）；单行中文尽量控制在 22 字以内，句内停顿优先用单个空格代替逗号，句末不加句号。"
        ),
    },
    "scifi_epic": {
        "name": "🌌 科幻 / 奇幻史诗考据 Agent (沙丘 / 权游 / 星战)",
        "prompt": (
            "你是一位专精科幻与奇幻史诗巨制（如《沙丘》《权力的游戏》《指环王》）的考据派影视译者。\n"
            "【译制准则】\n"
            "1. 世界观与术语庄重统一：对家族、爵位、头衔、星球、教派、预言与专有设定词保持高度统一，切忌将专有设定词误作日常词汇直译。\n"
            "2. 阶层语感区分：皇室贵族、宗教圣母与史诗独白用词凝练典雅、富有宿命张力；战场军事通讯与战术口令短促铿锵（如“各单位注意”“自由开火”）。\n"
            "3. 紧密衔接前后对白语境，中文句内停顿优先使用空格，句末不加句号。"
        ),
    },
    "doc_tech": {
        "name": "🎓 纪录片 / TED 科普学术 Agent (BBC / 科技 / 访谈)",
        "prompt": (
            "你是一位资深自然历史纪录片（BBC/国家地理）与前沿科技访谈译者。\n"
            "【译制准则】\n"
            "1. 科学严谨与信达雅：专业学科术语、技术名词与数据逻辑必须精准无误，必要时保留规范英文缩写。\n"
            "2. 旁白叙述语调沉稳克制、凝练优美，长定语从句按中文叙事习惯拆解重排，逻辑因果清晰易懂。"
        ),
    },
    "sitcom_humor": {
        "name": "😂 情景喜剧 / 综艺脱口秀 Agent (老友记 / 生活大爆炸)",
        "prompt": (
            "你是一位专精英语情景喜剧、脱口秀与真人秀的本地化字幕译者。\n"
            "【译制准则】\n"
            "1. 包袱与情绪优先：敏锐捕捉美式反讽、自嘲、双关、俚语与吐槽节奏，用鲜活接地气的现代自然中文还原笑点。\n"
            "2. 台词灵动轻快、贴近真实日常聊天，适度意译但绝不生造违和烂梗。"
        ),
    },
    "anime_game": {
        "name": "⚔️ 动漫 / 剧情向游戏热血 Agent",
        "prompt": (
            "你是一位资深动画剧集与 3A 剧情游戏本地化译者。\n"
            "【译制准则】\n"
            "1. 鲜明展现角色性格反差、口癖与情绪爆发力；技能、阵营与招式名称兼具美感与气势。\n"
            "2. 战斗与快节奏过场台词短促有张力，绝不拖泥带水。"
        ),
    },
    "custom": {
        "name": "✍️ 自定义专属翻译 Agent 提示词",
        "prompt": (
            "你是一位资深影视双语字幕翻译专家。请结合完整上下文语境，将台词翻译得自然、准确、精炼，贴合人物口吻，句末不加句号。"
        ),
    },
}


def _strip_reasoning_and_parse_json(raw_content: str) -> dict[str, Any]:
    """
    Robustly parse JSON object from any OpenAI-compatible or reasoning LLM response
    (strips DeepSeek-R1 <think>...</think> blocks, markdown code fences, and trailing prose).
    """
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_content or "", flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    # Fallback: locate outermost {...} object
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        snippet = cleaned[first_brace : last_brace + 1]
        obj = json.loads(snippet)
        if isinstance(obj, dict):
            return obj
    raise ValueError(f"大模型返回内容未能解析为有效 JSON：{cleaned[:160]}")


_DOMESTIC_DIRECT_DOMAINS = (
    "deepseek.com",
    "siliconflow.cn",
    "aliyuncs.com",
    "moonshot.cn",
    "volces.com",
    "bigmodel.cn",
    "baidubce.com",
    "minimaxi.com",
)


def _prefer_direct_no_proxy(api_base: str) -> bool:
    b = (api_base or "").lower()
    if "127.0.0.1" in b or "localhost" in b:
        return True
    return any(dom in b for dom in _DOMESTIC_DIRECT_DOMAINS)


def _post_chat_completion(
    client: httpx.Client | None,
    api_base: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.25,
    json_mode: bool = True,
    max_tokens: int | None = None,
    timeout: float = 90.0,
) -> str:
    url = f"{api_base.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    is_reasoner = "reasoner" in model.lower() or "r1" in model.lower()
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if not is_reasoner:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if json_mode and not is_reasoner:
        payload["response_format"] = {"type": "json_object"}

    def _send_with(c: httpx.Client) -> str:
        req_payload = dict(payload)
        resp = c.post(url, headers=headers, json=req_payload)
        if resp.status_code == 400 and "response_format" in req_payload:
            req_payload.pop("response_format", None)
            resp = c.post(url, headers=headers, json=req_payload)
        resp.raise_for_status()
        data = resp.json()
        return (data["choices"][0]["message"].get("content") or "").strip()

    is_local = "127.0.0.1" in api_base or "localhost" in api_base
    if is_local:
        with httpx.Client(timeout=timeout, trust_env=False) as local_c:
            return _send_with(local_c)

    primary_trust = not _prefer_direct_no_proxy(api_base)
    try:
        with httpx.Client(timeout=timeout, trust_env=primary_trust) as c1:
            return _send_with(c1)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.ProxyError):
        # Automatic proxy/direct fallback if system proxy is stale or required!
        with httpx.Client(timeout=timeout, trust_env=not primary_trust) as c2:
            return _send_with(c2)


def test_llm_api_connection(api_base: str, api_key: str, model: str) -> dict[str, Any]:
    """Verify LLM endpoint, API key, and model availability with latency measurement."""
    base = (api_base or "").strip().rstrip("/")
    key = (api_key or "").strip()
    mdl = (model or "").strip()
    if not base:
        return {"ok": False, "error": "请先填写 API Base URL（例如 https://api.deepseek.com/v1）"}
    if not key and "127.0.0.1" not in base and "localhost" not in base:
        return {"ok": False, "error": "请先填写大模型 API Key"}
    if not mdl:
        return {"ok": False, "error": "请先填写模型名称（例如 deepseek-chat）"}

    t0 = time.perf_counter()
    try:
        reply = _post_chat_completion(
            None,
            api_base=base,
            api_key=key or "ollama",
            model=mdl,
            messages=[{"role": "user", "content": "请仅回复 OK 两个字母。"}],
            temperature=0.1,
            json_mode=False,
            max_tokens=32,
            timeout=22.0,
        )
        ms = int(round((time.perf_counter() - t0) * 1000))
        clean_reply = re.sub(r"<think>[\s\S]*?</think>", "", reply).strip()[:40]
        return {
            "ok": True,
            "latency_ms": ms,
            "model": mdl,
            "reply": clean_reply or "OK",
        }
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        detail = exc.response.text[:160]
        if code == 401:
            return {"ok": False, "error": "API Key 验证失败 (HTTP 401)：请检查 Key 是否正确或已过期"}
        if code == 402:
            return {"ok": False, "error": "API 账户余额不足 (HTTP 402)：请检查对应平台额度"}
        if code == 404:
            return {"ok": False, "error": f"接口地址或模型名称不存在 (HTTP 404)：请确认 Base URL 末尾含 /v1 且模型名 {mdl} 正确"}
        return {"ok": False, "error": f"API 请求返回错误 (HTTP {code})：{detail}"}
    except Exception as exc:
        return {"ok": False, "error": f"无法连接到 API 服务器：{exc}"}


def _resolve_agent_persona_prompt(cfg: dict[str, Any]) -> str:
    preset_id = str(cfg.get("preset") or "us_drama")
    custom_prompt = str(cfg.get("custom_prompt") or "").strip()
    if preset_id == "custom" and custom_prompt:
        return custom_prompt
    base_prompt = TRANSLATION_AGENT_PRESETS.get(preset_id, TRANSLATION_AGENT_PRESETS["us_drama"])["prompt"]
    if custom_prompt and preset_id != "custom":
        return f"{base_prompt}\n【用户补充要求】\n{custom_prompt}"
    return base_prompt


def _mine_existing_bilingual_anchors(subtitles: list[dict[str, Any]], max_anchors: int = 16) -> list[str]:
    """
    Extract reference bilingual lines containing proper nouns from already-translated rows
    in the current subtitle table so the Agent automatically learns existing character/place names!
    """
    prop_re = re.compile(r"\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b")
    skip_common = {
        "The", "This", "That", "What", "When", "Where", "Why", "How", "Who",
        "You", "They", "There", "Here", "Yes", "Not", "But", "And", "For",
        "Stay", "Come", "Don", "Are", "His", "Her", "Our", "All", "Now",
    }
    seen_terms: set[str] = set()
    anchors: list[str] = []
    for row in subtitles:
        zh = (row.get("zh") or "").strip()
        en = (row.get("en") or "").strip()
        if not zh or not en or len(en) > 95 or len(zh) > 45:
            continue
        found = [m for m in prop_re.findall(en) if m not in skip_common]
        new_terms = [t for t in found if t.lower() not in seen_terms]
        if new_terms:
            for t in new_terms:
                seen_terms.add(t.lower())
            anchors.append(f"{en} ➔ {zh}")
            if len(anchors) >= max_anchors:
                break
    return anchors


def _agent_stage1_discover_brief(
    client: httpx.Client,
    subtitles: list[dict[str, Any]],
    indices_to_translate: list[int],
    to_lang: str,
    api_base: str,
    api_key: str,
    model: str,
    story_context: str,
    existing_anchors: list[str],
    user_glossary: list[tuple[str, str]],
) -> tuple[str, list[tuple[str, str]]]:
    """
    Stage 1 of SubTranslationAgent:
    Pre-scan sampled lines across the movie + existing bilingual anchors to build a unified
    Synopsis Brief & Auto-Discovered Proper-Noun Glossary before batch translation starts!
    """
    total_t = len(indices_to_translate)
    if total_t < 8:
        return "", user_glossary

    # Sample up to 26 lines evenly across the untranslated script
    step = max(1, total_t // 26)
    sampled_indices = indices_to_translate[::step][:26]
    src_field = "en" if to_lang == "zh" else "zh"
    sampled_lines = [
        (subtitles[i].get(src_field) or "").strip()
        for i in sampled_indices
        if (subtitles[i].get(src_field) or "").strip()
    ]

    anchor_block = (
        "\n【本片已有人工双语对白参考（必须沿用其中译名！）】\n" + "\n".join(existing_anchors[:14])
        if existing_anchors
        else ""
    )
    user_ctx_block = f"\n【用户提供的影片背景】{story_context}" if story_context else ""
    target_lang_name = "简体中文" if to_lang == "zh" else "English"

    sys_msg = (
        "你是影视字幕译前审片与术语建档 Agent。请快速通读以下剧本抽样台词，输出紧凑 JSON 对象：\n"
        "{\n"
        '  "brief": "一句话概括影片题材、人物关系与对话基调（50字内）",\n'
        f'  "glossary": {{"原文专有名词或人名": "{target_lang_name}统一标准译名"}}\n'
        "}\n"
        "注意：glossary 仅收录高把握的人名、地名、家族、组织或核心设定词（最多 15 项）；若已有参考译名必须严格一致！"
    )
    user_msg = f"【抽样台词】\n" + "\n".join(sampled_lines) + anchor_block + user_ctx_block

    try:
        raw = _post_chat_completion(
            client,
            api_base=api_base,
            api_key=api_key,
            model=model,
            messages=[
                {"role": "system", "content": sys_msg},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.2,
            json_mode=True,
        )
        parsed = _strip_reasoning_and_parse_json(raw)
        brief = str(parsed.get("brief") or "").strip()
        auto_gloss_raw = parsed.get("glossary") or {}
        merged_map: dict[str, tuple[str, str]] = {}
        if isinstance(auto_gloss_raw, dict):
            for k, v in auto_gloss_raw.items():
                ks, vs = str(k).strip(), str(v).strip()
                if ks and vs and ks.lower() != vs.lower():
                    merged_map[ks.lower()] = (ks, vs)
        # User's explicit glossary ALWAYS overrides auto-discovered terms!
        for uk, uv in user_glossary:
            merged_map[uk.lower()] = (uk, uv)
        merged_list = sorted(merged_map.values(), key=lambda x: len(x[0]), reverse=True)
        return brief, merged_list
    except Exception:
        return "", user_glossary


def _polish_subtitle_output_line(text: str, to_lang: str, preset_id: str) -> str:
    t = (text or "").strip()
    # Strip any echoed duration tag like '[1.5s] '
    t = re.sub(r"^\[\d+(?:\.\d+)?s\]\s*", "", t).strip()
    if to_lang == "zh":
        t = re.sub(r"[。\.]+([\"”』」]?)$", r"\1", t)
        if preset_id in ("us_drama", "scifi_epic"):
            t = t.replace("？", "?").replace("！", "!")
            t = re.sub(r"[，、；]+([\"”』」]?)$", r"\1", t)
            t = re.sub(r"[，、]", " ", t)
            t = re.sub(r"\s+", " ", t).strip()
    return t


def translate_single_cue_with_context(
    subtitles: list[dict[str, Any]],
    row_idx: int,
    direction: str = "en_to_zh",
    config: dict[str, Any] | None = None,
) -> str:
    """
    Context-aware single-row translation with ±3 surrounding bilingual rows!
    Uses LLM Agent when configured, otherwise falls back to glossary-locked neural translation.
    """
    cfg = config or {}
    src_field = "en" if direction == "en_to_zh" else "zh"
    to_lang = "zh" if direction == "en_to_zh" else "en"
    target_row = subtitles[row_idx]
    src_txt = (target_row.get(src_field) or "").strip()
    if not src_txt:
        return ""

    provider = cfg.get("provider", "free")
    llm_key = (cfg.get("llm_key") or "").strip()
    llm_base = (cfg.get("llm_base") or "https://api.deepseek.com/v1").strip()
    llm_model = (cfg.get("llm_model") or "deepseek-chat").strip()
    preset_id = str(cfg.get("preset") or "us_drama")

    if provider == "llm" and (llm_key or "127.0.0.1" in llm_base or "localhost" in llm_base):
        persona = _resolve_agent_persona_prompt(cfg)
        glossary_pairs = parse_glossary_pairs(str(cfg.get("glossary") or ""))
        story_ctx = str(cfg.get("story_context") or "").strip()

        neighbors: list[str] = []
        for k in range(max(0, row_idx - 3), min(len(subtitles), row_idx + 4)):
            if k == row_idx:
                neighbors.append(f">>> [目标句 #{k+1}] 原文: {src_txt}")
            else:
                r = subtitles[k]
                neighbors.append(
                    f"[上下文 #{k+1}] EN: {(r.get('en') or '').strip()} | ZH: {(r.get('zh') or '').strip()}"
                )

        gloss_str = (
            "\n【锁定译名表】" + "；".join(f"{s} -> {d}" for s, d in glossary_pairs)
            if glossary_pairs
            else ""
        )
        ctx_str = f"\n【影片背景】{story_ctx}" if story_ctx else ""
        target_desc = "地道精炼的简体中文字幕" if to_lang == "zh" else "natural concise English subtitle"
        sys_msg = (
            f"{persona}{ctx_str}{gloss_str}\n"
            f"请结合上下相邻台词的语境与已有译名，仅将标记为 >>> [目标句] 的原文翻译为{target_desc}。\n"
            '严格只输出 JSON：{"translation": "译文内容"}'
        )
        with httpx.Client(timeout=45.0) as client:
            raw = _post_chat_completion(
                client,
                api_base=llm_base,
                api_key=llm_key or "ollama",
                model=llm_model,
                messages=[
                    {"role": "system", "content": sys_msg},
                    {"role": "user", "content": "\n".join(neighbors)},
                ],
                temperature=0.25,
                json_mode=True,
            )
            parsed = _strip_reasoning_and_parse_json(raw)
            out = str(parsed.get("translation") or "").strip()
            if out:
                return _polish_subtitle_output_line(out, to_lang, preset_id)

    res_list = translate_texts_list([src_txt], direction=direction, config=cfg)
    return _polish_subtitle_output_line(res_list[0] if res_list else "", to_lang, preset_id)


def _translate_batch_llm(
    texts: list[str],
    to_lang: str,
    api_base: str,
    api_key: str,
    model: str,
    glossary_pairs: list[tuple[str, str]] | None = None,
    progress: ProgressCallback | None = None,
    persona_prompt: str = "",
    story_context: str = "",
    preset_id: str = "us_drama",
) -> list[str]:
    """Standalone list translator via LLM (used for helper phrase/split tasks)."""
    target_desc = "地道、自然、简练的简体中文影视字幕" if to_lang == "zh" else "natural, concise English movie subtitles"
    results: list[str] = [""] * len(texts)
    chunk_size = 20
    persona = persona_prompt or TRANSLATION_AGENT_PRESETS["us_drama"]["prompt"]

    glossary_note = ""
    if glossary_pairs:
        formatted_terms = "；".join(f"{s} -> {d}" for s, d in glossary_pairs)
        glossary_note = f"\n【专有名词固定译法表（必须严格采用）】：{formatted_terms}。"
    ctx_note = f"\n【影片背景简注】：{story_context}" if story_context else ""

    with httpx.Client(timeout=90.0) as client:
        for start in range(0, len(texts), chunk_size):
            chunk = texts[start : start + chunk_size]
            numbered_input = {str(idx): line for idx, line in enumerate(chunk)}
            sys_prompt = (
                f"{persona}{ctx_note}{glossary_note}\n"
                f"请将用户提供的 JSON 字典中的每句台词结合前后语境翻译为{target_desc}。\n"
                '严格要求：必须仅输出合法的 JSON 对象，键名与输入完全一致（"0", "1"...），值为单行译文字符串，不合并、不遗漏任何一行。'
            )
            raw = _post_chat_completion(
                client,
                api_base=api_base,
                api_key=api_key or "ollama",
                model=model,
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": json.dumps(numbered_input, ensure_ascii=False)},
                ],
                temperature=0.25,
                json_mode=True,
            )
            parsed = _strip_reasoning_and_parse_json(raw)
            for offset in range(len(chunk)):
                val = str(parsed.get(str(offset), "")).strip()
                results[start + offset] = _polish_subtitle_output_line(val, to_lang, preset_id)

            if progress:
                pct = min(98, 20 + int(((start + len(chunk)) / max(1, len(texts))) * 78))
                progress(f"AI 翻译 Agent 精翻进度：{min(len(texts), start + len(chunk))} / {len(texts)} 句…", pct)

    return results


def translate_texts_list(
    source_texts: list[str],
    direction: str = "en_to_zh",
    config: dict[str, Any] | None = None,
    progress: ProgressCallback | None = None,
) -> list[str]:
    if not source_texts:
        return []
    cfg = config or {}
    provider = cfg.get("provider", "free")
    to_lang = "zh" if direction == "en_to_zh" else "en"
    glossary_pairs = parse_glossary_pairs(str(cfg.get("glossary") or ""))
    preset_id = str(cfg.get("preset") or "us_drama")

    if provider == "llm":
        llm_base = (cfg.get("llm_base") or "https://api.deepseek.com/v1").strip()
        llm_key = (cfg.get("llm_key") or "").strip()
        llm_model = (cfg.get("llm_model") or "deepseek-chat").strip()
        if llm_key or "127.0.0.1" in llm_base or "localhost" in llm_base:
            return _translate_batch_llm(
                source_texts,
                to_lang,
                llm_base,
                llm_key or "ollama",
                llm_model,
                glossary_pairs=glossary_pairs,
                progress=progress,
                persona_prompt=_resolve_agent_persona_prompt(cfg),
                story_context=str(cfg.get("story_context") or "").strip(),
                preset_id=preset_id,
            )

    prepared_texts = _apply_glossary_placeholders(source_texts, glossary_pairs)
    last_err = None
    for fn_name, fn in (
        ("极速神经网络批量翻译", _translate_batch_google_clients5),
        ("MyMemory 并发翻译", _translate_batch_mymemory),
    ):
        try:
            if progress:
                progress(f"正在通过{fn_name}处理 ({len(source_texts)} 句)…", 45)
            raw_trans = fn(prepared_texts, to_lang)
            if len(raw_trans) == len(source_texts):
                return _restore_glossary_placeholders(raw_trans, glossary_pairs)
        except Exception as exc:
            last_err = exc
            continue
    raise RuntimeError(f"在线翻译请求失败，请检查网络连接或配置大模型 API：{last_err}")


def translate_subtitles(
    subtitles: list[dict[str, Any]],
    direction: str = "en_to_zh",
    overwrite_existing: bool = False,
    config: dict[str, Any] | None = None,
    progress: ProgressCallback | None = None,
    skip_foreign_notes: bool = False,
) -> list[dict[str, Any]]:
    """
    Translate missing (or all) bilingual fields across subtitles.
    When provider == 'llm', runs the 3-Stage SubTranslationAgent:
      Stage 1 -> Film Synopsis & Existing Bilingual Proper-Noun Auto-Discovery
      Stage 2 -> Sliding-Window (prev 4 + target 18 w/ duration + next 3 lookahead) Context Translation
      Stage 3 -> Missing-Line Self-Check Retry & Cinema Typography Polish
    """
    cfg = config or {}
    provider = cfg.get("provider", "free")
    src_field = "en" if direction == "en_to_zh" else "zh"
    dst_field = "zh" if direction == "en_to_zh" else "en"
    to_lang = "zh" if direction == "en_to_zh" else "en"
    preset_id = str(cfg.get("preset") or "us_drama")

    updated = [dict(item) for item in subtitles]
    indices_to_translate: list[int] = []
    source_texts: list[str] = []

    for idx, item in enumerate(updated):
        if item.get("motion"):
            continue
        src_txt = (item.get(src_field) or "").strip()
        dst_txt = (item.get(dst_field) or "").strip()
        if not src_txt or not (overwrite_existing or not dst_txt):
            continue
        if direction == "en_to_zh" and is_pure_sdh_noise(src_txt):
            continue
        if skip_foreign_notes and direction == "zh_to_en" and is_foreign_lang_annotated(src_txt):
            continue
        indices_to_translate.append(idx)
        source_texts.append(src_txt)

    if not source_texts:
        return updated

    if provider == "llm":
        llm_base = (cfg.get("llm_base") or "https://api.deepseek.com/v1").strip()
        llm_key = (cfg.get("llm_key") or "").strip()
        llm_model = (cfg.get("llm_model") or "deepseek-chat").strip()
        if not llm_key and "127.0.0.1" not in llm_base and "localhost" not in llm_base:
            raise ValueError("使用 AI 大模型精翻时，请先填写 API Key（或切换为“免配置极速翻译”）。")

        persona_prompt = _resolve_agent_persona_prompt(cfg)
        story_context = str(cfg.get("story_context") or "").strip()
        agent_mode = bool(cfg.get("agent_mode", True))
        user_glossary = parse_glossary_pairs(str(cfg.get("glossary") or ""))
        existing_anchors = _mine_existing_bilingual_anchors(updated, max_anchors=16)

        with httpx.Client(timeout=100.0) as client:
            discovered_brief = ""
            active_glossary = user_glossary
            if agent_mode and len(indices_to_translate) >= 8:
                if progress:
                    progress("🧠 Agent 阶段 1/3：正在通读全片抽样语境并建立专有名词译名档案…", 14)
                discovered_brief, active_glossary = _agent_stage1_discover_brief(
                    client,
                    subtitles=updated,
                    indices_to_translate=indices_to_translate,
                    to_lang=to_lang,
                    api_base=llm_base,
                    api_key=llm_key or "ollama",
                    model=llm_model,
                    story_context=story_context,
                    existing_anchors=existing_anchors,
                    user_glossary=user_glossary,
                )

            brief_section = ""
            if story_context or discovered_brief:
                combined_brief = "；".join(filter(None, [story_context, discovered_brief]))
                brief_section = f"\n【全片剧情与基调记忆】：{combined_brief}"
            gloss_section = ""
            if active_glossary:
                gloss_section = "\n【全片锁定译名表（必须严格统一）】：\n" + "；".join(
                    f"{s} = {d}" for s, d in active_glossary[:35]
                )
            anchor_section = ""
            if existing_anchors:
                anchor_section = "\n【本片既有双语参考句】：" + " | ".join(existing_anchors[:6])

            target_desc = "简体中文影视字幕" if to_lang == "zh" else "English movie subtitles"
            sys_prompt = (
                f"{persona_prompt}{brief_section}{gloss_section}{anchor_section}\n\n"
                "【输出格式铁律】\n"
                f"用户将提供一段包含 prev_context（前文参考）、target_lines（待译台词，含时长 dur）与 next_context（后文预读）的剧本片段。\n"
                f"请仅针对 target_lines 中的每一项结合前后语境译为{target_desc}，并严格只输出 JSON 对象：\n"
                '{"0": "第0项译文", "1": "第1项译文", ...}\n'
                "绝不要输出 prev_context 或 next_context，绝不要合并或漏掉任何键名，译文中不要包含 [1.5s] 时长标签！"
            )

            batch_size = 18
            missed_positions: list[int] = []

            for b_start in range(0, len(indices_to_translate), batch_size):
                batch_indices = indices_to_translate[b_start : b_start + batch_size]
                first_row_i = batch_indices[0]
                last_row_i = batch_indices[-1]

                # Sliding window: up to 4 preceding rows (with fresh translations!) + up to 3 lookahead rows
                prev_ctx = []
                for pi in range(max(0, first_row_i - 4), first_row_i):
                    pr = updated[pi]
                    p_en = (pr.get("en") or "").strip()
                    p_zh = (pr.get("zh") or "").strip()
                    if p_en or p_zh:
                        prev_ctx.append(f"#{pi+1} EN: {p_en} | ZH: {p_zh}")

                next_ctx = []
                for ni in range(last_row_i + 1, min(len(updated), last_row_i + 4)):
                    nr = updated[ni]
                    n_src = (nr.get(src_field) or "").strip()
                    if n_src:
                        next_ctx.append(f"#{ni+1}: {n_src}")

                target_payload: dict[str, str] = {}
                for offset, r_idx in enumerate(batch_indices):
                    row = updated[r_idx]
                    dur_s = max(0.3, (int(row.get("end_ms", 2000)) - int(row.get("start_ms", 0))) / 1000.0)
                    target_payload[str(offset)] = f"[{dur_s:.1f}s] {(row.get(src_field) or '').strip()}"

                user_payload = {
                    "prev_context_readonly": prev_ctx,
                    "target_lines": target_payload,
                    "next_context_readonly": next_ctx,
                }

                if progress:
                    pct = min(94, 22 + int(((b_start + len(batch_indices)) / max(1, len(indices_to_translate))) * 70))
                    progress(
                        f"🧠 Agent 阶段 2/3：上下文滑动精翻 {min(len(indices_to_translate), b_start + len(batch_indices))} / {len(indices_to_translate)} 句…",
                        pct,
                    )

                raw = _post_chat_completion(
                    client,
                    api_base=llm_base,
                    api_key=llm_key or "ollama",
                    model=llm_model,
                    messages=[
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
                    ],
                    temperature=0.25,
                    json_mode=True,
                )
                parsed = _strip_reasoning_and_parse_json(raw)
                # Handle case where model wraps inside {"target_lines": {...}} or {"translations": {...}}
                if "0" not in parsed:
                    for wrap_k in ("target_lines", "translations", "result", "data"):
                        if isinstance(parsed.get(wrap_k), dict):
                            parsed = parsed[wrap_k]
                            break

                for offset, r_idx in enumerate(batch_indices):
                    val = str(parsed.get(str(offset), "")).strip()
                    polished = _polish_subtitle_output_line(val, to_lang, preset_id)
                    if polished:
                        updated[r_idx][dst_field] = polished
                    else:
                        missed_positions.append(r_idx)

            # Stage 3: Self-check & focused retry on any missed lines!
            if missed_positions:
                if progress:
                    progress(f"🔍 Agent 阶段 3/3：正在对 {len(missed_positions)} 句漏译项进行焦点重译审校…", 96)
                for r_idx in missed_positions[:25]:
                    try:
                        retry_txt = translate_single_cue_with_context(
                            updated, r_idx, direction=direction, config=cfg
                        )
                        if retry_txt:
                            updated[r_idx][dst_field] = retry_txt
                    except Exception:
                        pass

        if progress:
            progress("AI 影视翻译 Agent 精翻完成！", 100)
        return updated

    if progress:
        progress(f"准备翻译 {len(source_texts)} 句台词…", 15)

    translated_list = translate_texts_list(
        source_texts, direction=direction, config=cfg, progress=progress
    )

    for idx, trans_text in zip(indices_to_translate, translated_list):
        updated[idx][dst_field] = _polish_subtitle_output_line(trans_text, to_lang, preset_id)

    if progress:
        progress("双语翻译全部完成！", 100)

    return updated
