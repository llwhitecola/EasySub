"""
Subtitle parsing, bilingual auto-splitting, merging/alignment,
style presets, and ASS v4+ / SRT export engine.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

# Regex to detect CJK characters (Chinese/Japanese/Korean ideographs)
CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")
LATIN_RE = re.compile(r"[A-Za-z]")
ASS_TAG_RE = re.compile(r"\{[^}]*\}")
HTML_TAG_RE = re.compile(r"<[^>]+>")


DEFAULT_PRESETS: list[dict[str, Any]] = [
    {
        "id": "us_drama_default",
        "name": "美剧双语经典 (默认)",
        "desc": "文泉驿微米黑银灰白 + ITC 暖沙金英文，紧凑行距、93%窄字宽与柔边羽化(\\blur2)",
        "order": "zh_top",
        "margin_v": 15,
        "line_gap": 8,
        "blur": 2.0,
        "ycbcr_matrix": "None",
        "box_mode": False,
        "box_color": "#000000",
        "box_opacity": 0.55,
        "zh": {
            "style_name": "默认文泉",
            "font": "WenQuanYi Micro Hei",
            "size": 70,
            "color": "#B7B7B7",
            "secondary_color": "#000000",
            "outline_color": "#000000",
            "back_color": "#000000",
            "back_opacity": 1.0,
            "outline": 0.8,
            "shadow": 0.7,
            "scale_x": 93,
            "margin_l": 10,
            "margin_r": 11,
            "bold": True,
            "italic": False,
        },
        "en": {
            "style_name": "Eng - ITC",
            "font": "ITCAvantGardePro-Demi",
            "size": 47,
            "color": "#C0A783",
            "secondary_color": "#FF0000",
            "outline_color": "#040000",
            "back_color": "#091703",
            "back_opacity": 1.0,
            "outline": 0.8,
            "shadow": 0.8,
            "scale_x": 95,
            "margin_l": 15,
            "margin_r": 15,
            "bold": True,
            "italic": False,
        },
    },
    {
        "id": "cinema_classic",
        "name": "经典蓝光亮白",
        "desc": "纯白中文 + 柔和浅灰英文，清晰描边阴影，百搭各类普通 SDR 电影剧集",
        "order": "zh_top",
        "margin_v": 42,
        "line_gap": 4,
        "blur": 0.8,
        "ycbcr_matrix": "TV.709",
        "box_mode": False,
        "box_color": "#000000",
        "box_opacity": 0.55,
        "zh": {
            "font": "Microsoft YaHei",
            "size": 58,
            "color": "#FFFFFF",
            "outline_color": "#111827",
            "outline": 2.4,
            "shadow": 1.6,
            "scale_x": 100,
            "bold": True,
            "italic": False,
        },
        "en": {
            "font": "Segoe UI",
            "size": 36,
            "color": "#E2E8F0",
            "outline_color": "#111827",
            "outline": 1.8,
            "shadow": 1.4,
            "scale_x": 100,
            "bold": False,
            "italic": False,
        },
    },
    {
        "id": "doc_immersive_box",
        "name": "纪录片黑底沉浸盒",
        "desc": "半透明暗黑衬底条，即使画面纯白或背景杂乱也能丝滑阅读",
        "order": "zh_top",
        "margin_v": 48,
        "line_gap": 4,
        "box_mode": True,
        "box_color": "#0F172A",
        "box_opacity": 0.72,
        "zh": {
            "font": "Microsoft YaHei",
            "size": 52,
            "color": "#FFFFFF",
            "outline_color": "#0F172A",
            "outline": 1.5,
            "shadow": 0.0,
            "bold": True,
            "italic": False,
        },
        "en": {
            "font": "Segoe UI",
            "size": 32,
            "color": "#CBD5E1",
            "outline_color": "#0F172A",
            "outline": 1.2,
            "shadow": 0.0,
            "bold": False,
            "italic": False,
        },
    },
    {
        "id": "art_house",
        "name": "文艺电影极简白",
        "desc": "宋体/衬线质感 + 纤细描边与柔和投影，适合文艺片、Vlog 与短片",
        "order": "zh_top",
        "margin_v": 54,
        "line_gap": 5,
        "box_mode": False,
        "box_color": "#000000",
        "box_opacity": 0.5,
        "zh": {
            "font": "SimSun",
            "size": 52,
            "color": "#FAF8F5",
            "outline_color": "#1E1E1E",
            "outline": 1.8,
            "shadow": 2.2,
            "bold": True,
            "italic": False,
        },
        "en": {
            "font": "Georgia",
            "size": 33,
            "color": "#E7E5E4",
            "outline_color": "#1E1E1E",
            "outline": 1.5,
            "shadow": 1.8,
            "bold": False,
            "italic": True,
        },
    },
    {
        "id": "ted_talk",
        "name": "TED 公开课高对比",
        "desc": "醒目纯白中文 + 活力暖橙英文，适合公开课、访谈、科技评测",
        "order": "zh_top",
        "margin_v": 46,
        "line_gap": 4,
        "box_mode": False,
        "box_color": "#000000",
        "box_opacity": 0.5,
        "zh": {
            "font": "Microsoft YaHei",
            "size": 56,
            "color": "#FFFFFF",
            "outline_color": "#0F172A",
            "outline": 3.0,
            "shadow": 1.6,
            "bold": True,
            "italic": False,
        },
        "en": {
            "font": "Segoe UI",
            "size": 35,
            "color": "#FDBA74",
            "outline_color": "#0F172A",
            "outline": 2.4,
            "shadow": 1.4,
            "bold": True,
            "italic": False,
        },
    },
    {
        "id": "english_learner",
        "name": "英语学习主英辅中",
        "desc": "英文大字在上作为视觉重心，中文小字在下辅助理解，口语听力神器",
        "order": "en_top",
        "margin_v": 48,
        "line_gap": 4,
        "box_mode": False,
        "box_color": "#000000",
        "box_opacity": 0.5,
        "zh": {
            "font": "Microsoft YaHei",
            "size": 36,
            "color": "#CBD5E1",
            "outline_color": "#0F172A",
            "outline": 2.0,
            "shadow": 1.2,
            "bold": False,
            "italic": False,
        },
        "en": {
            "font": "Segoe UI",
            "size": 50,
            "color": "#FEF08A",
            "outline_color": "#0F172A",
            "outline": 2.8,
            "shadow": 1.8,
            "bold": True,
            "italic": False,
        },
    },
]


def read_text_auto_encoding(file_path: str | Path) -> str:
    """Read text file automatically detecting UTF-8/BOM/UTF-16/GB18030."""
    raw = Path(file_path).read_bytes()
    for enc in ("utf-8-sig", "utf-8", "utf-16", "gb18030", "big5", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def has_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text))


def is_chinese_clean(text: str) -> bool:
    """Strictly contains CJK ideographs."""
    return bool(CJK_RE.search(text))


def is_english_clean(text: str) -> bool:
    """Contains Latin letters [A-Za-z] and NO CJK ideographs (excludes pure symbols/numbers like '♪' or '1999')."""
    return bool(LATIN_RE.search(text)) and not bool(CJK_RE.search(text))


def cjk_ratio(text: str) -> float:
    clean = re.sub(r"\s+", "", text)
    if not clean:
        return 0.0
    cjk_count = len(CJK_RE.findall(clean))
    return cjk_count / len(clean)


def clean_subtitle_tags(text: str) -> str:
    """Strip ASS override blocks {...} and HTML tags <i>...</i>."""
    text = ASS_TAG_RE.sub("", text)
    text = HTML_TAG_RE.sub("", text)
    text = text.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")
    return text.strip()


def split_bilingual_lines(raw_text: str, lang_hint: str = "auto") -> tuple[str, str]:
    """
    Intelligently split a subtitle block into (zh, en).
    lang_hint can be 'auto', 'zh', 'en'.
    """
    # Check explicit ASS inline style reset (e.g. 中文\N{\rEng - ITC...}English) first
    if lang_hint == "auto":
        reset_match = re.split(r"\\[Nn]\s*\{\\r([^}\\]*)[^}]*\}", raw_text, maxsplit=1)
        if len(reset_match) == 3:
            first_part = clean_subtitle_tags(reset_match[0])
            reset_style_name = reset_match[1].strip().lower()
            second_part = clean_subtitle_tags(reset_match[2])
            if "eng" in reset_style_name or "en_" in reset_style_name or (has_cjk(first_part) and not has_cjk(second_part)):
                return first_part, second_part
            if "zh" in reset_style_name or "chs" in reset_style_name or (has_cjk(second_part) and not has_cjk(first_part)):
                return second_part, first_part

    cleaned = clean_subtitle_tags(raw_text)
    if not cleaned:
        return "", ""

    if lang_hint == "zh":
        return " ".join(line.strip() for line in cleaned.splitlines() if line.strip()), ""
    if lang_hint == "en":
        return "", " ".join(line.strip() for line in cleaned.splitlines() if line.strip())

    lines = [ln.strip() for ln in cleaned.splitlines() if ln.strip()]
    if len(lines) == 1:
        line = lines[0]
        if is_chinese_clean(line):
            return line, ""
        if is_english_clean(line):
            return "", line
        # Pure numbers/symbols (e.g. '1999', '...', '♪'): keep in primary zh slot rather than misclassifying as English
        return line, ""

    # Multi-line cue: separate lines with CJK vs strict English vs neutral symbols
    zh_lines: list[str] = []
    en_lines: list[str] = []
    neutral_lines: list[str] = []
    for ln in lines:
        if is_chinese_clean(ln):
            zh_lines.append(ln)
        elif is_english_clean(ln):
            en_lines.append(ln)
        else:
            neutral_lines.append(ln)

    if zh_lines and en_lines:
        if neutral_lines:
            zh_lines.extend(neutral_lines)
        return " ".join(zh_lines), " ".join(en_lines)

    # All lines same language: keep together
    joined = " ".join(lines)
    if is_english_clean(joined):
        return "", joined
    return joined, ""


def parse_srt_timestamp(ts: str) -> int:
    """Parse SRT/VTT timestamp like 00:01:23,456 or 01:23.456 to milliseconds."""
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
    elif len(parts) == 2:
        h, m, s = 0, int(parts[0]), float(parts[1])
    else:
        return 0
    return max(0, int(round((h * 3600 + m * 60 + s) * 1000)))


def parse_ass_timestamp(ts: str) -> int:
    """Parse ASS timestamp like 0:01:23.45 to milliseconds."""
    ts = ts.strip()
    parts = ts.split(":")
    if len(parts) != 3:
        return 0
    h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
    return max(0, int(round((h * 3600 + m * 60 + s) * 1000)))


def format_srt_timestamp(ms: int) -> str:
    ms = max(0, int(round(ms)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, millis = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{millis:03d}"


def format_ass_timestamp(ms: int) -> str:
    ms = max(0, int(round(ms)))
    # ASS uses centiseconds (1/100s)
    total_cs = int(round(ms / 10.0))
    h, rem = divmod(total_cs, 360_000)
    m, rem = divmod(rem, 6_000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def parse_srt_or_vtt(content: str, lang_hint: str = "auto") -> list[dict[str, Any]]:
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    # Remove WEBVTT header if present
    content = re.sub(r"^WEBVTT[^\n]*\n+", "", content, flags=re.IGNORECASE)

    blocks = re.split(r"\n\s*\n", content.strip())
    items: list[dict[str, Any]] = []
    time_re = re.compile(
        r"(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})"
    )

    for block in blocks:
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        time_line_idx = -1
        match = None
        for i, ln in enumerate(lines[:3]):
            m = time_re.search(ln)
            if m:
                time_line_idx = i
                match = m
                break
        if match is None:
            continue

        start_ms = parse_srt_timestamp(match.group(1))
        end_ms = parse_srt_timestamp(match.group(2))
        if end_ms <= start_ms:
            end_ms = start_ms + 1500

        text_body = "\n".join(lines[time_line_idx + 1 :])
        zh, en = split_bilingual_lines(text_body, lang_hint=lang_hint)
        items.append(
            {
                "id": len(items) + 1,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "zh": zh,
                "en": en,
            }
        )

    # Automatically merge pseudo-bilingual SRTs where CN and EN are separate blocks at matching timestamps (<=150ms)
    if lang_hint == "auto" and len(items) >= 2:
        auto_res = merge_internal_bilingual_lines(
            items, tolerance_ms=150, time_base="union", match_mode="tolerance", preview_only=False
        )
        if auto_res["matched_count"] > 0:
            return auto_res["subtitles"]
    return items


def parse_ass(content: str, lang_hint: str = "auto") -> list[dict[str, Any]]:
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    section = ""
    style_fields: list[str] = []
    top_style_names: set[str] = set()
    format_fields: list[str] = []
    raw_events: list[dict[str, Any]] = []

    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith(";"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped.lower()
            continue

        # Detect top-aligned styles (Alignment in 7, 8, 9 or named 注释/top/sign)
        if section in ("[v4+ styles]", "[v4 styles]"):
            if stripped.lower().startswith("format:"):
                style_fields = [f.strip().lower() for f in stripped.split(":", 1)[1].split(",")]
            elif stripped.lower().startswith("style:") and style_fields:
                sparts = [p.strip() for p in stripped.split(":", 1)[1].split(",")]
                srow = dict(zip(style_fields, sparts))
                sname = srow.get("name", "")
                align_val = srow.get("alignment", "2")
                if align_val in ("7", "8", "9") or any(
                    kw in sname.lower() for kw in ("注释", "top", "sign")
                ):
                    top_style_names.add(sname)
            continue

        if section != "[events]":
            continue

        if stripped.lower().startswith("format:"):
            fields_str = stripped.split(":", 1)[1]
            format_fields = [f.strip().lower() for f in fields_str.split(",")]
        elif stripped.lower().startswith("dialogue:"):
            if not format_fields:
                format_fields = [
                    "layer",
                    "start",
                    "end",
                    "style",
                    "name",
                    "marginl",
                    "marginr",
                    "marginv",
                    "effect",
                    "text",
                ]
            payload = stripped.split(":", 1)[1].lstrip()
            parts = payload.split(",", len(format_fields) - 1)
            if len(parts) < len(format_fields):
                continue
            row = dict(zip(format_fields, parts))
            start_ms = parse_ass_timestamp(row.get("start", "0:00:00.00"))
            end_ms = parse_ass_timestamp(row.get("end", "0:00:02.00"))
            style_used = (row.get("style") or "").strip()
            text = row.get("text", "")
            is_top = (
                style_used in top_style_names
                or bool(re.search(r"\\an[789]\b", text))
            )
            zh, en = split_bilingual_lines(text, lang_hint=lang_hint)
            if not zh and not en:
                continue
            ev_obj: dict[str, Any] = {
                "id": len(raw_events) + 1,
                "start_ms": start_ms,
                "end_ms": max(end_ms, start_ms + 500),
                "zh": zh,
                "en": en,
            }
            if is_top:
                ev_obj["pos"] = "top"
            raw_events.append(ev_obj)

    raw_events.sort(key=lambda x: (x["start_ms"], x["end_ms"]))
    reindex_subtitles(raw_events)
    if lang_hint == "auto" and len(raw_events) >= 2:
        auto_res = merge_internal_bilingual_lines(
            raw_events, tolerance_ms=150, time_base="union", match_mode="tolerance", preview_only=False
        )
        if auto_res["matched_count"] > 0:
            return auto_res["subtitles"]
    return raw_events


def parse_plain_text(
    content: str, mode: str = "auto_pair", default_duration_ms: int = 2800
) -> list[dict[str, Any]]:
    """
    Parse plain text lines into subtitle cues.
    mode:
      - 'auto_pair': automatically pairs alternating ZH/EN lines if detected, otherwise 1 line = 1 cue
      - 'zh_only': every line is Chinese
      - 'en_only': every line is English
      - 'alternating': strict odd/even pairing
    """
    lines = [ln.strip() for ln in content.replace("\r\n", "\n").split("\n") if ln.strip()]
    items: list[dict[str, Any]] = []
    cursor_ms = 0

    if mode == "zh_only":
        for ln in lines:
            items.append(
                {
                    "id": len(items) + 1,
                    "start_ms": cursor_ms,
                    "end_ms": cursor_ms + default_duration_ms,
                    "zh": ln,
                    "en": "",
                }
            )
            cursor_ms += default_duration_ms + 200
        return items

    if mode == "en_only":
        for ln in lines:
            items.append(
                {
                    "id": len(items) + 1,
                    "start_ms": cursor_ms,
                    "end_ms": cursor_ms + default_duration_ms,
                    "zh": "",
                    "en": ln,
                }
            )
            cursor_ms += default_duration_ms + 200
        return items

    # Auto pair adjacent ZH + EN lines
    i = 0
    while i < len(lines):
        cur = lines[i]
        cur_cjk = has_cjk(cur)
        if i + 1 < len(lines):
            nxt = lines[i + 1]
            nxt_cjk = has_cjk(nxt)
            if mode == "alternating" or (cur_cjk != nxt_cjk):
                zh = cur if cur_cjk else nxt
                en = nxt if cur_cjk else cur
                if mode == "alternating" and cur_cjk == nxt_cjk:
                    zh, en = cur, nxt
                items.append(
                    {
                        "id": len(items) + 1,
                        "start_ms": cursor_ms,
                        "end_ms": cursor_ms + default_duration_ms,
                        "zh": zh,
                        "en": en,
                    }
                )
                cursor_ms += default_duration_ms + 200
                i += 2
                continue

        zh, en = (cur, "") if cur_cjk else ("", cur)
        items.append(
            {
                "id": len(items) + 1,
                "start_ms": cursor_ms,
                "end_ms": cursor_ms + default_duration_ms,
                "zh": zh,
                "en": en,
            }
        )
        cursor_ms += default_duration_ms + 200
        i += 1

    return items


def load_subtitle_file(file_path: str | Path, lang_hint: str = "auto") -> list[dict[str, Any]]:
    path = Path(file_path)
    ext = path.suffix.lower()
    content = read_text_auto_encoding(path)

    if ext in (".ebsub", ".json"):
        data = json.loads(content)
        if isinstance(data, dict) and "subtitles" in data:
            return data["subtitles"]
        if isinstance(data, list):
            return data
    if ext in (".ass", ".ssa"):
        return parse_ass(content, lang_hint=lang_hint)
    if ext in (".srt", ".vtt"):
        return parse_srt_or_vtt(content, lang_hint=lang_hint)
    # Fallback: check if content looks like SRT anyway
    if "-->" in content:
        return parse_srt_or_vtt(content, lang_hint=lang_hint)
    mode = "zh_only" if lang_hint == "zh" else ("en_only" if lang_hint == "en" else "auto_pair")
    return parse_plain_text(content, mode=mode)


def _resolve_merged_times(
    cn_start: int,
    cn_end: int,
    en_start: int,
    en_end: int,
    time_base: str,
    pri_start: int,
    pri_end: int,
) -> tuple[int, int]:
    """
    Compute merged (start_ms, end_ms) based on user-selected time_base:
      - 'union': min(start), max(end) (covers longest span, prevents clipping)
      - 'zh': Chinese line timing
      - 'en': English line timing
      - 'primary': Primary subtitle timing
    """
    if time_base == "zh":
        return cn_start, max(cn_end, cn_start + 200)
    if time_base == "en":
        return en_start, max(en_end, en_start + 200)
    if time_base == "primary":
        return pri_start, max(pri_end, pri_start + 200)
    # Default: 'union'
    s = min(cn_start, en_start)
    e = max(cn_end, en_end, s + 200)
    return s, e


def merge_internal_bilingual_lines(
    subtitles: list[dict[str, Any]],
    tolerance_ms: int = 200,
    time_base: str = "union",
    match_mode: str = "tolerance",
    preview_only: bool = False,
) -> dict[str, Any]:
    """
    Smartly merge separate single-language Chinese & English rows within a single subtitle list!
    Inspired by Aegisub v4.1 macro, enhanced so rows DO NOT even need to be strictly alternating
    (works both for [CN, EN, CN, EN...] and [all CN..., all EN...]).

    match_mode:
      - 'tolerance': abs(start1 - start2) <= tolerance_ms and abs(end1 - end2) <= tolerance_ms
      - 'overlap': time overlap > 0 or midpoint distance <= tolerance_ms
    """
    tol = max(0, int(tolerance_ms))
    cn_candidates: list[int] = []
    en_candidates: list[int] = []

    for i, item in enumerate(subtitles):
        # Do not merge top-screen annotations into bottom dialogue lines!
        if item.get("pos") == "top":
            continue
        zh = (item.get("zh") or "").strip()
        en = (item.get("en") or "").strip()
        if zh and not en and is_chinese_clean(zh):
            cn_candidates.append(i)
        elif en and not zh and is_english_clean(en):
            en_candidates.append(i)

    used_en: set[int] = set()
    pairs: list[tuple[int, int]] = []
    report_lines: list[str] = [
        f"扫描完成：检测到单语中文行 {len(cn_candidates)} 条，单语英文行 {len(en_candidates)} 条（允许误差: ±{tol}ms）"
    ]

    for cn_idx in cn_candidates:
        cn_row = subtitles[cn_idx]
        c_s, c_e = int(cn_row["start_ms"]), int(cn_row["end_ms"])
        best_en = -1
        best_score = -1e12

        for en_idx in en_candidates:
            if en_idx in used_en:
                continue
            en_row = subtitles[en_idx]
            e_s, e_e = int(en_row["start_ms"]), int(en_row["end_ms"])
            start_diff = abs(c_s - e_s)
            end_diff = abs(c_e - e_e)

            if match_mode == "tolerance":
                if start_diff <= tol and end_diff <= tol:
                    # Prefer closest timestamp, with slight tie-breaker for adjacent row index
                    score = -(start_diff + end_diff) - abs(cn_idx - en_idx) * 0.5
                    if score > best_score:
                        best_score = score
                        best_en = en_idx
            else:
                overlap = min(c_e, e_e) - max(c_s, e_s)
                if overlap > 0:
                    score = overlap * 2.0 - (start_diff + end_diff) * 0.25
                    if score > best_score:
                        best_score = score
                        best_en = en_idx
                elif start_diff <= tol and end_diff <= tol:
                    score = -(start_diff + end_diff)
                    if score > best_score:
                        best_score = score
                        best_en = en_idx

        if best_en >= 0:
            used_en.add(best_en)
            pairs.append((cn_idx, best_en))

    paired_cn = {p[0] for p in pairs}
    unmatched_cn = [i for i in cn_candidates if i not in paired_cn]
    unmatched_en = [i for i in en_candidates if i not in used_en]

    for k, (ci, ei) in enumerate(pairs[:80], start=1):
        cr = subtitles[ci]
        er = subtitles[ei]
        ns, ne = _resolve_merged_times(
            cr["start_ms"], cr["end_ms"], er["start_ms"], er["end_ms"],
            time_base, cr["start_ms"], cr["end_ms"]
        )
        zh_short = (cr.get("zh") or "")[:18]
        en_short = (er.get("en") or "")[:22]
        report_lines.append(
            f"✓ 配对 #{k}: 行{ci + 1}[中] + 行{ei + 1}[英] ➔ {format_ass_timestamp(ns)}~{format_ass_timestamp(ne)} | {zh_short} / {en_short}"
        )
    if len(pairs) > 80:
        report_lines.append(f"…（其余 {len(pairs) - 80} 组成功配对已省略展示）")

    for ui in (unmatched_cn + unmatched_en)[:25]:
        ur = subtitles[ui]
        tag = "中" if ui in unmatched_cn else "英"
        txt = ((ur.get("zh") or ur.get("en")) or "")[:22]
        report_lines.append(
            f"⚠ 未配对: 行{ui + 1}[{tag}] ({format_ass_timestamp(ur['start_ms'])}) 时间误差超出阈值 | {txt}"
        )

    time_base_label = {
        "union": "取两者并集 (覆盖最长)",
        "zh": "以中文行时间为准",
        "en": "以英文行时间为准",
    }.get(time_base, time_base)
    report_lines.append(
        f"\n汇总：成功配对 {len(pairs)} 组 | 未配对单语行 {len(unmatched_cn) + len(unmatched_en)} 条 | 时间基准：{time_base_label}"
    )

    if preview_only or not pairs:
        return {
            "ok": True,
            "matched_count": len(pairs),
            "unmatched_count": len(unmatched_cn) + len(unmatched_en),
            "report": "\n".join(report_lines),
            "subtitles": subtitles,
        }

    # Build merged output list preserving chronological order
    cn_to_en = dict(pairs)
    deleted_indices = set()
    new_list: list[dict[str, Any]] = []

    for idx, item in enumerate(subtitles):
        if idx in deleted_indices:
            continue
        if idx in cn_to_en:
            en_idx = cn_to_en[idx]
            en_item = subtitles[en_idx]
            deleted_indices.add(en_idx)
            ns, ne = _resolve_merged_times(
                item["start_ms"], item["end_ms"],
                en_item["start_ms"], en_item["end_ms"],
                time_base, item["start_ms"], item["end_ms"],
            )
            merged_row = dict(item)
            merged_row["start_ms"] = ns
            merged_row["end_ms"] = ne
            merged_row["zh"] = (item.get("zh") or "").strip()
            merged_row["en"] = (en_item.get("en") or "").strip()
            new_list.append(merged_row)
        else:
            # What if the English row appeared BEFORE its paired Chinese row?
            # Since we iterate 0..N-1, check if idx is an en_idx paired with a LATER cn_idx!
            paired_later_cn = next((ci for ci, ei in pairs if ei == idx and ci > idx), None)
            if paired_later_cn is not None:
                cn_item = subtitles[paired_later_cn]
                deleted_indices.add(paired_later_cn)
                ns, ne = _resolve_merged_times(
                    cn_item["start_ms"], cn_item["end_ms"],
                    item["start_ms"], item["end_ms"],
                    time_base, item["start_ms"], item["end_ms"],
                )
                merged_row = dict(item)
                merged_row["start_ms"] = ns
                merged_row["end_ms"] = ne
                merged_row["zh"] = (cn_item.get("zh") or "").strip()
                merged_row["en"] = (item.get("en") or "").strip()
                new_list.append(merged_row)
            else:
                new_list.append(dict(item))

    new_list.sort(key=lambda x: (x["start_ms"], x["end_ms"]))
    reindex_subtitles(new_list)

    return {
        "ok": True,
        "matched_count": len(pairs),
        "unmatched_count": len(unmatched_cn) + len(unmatched_en),
        "report": "\n".join(report_lines),
        "subtitles": new_list,
    }


def merge_two_subtitles(
    primary_subs: list[dict[str, Any]],
    secondary_subs: list[dict[str, Any]],
    secondary_lang: str = "auto",
    align_mode: str = "time",
    time_base: str = "union",
    tolerance_ms: int = 1200,
    return_stats: bool = False,
) -> Any:
    """
    Merge two subtitle lists into one clean bilingual subtitle list!
    - align_mode:
        'time' -> Smart overlap & midpoint alignment
        'strict_time' -> Strict start & end tolerance matching (abs(diff) <= tolerance_ms)
        'index' -> Line-by-line 1-to-1 pairing
    - time_base:
        'union' -> min(start), max(end)
        'zh' -> Chinese line timing
        'en' -> English line timing
        'primary' -> Keep primary subtitle timing
    """
    motion_rows = [dict(item) for item in (*primary_subs, *secondary_subs) if item.get("motion")]
    result = [dict(item) for item in primary_subs if not item.get("motion")]
    secondary_subs = [item for item in secondary_subs if not item.get("motion")]
    tol = max(0, int(tolerance_ms))
    matched_count = 0

    def extract_sec_text(sec_item: dict[str, Any]) -> tuple[str, str]:
        """Return ('zh'|'en', text) from secondary item."""
        if secondary_lang == "zh":
            txt = sec_item.get("zh") or sec_item.get("en") or ""
            return "zh", txt
        if secondary_lang == "en":
            txt = sec_item.get("en") or sec_item.get("zh") or ""
            return "en", txt
        if sec_item.get("zh") and not sec_item.get("en"):
            return "zh", sec_item["zh"]
        if sec_item.get("en") and not sec_item.get("zh"):
            return "en", sec_item["en"]
        combined = f"{sec_item.get('zh', '')} {sec_item.get('en', '')}".strip()
        if is_english_clean(combined):
            return "en", combined
        return "zh", combined

    if align_mode == "index":
        for idx, sec in enumerate(secondary_subs):
            lang_key, txt = extract_sec_text(sec)
            if not txt:
                continue
            if idx < len(result):
                matched_count += 1
                if result[idx].get(lang_key):
                    result[idx][lang_key] = f"{result[idx][lang_key]} {txt}".strip()
                else:
                    result[idx][lang_key] = txt
            else:
                new_item = {
                    "id": len(result) + 1,
                    "start_ms": sec.get("start_ms", 0),
                    "end_ms": sec.get("end_ms", 2500),
                    "zh": txt if lang_key == "zh" else "",
                    "en": txt if lang_key == "en" else "",
                }
                result.append(new_item)
        if motion_rows:
            result.extend(motion_rows)
            result.sort(key=lambda item: (item["start_ms"], item["end_ms"]))
        final_list = reindex_subtitles(result)
        if return_stats:
            return final_list, {"matched_count": matched_count, "unmatched_secondary": max(0, len(secondary_subs) - matched_count)}
        return final_list

    # Time-based alignment ('time' or 'strict_time')
    unmatched_secondary: list[dict[str, Any]] = []
    for sec in secondary_subs:
        lang_key, txt = extract_sec_text(sec)
        if not txt:
            continue
        s_start = int(sec["start_ms"])
        s_end = int(sec["end_ms"])
        s_mid = (s_start + s_end) / 2.0

        best_idx = -1
        best_score = -1e12

        for idx, pri in enumerate(result):
            p_start = int(pri["start_ms"])
            p_end = int(pri["end_ms"])
            start_diff = abs(p_start - s_start)
            end_diff = abs(p_end - s_end)

            if align_mode == "strict_time":
                if start_diff <= tol and end_diff <= tol:
                    score = -(start_diff + end_diff)
                    if score > best_score:
                        best_score = score
                        best_idx = idx
            else:
                overlap = min(p_end, s_end) - max(p_start, s_start)
                if overlap > 0:
                    score = overlap * 2.0 - start_diff * 0.2
                    if score > best_score:
                        best_score = score
                        best_idx = idx
                else:
                    p_mid = (p_start + p_end) / 2.0
                    dist = abs(p_mid - s_mid)
                    if dist <= tol:
                        score = -dist
                        if score > best_score:
                            best_score = score
                            best_idx = idx

        if best_idx >= 0:
            matched_count += 1
            pri_row = result[best_idx]
            existing = pri_row.get(lang_key, "").strip()
            pri_row[lang_key] = f"{existing} {txt}".strip() if existing else txt

            # Apply time_base rule!
            p_start, p_end = int(pri_row["start_ms"]), int(pri_row["end_ms"])
            if lang_key == "zh":
                cn_s, cn_e, en_s, en_e = s_start, s_end, p_start, p_end
            else:
                cn_s, cn_e, en_s, en_e = p_start, p_end, s_start, s_end
            ns, ne = _resolve_merged_times(cn_s, cn_e, en_s, en_e, time_base, p_start, p_end)
            pri_row["start_ms"] = ns
            pri_row["end_ms"] = ne
        else:
            unmatched_secondary.append(
                {
                    "id": 0,
                    "start_ms": s_start,
                    "end_ms": s_end,
                    "zh": txt if lang_key == "zh" else "",
                    "en": txt if lang_key == "en" else "",
                }
            )

    result.extend(unmatched_secondary)
    result.extend(motion_rows)
    result.sort(key=lambda x: (x["start_ms"], x["end_ms"]))
    # When align_mode == 'time', automatically absorb 1-to-N split-sentence orphans whose timestamps overlap!
    if align_mode == "time":
        result, _ = fix_split_orphan_lines(result, mode="merge")
    final_list = reindex_subtitles(result)
    if return_stats:
        return final_list, {
            "matched_count": matched_count,
            "unmatched_secondary": len(unmatched_secondary),
        }
    return final_list


_SDH_FULL_LINE_RE = re.compile(
    r"^[\s♪♫♬\-\–\—]*(?:[\(\[（【][^)\]）】]*[\)\]）】][\s♪♫♬\-\–\—]*)+$"
)
_SDH_INLINE_TAG_RE = re.compile(r"[\(\[][^)\]]{1,70}[\)\]]")
_FOREIGN_LANG_PREFIX_RE = re.compile(r"^[（\(【\[].{1,8}语[）\)】\]]")


def is_pure_sdh_noise(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if re.fullmatch(r"[\s♪♫♬\-\–\—]+", t):
        return True
    return bool(_SDH_FULL_LINE_RE.match(t))


def is_foreign_lang_annotated(zh_text: str) -> bool:
    return bool(_FOREIGN_LANG_PREFIX_RE.search((zh_text or "").strip()))


def _find_best_orphan_neighbor(
    subs: list[dict[str, Any]], idx: int
) -> tuple[int, int]:
    """
    If subs[idx] is a non-top single-language row whose timestamp overlaps (or touches <= 60ms)
    an adjacent row (idx-1 or idx+1) that possesses the OTHER language, return (neighbor_idx, overlap_ms).
    Otherwise return (-1, -999999).
    """
    cur = subs[idx]
    if cur.get("pos") == "top":
        return -1, -999999
    zh = (cur.get("zh") or "").strip()
    en = (cur.get("en") or "").strip()
    if not (bool(zh) ^ bool(en)):
        return -1, -999999
    if en and is_pure_sdh_noise(en):
        return -1, -999999

    c_s, c_e = int(cur["start_ms"]), int(cur["end_ms"])
    best_nb = -1
    best_ov = -999999
    for nb in (idx - 1, idx + 1):
        if nb < 0 or nb >= len(subs):
            continue
        other = subs[nb]
        if other.get("pos") == "top":
            continue
        o_zh = (other.get("zh") or "").strip()
        o_en = (other.get("en") or "").strip()
        # Neighbor must have the language that cur is missing, AND also have cur's language
        # (classic 1-to-2 split where neighbor got paired and cur was left orphaned!)
        if zh and not (o_en and o_zh and not is_pure_sdh_noise(o_en)):
            continue
        if en and not (o_zh and o_en):
            continue

        ov = min(c_e, int(other["end_ms"])) - max(c_s, int(other["start_ms"]))
        # Overlap > -60ms means overlapping in time or virtually contiguous (<=60ms gap)
        if ov >= 0 and ov > best_ov:
            best_ov = ov
            best_nb = nb
    return best_nb, best_ov


def diagnose_bilingual_issues(subtitles: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Scan subtitle list and return exact counts of auto-fixable bilingual issues:
      - split_orphan_count: 1-to-2 split-sentence orphans (like #19 '因为我知道' + #20 '...for, I know...')
      - pure_sdh_row_count: pure SDH sound-effect rows like '(grunts)', '(breathes deeply)', '♪'
      - inline_sdh_count: dialogue rows containing inline SDH tags like '(Paul) Sister...' or '... (chuckles)'
      - foreign_note_count: foreign-language annotated ZH-only rows like '(哈克南语)...'
      - missing_trans_count: genuine untranslated single-language dialogue rows
      - time_overlap_count: adjacent bottom dialogue rows with overlapping timestamps
    """
    split_orphan_count = 0
    pure_sdh_row_count = 0
    inline_sdh_count = 0
    foreign_note_count = 0
    missing_trans_count = 0
    time_overlap_count = 0

    prev_bot_end = -1
    for i, s in enumerate(subtitles):
        zh = (s.get("zh") or "").strip()
        en = (s.get("en") or "").strip()
        is_top = s.get("pos") == "top"

        if not is_top:
            st = int(s.get("start_ms", 0))
            ed = int(s.get("end_ms", 0))
            if prev_bot_end > st + 10:
                time_overlap_count += 1
            prev_bot_end = max(prev_bot_end, ed)

        if en and not zh and is_pure_sdh_noise(en):
            pure_sdh_row_count += 1
            continue

        if en and (_SDH_INLINE_TAG_RE.search(en) or "♪" in en):
            inline_sdh_count += 1

        nb, _ = _find_best_orphan_neighbor(subtitles, i)
        if nb >= 0:
            split_orphan_count += 1
            continue

        if bool(zh) ^ bool(en):
            if zh and is_foreign_lang_annotated(zh):
                foreign_note_count += 1
            else:
                missing_trans_count += 1

    return {
        "ok": True,
        "total": len(subtitles),
        "split_orphan_count": split_orphan_count,
        "pure_sdh_row_count": pure_sdh_row_count,
        "inline_sdh_count": inline_sdh_count,
        "foreign_note_count": foreign_note_count,
        "missing_trans_count": missing_trans_count,
        "time_overlap_count": time_overlap_count,
    }


def clean_sdh_and_hearing_tags(
    subtitles: list[dict[str, Any]],
    remove_empty_rows: bool = True,
    clean_inline: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """
    Strip English SDH hearing-impaired sound effects / speaker tags like '(grunts)', '[sighs]', '♪',
    and optionally remove rows that become completely empty afterwards.
    """
    cleaned_list: list[dict[str, Any]] = []
    removed_rows = 0
    cleaned_inline = 0

    for item in subtitles:
        row = dict(item)
        zh = (row.get("zh") or "").strip()
        en = (row.get("en") or "").strip()

        if en:
            if is_pure_sdh_noise(en):
                en = ""
            elif clean_inline:
                new_en = _SDH_INLINE_TAG_RE.sub(" ", en)
                new_en = re.sub(r"[♪♫♬]+", " ", new_en)
                new_en = re.sub(r"\s+", " ", new_en).strip()
                # Clean orphan speaker hyphen if one half was an SDH tag like '- (gasps) - Run!' -> 'Run!'
                if new_en.startswith("-") and " - " not in new_en[1:]:
                    new_en = re.sub(r"^-\s*", "", new_en).strip()
                if is_pure_sdh_noise(new_en):
                    new_en = ""
                if new_en != en:
                    cleaned_inline += 1
                    en = new_en

        row["zh"] = zh
        row["en"] = en
        if not zh and not en and remove_empty_rows:
            removed_rows += 1
            continue
        cleaned_list.append(row)

    return reindex_subtitles(cleaned_list), {
        "removed_rows": removed_rows,
        "cleaned_inline": cleaned_inline,
    }


def _smart_split_long_sentence_by_hint(
    long_text: str,
    hint_first: str,
    ratio_first: float,
    is_english_long: bool = True,
) -> tuple[str, str]:
    """
    Split `long_text` into (part1, part2) guided by semantic token overlap with `hint_first`
    (e.g. neural translation of the first short fragment) + clause punctuation + length ratio!
    """
    txt = long_text.strip()
    if not txt:
        return "", ""

    # Priority 0: explicit dual-speaker dialogue '- Speaker A - Speaker B'
    dash_m = list(re.finditer(r"\s+-\s+", txt))
    if len(dash_m) == 1:
        idx = dash_m[0].start()
        p1, p2 = txt[:idx].strip(), txt[idx:].strip()
        if p1 and p2:
            return p1, p2

    ratio_first = max(0.12, min(0.88, ratio_first))
    if not is_english_long:
        # CJK splitting guided by punctuation + ratio
        n = len(txt)
        target = n * ratio_first
        best_cut = max(1, min(n - 1, int(round(target))))
        best_score = -1e9
        for m in re.finditer(r"([，,。？！?!；;、\s]+)", txt):
            cut = m.end()
            if 1 <= cut <= n - 1:
                sc = 4.0 - abs(cut - target) / max(1.0, n) * 12.0
                if sc > best_score:
                    best_score = sc
                    best_cut = cut
        return txt[:best_cut].strip(), txt[best_cut:].strip()

    # English word-boundary splitting with semantic token matching against hint_first!
    words = txt.split()
    if len(words) < 2:
        return txt, ""

    stop_words = {"the", "a", "an", "to", "of", "in", "on", "at", "is", "are", "was", "were"}
    hint_tokens = {
        w
        for w in re.findall(r"[a-z0-9']+", (hint_first or "").lower())
        if len(w) >= 2 or w in {"i"}
    }

    total_chars = len(txt)
    best_k = max(1, min(len(words) - 1, int(round(len(words) * ratio_first))))
    best_score = -1e9

    for k in range(1, len(words)):
        left_str = " ".join(words[:k])
        right_str = " ".join(words[k:])
        char_ratio = len(left_str) / max(1, total_chars)

        # 1) Distance from expected length ratio
        score = -abs(char_ratio - ratio_first) * 9.0

        # 2) Semantic overlap with hint_first (words in hint_first should land in left_str, NOT right_str!)
        if hint_tokens:
            left_toks = set(re.findall(r"[a-z0-9']+", left_str.lower()))
            right_toks = set(re.findall(r"[a-z0-9']+", right_str.lower()))
            for ht in hint_tokens:
                weight = 1.2 if ht in stop_words else 3.2
                if ht in left_toks:
                    score += weight
                if ht in right_toks:
                    score -= weight * 0.7
            extra_left = left_toks - hint_tokens - stop_words - {"for", "so", "but", "and", "or", "yet", "nor"}
            score -= len(extra_left) * 1.1

        # 3) Natural clause boundary bonus right at words[k-1]
        prev_w = words[k - 1]
        if prev_w.endswith((",", ";", ":", "—", "--", "?", "!", ".")):
            # Avoid splitting right after an introductory 'for,' if hint has more words after it
            if k == 1 and prev_w.lower() in {"for,", "so,", "but,", "and,", "well,", "oh,", "no,", "yes,"} and len(hint_tokens) >= 2:
                score -= 1.0
            else:
                score += 2.6

        if score > best_score:
            best_score = score
            best_k = k

    return " ".join(words[:best_k]).strip(), " ".join(words[best_k:]).strip()


def fix_split_orphan_lines(
    subtitles: list[dict[str, Any]],
    mode: str = "merge",
    translator_fn: Any = None,
) -> tuple[list[dict[str, Any]], int]:
    """
    Automatically fix 1-to-2 split-sentence orphans (like #19 '因为我知道' + #20 '...for, I know...').
      - mode='merge': Merge the short orphan fragment into its overlapping bilingual neighbor as 1 clean cue.
      - mode='ai_split': Keep 2 short cues and semantically split the neighbor's long text across both cues!
    """
    work = [dict(x) for x in subtitles]
    fixed_count = 0

    if mode == "merge":
        # Iterative pass so even 3-part splits merge cleanly
        for _ in range(2):
            i = 0
            next_work: list[dict[str, Any]] = []
            merged_in_pass = 0
            used_skip: set[int] = set()
            while i < len(work):
                if i in used_skip:
                    i += 1
                    continue
                nb, _ = _find_best_orphan_neighbor(work, i)
                if nb == i + 1 and (i + 1) not in used_skip:
                    # Orphan i precedes bilingual row i+1
                    cur = work[i]
                    nxt = dict(work[i + 1])
                    nxt["start_ms"] = min(int(cur["start_ms"]), int(nxt["start_ms"]))
                    nxt["end_ms"] = max(int(cur["end_ms"]), int(nxt["end_ms"]))
                    if (cur.get("zh") or "").strip():
                        nxt["zh"] = f"{cur['zh'].strip()} {nxt.get('zh', '').strip()}".strip()
                    if (cur.get("en") or "").strip():
                        nxt["en"] = f"{cur['en'].strip()} {nxt.get('en', '').strip()}".strip()
                    next_work.append(nxt)
                    used_skip.add(i + 1)
                    fixed_count += 1
                    merged_in_pass += 1
                elif nb == i - 1 and next_work:
                    # Orphan i follows bilingual row in next_work[-1]
                    cur = work[i]
                    prev = next_work[-1]
                    prev["start_ms"] = min(int(prev["start_ms"]), int(cur["start_ms"]))
                    prev["end_ms"] = max(int(prev["end_ms"]), int(cur["end_ms"]))
                    if (cur.get("zh") or "").strip():
                        prev["zh"] = f"{prev.get('zh', '').strip()} {cur['zh'].strip()}".strip()
                    if (cur.get("en") or "").strip():
                        prev["en"] = f"{prev.get('en', '').strip()} {cur['en'].strip()}".strip()
                    fixed_count += 1
                    merged_in_pass += 1
                else:
                    next_work.append(work[i])
                i += 1
            work = next_work
            if merged_in_pass == 0:
                break
        return reindex_subtitles(work), fixed_count

    # mode == 'ai_split': Keep both short cues and split the neighbor's long sentence!
    pairs: list[tuple[int, int]] = []  # (first_idx, second_idx)
    claimed: set[int] = set()
    for i in range(len(work)):
        if i in claimed:
            continue
        nb, _ = _find_best_orphan_neighbor(work, i)
        if nb >= 0 and nb not in claimed:
            first_i, second_i = (i, nb) if i < nb else (nb, i)
            pairs.append((first_i, second_i))
            claimed.add(first_i)
            claimed.add(second_i)

    if not pairs:
        return reindex_subtitles(work), 0

    # Collect first-part hints for translation if translator_fn is provided
    zh_hints_needed: list[tuple[int, str]] = []
    en_hints_needed: list[tuple[int, str]] = []
    for p_idx, (fi, si) in enumerate(pairs):
        r1, r2 = work[fi], work[si]
        # Determine which language is missing on one of (r1, r2)
        missing_en = not (r1.get("en") or "").strip() or not (r2.get("en") or "").strip()
        if missing_en:
            zh_hints_needed.append((p_idx, (r1.get("zh") or "").strip()))
        else:
            en_hints_needed.append((p_idx, (r1.get("en") or "").strip()))

    hint_map: dict[int, str] = {}
    if translator_fn is not None:
        try:
            if zh_hints_needed:
                txts = [t for _, t in zh_hints_needed]
                trans_list = translator_fn(txts, "zh_to_en")
                for (p_idx, _), tr in zip(zh_hints_needed, trans_list):
                    hint_map[p_idx] = tr
            if en_hints_needed:
                txts = [t for _, t in en_hints_needed]
                trans_list = translator_fn(txts, "en_to_zh")
                for (p_idx, _), tr in zip(en_hints_needed, trans_list):
                    hint_map[p_idx] = tr
        except Exception:
            pass

    for p_idx, (fi, si) in enumerate(pairs):
        r1, r2 = work[fi], work[si]
        missing_en = not (r1.get("en") or "").strip() or not (r2.get("en") or "").strip()
        hint_first = hint_map.get(p_idx, "")

        if missing_en:
            long_en = (r1.get("en") or r2.get("en") or "").strip()
            len1 = max(1, len((r1.get("zh") or "").strip()))
            len2 = max(1, len((r2.get("zh") or "").strip()))
            part1, part2 = _smart_split_long_sentence_by_hint(
                long_en, hint_first, len1 / (len1 + len2), is_english_long=True
            )
            if part1 and part2:
                r1["en"] = part1
                r2["en"] = part2
                fixed_count += 1
        else:
            long_zh = (r1.get("zh") or r2.get("zh") or "").strip()
            len1 = max(1, len((r1.get("en") or "").strip()))
            len2 = max(1, len((r2.get("en") or "").strip()))
            part1, part2 = _smart_split_long_sentence_by_hint(
                long_zh, hint_first, len1 / (len1 + len2), is_english_long=False
            )
            if part1 and part2:
                r1["zh"] = part1
                r2["zh"] = part2
                fixed_count += 1

        # Also clean up overlapping boundary timestamp between r1 and r2!
        s1, e1 = int(r1["start_ms"]), int(r1["end_ms"])
        s2, e2 = int(r2["start_ms"]), int(r2["end_ms"])
        if e1 > s2:
            # Split cleanly right at orphan's end (if r1 was the short orphan) or orphan's start!
            if e1 < e2 - 250 and e1 > s1 + 250:
                r2["start_ms"] = e1 + 20
            elif s2 > s1 + 250 and s2 < e2 - 250:
                r1["end_ms"] = s2 - 20
            else:
                mid = (max(s1, s2) + min(e1, e2)) // 2
                r1["end_ms"] = max(s1 + 250, mid - 10)
                r2["start_ms"] = min(e2 - 250, mid + 10)

    return reindex_subtitles(work), fixed_count


def fix_overlapping_timestamps(subtitles: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Ensure chronological non-top subtitle rows do not overlap in time."""
    out = [dict(x) for x in subtitles]
    fixed = 0
    prev_idx = -1
    for i, row in enumerate(out):
        if row.get("pos") == "top":
            continue
        if prev_idx >= 0:
            prev = out[prev_idx]
            if int(prev["end_ms"]) > int(row["start_ms"]):
                new_prev_end = max(int(prev["start_ms"]) + 250, int(row["start_ms"]) - 20)
                if new_prev_end < int(row["end_ms"]):
                    prev["end_ms"] = new_prev_end
                    fixed += 1
        prev_idx = i
    return out, fixed


def format_us_drama_punctuation(subtitles: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Clean and normalize subtitle punctuation in classic US-drama subtitle-group style:
      - Chinese internal commas/enumeration commas/semicolons -> single space
      - Strip trailing periods/commas/semicolons on Chinese lines (keep ? ! ... quotes)
      - Normalize full-width ？ ！ -> ? !
      - Normalize dual-speaker hyphens (- A - B) and collapse duplicate spaces
    """
    updated: list[dict[str, Any]] = []
    changed_count = 0

    for item in subtitles:
        row = dict(item)
        orig_zh = row.get("zh") or ""
        orig_en = row.get("en") or ""

        zh = orig_zh.strip()
        if zh:
            # Normalize full-width ? and ! to crisp half-width ? and !
            zh = zh.replace("？", "?").replace("！", "!")
            # Strip trailing periods/commas/semicolons right before optional closing quotes or end of line
            zh = re.sub(r"[。，、；;]+([\"”』」]?)$", r"\1", zh)
            zh = re.sub(r"(?<!\.)\.(?!\.)([\"”』」]?)$", r"\1", zh)
            # Replace internal Chinese commas/頓號/semicolons (and ASCII commas adjacent to CJK) with space
            zh = re.sub(r"[，、；]", " ", zh)
            zh = re.sub(r"(?<=[\u4e00-\u9fff])\s*,\s*|\s*,\s*(?=[\u4e00-\u9fff])", " ", zh)
            # Replace internal Chinese periods '。' (when two sentences are on one line) with space
            zh = re.sub(r"。+", " ", zh)
            # Normalize leading speaker dash '-你好' -> '- 你好'
            zh = re.sub(r"^-\s*(\S)", r"- \1", zh)
            zh = re.sub(r"\s+", " ", zh).strip()

        en = re.sub(r"\s+", " ", orig_en).strip()
        if en:
            en = re.sub(r"^-\s*(\S)", r"- \1", en)

        if zh != orig_zh or en != orig_en:
            changed_count += 1
        row["zh"] = zh
        row["en"] = en
        updated.append(row)

    return {"ok": True, "subtitles": updated, "changed_count": changed_count}


def _split_single_sentence_near_mid(text: str) -> tuple[str, str]:
    text = text.strip()
    if not text:
        return "", ""
    n = len(text)
    if n <= 2:
        return text, ""

    mid = n / 2.0
    # Priority 1: dual-speaker dash ' - '
    dash_matches = [m.start() for m in re.finditer(r"\s+-\s+", text)]
    if dash_matches:
        best = min(dash_matches, key=lambda idx: abs(idx - mid))
        left = text[:best].strip()
        right = text[best:].strip()
        if left and right:
            return left, right

    # Priority 2: punctuation or space near middle (within 18%..82% of length)
    lo, hi = int(n * 0.18), max(int(n * 0.18) + 1, int(n * 0.82))
    candidates: list[tuple[float, int, int]] = []
    for m in re.finditer(r"([?!。，、；,;.]+\s*|\s+)", text):
        split_at = m.end()
        if lo <= split_at <= hi:
            # Punctuation breaks get a slight bonus over plain whitespace
            is_punct = bool(re.search(r"[?!。，、；,;.]", m.group(0)))
            penalty = abs(split_at - mid) - (3.5 if is_punct else 0.0)
            candidates.append((penalty, split_at, m.start()))

    if candidates:
        candidates.sort(key=lambda x: x[0])
        _, split_at, _ = candidates[0]
        return text[:split_at].strip(), text[split_at:].strip()

    # Fallback: split at character midpoint (for unspaced CJK) or nearest space
    all_spaces = [m.start() for m in re.finditer(r"\s+", text)]
    if all_spaces:
        sp = min(all_spaces, key=lambda idx: abs(idx - mid))
        return text[:sp].strip(), text[sp:].strip()

    cut = int(round(mid))
    return text[:cut].strip(), text[cut:].strip()


def split_subtitle_cue_in_two(cue: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Intelligently split one long subtitle cue into two sequential cues,
    allocating timestamps proportionally to character count.
    """
    zh1, zh2 = _split_single_sentence_near_mid(cue.get("zh") or "")
    en1, en2 = _split_single_sentence_near_mid(cue.get("en") or "")

    start_ms = int(cue.get("start_ms", 0))
    end_ms = max(start_ms + 600, int(cue.get("end_ms", start_ms + 2000)))
    total_dur = end_ms - start_ms

    len1 = max(1, len(zh1) * 2 + len(en1))
    len2 = max(1, len(zh2) * 2 + len(en2))
    ratio = max(0.25, min(0.75, len1 / (len1 + len2)))

    mid_ms = start_ms + int(round(total_dur * ratio))
    gap = 30 if total_dur >= 900 else 0

    first = dict(cue)
    first["start_ms"] = start_ms
    first["end_ms"] = max(start_ms + 250, mid_ms - gap)
    first["zh"] = zh1
    first["en"] = en1

    second = dict(cue)
    second["start_ms"] = mid_ms
    second["end_ms"] = max(mid_ms + 250, end_ms)
    second["zh"] = zh2
    second["en"] = en2

    return [first, second]


def reindex_subtitles(subs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for idx, item in enumerate(subs, start=1):
        item["id"] = idx
    return subs


def hex_to_ass_color(hex_color: str, opacity: float = 1.0) -> str:
    """
    Convert CSS #RRGGBB + opacity (1.0=opaque, 0.0=transparent)
    to ASS color format &HAABBGGRR (where AA=00 is opaque, FF is transparent!).
    """
    c = hex_color.strip().lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        c = "FFFFFF"
    r = int(c[0:2], 16)
    g = int(c[2:4], 16)
    b = int(c[4:6], 16)
    alpha = int(round((1.0 - max(0.0, min(1.0, opacity))) * 255))
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def export_srt(
    subtitles: list[dict[str, Any]],
    order: str = "zh_top",
    lang_mode: str = "bilingual",
) -> str:
    """
    Export standard SRT string.
    lang_mode: 'bilingual' | 'zh_only' | 'en_only'
    order: 'zh_top' | 'en_top'
    """
    blocks: list[str] = []
    idx_counter = 1
    for item in subtitles:
        zh = (item.get("zh") or "").strip()
        en = (item.get("en") or "").strip()

        if lang_mode == "zh_only":
            lines = [zh] if zh else []
        elif lang_mode == "en_only":
            lines = [en] if en else []
        else:
            ordered = [zh, en] if order == "zh_top" else [en, zh]
            lines = [ln for ln in ordered if ln]

        if not lines:
            continue

        start_str = format_srt_timestamp(item["start_ms"])
        end_str = format_srt_timestamp(item["end_ms"])
        blocks.append(f"{idx_counter}\n{start_str} --> {end_str}\n" + "\n".join(lines))
        idx_counter += 1

    return "\n\n".join(blocks) + "\n"


def _motion_segments(item: dict[str, Any]):
    """Yield timed ASS positions, clipping segments to the cue's current in/out points."""
    points = item.get("motion")
    if not isinstance(points, list):
        return
    prev = None
    for point in points:
        if not isinstance(point, list) or len(point) != 3 or not all(
            isinstance(v, (float, int)) and math.isfinite(v) for v in point
        ):
            continue
        if prev is None:
            prev = point
            continue
        t1, x1, y1 = prev
        t2, x2, y2 = point
        if t2 <= t1:
            continue
        prev = point
        start = max(t1, item["start_ms"])
        end = min(t2, item["end_ms"])
        if start >= end:
            continue

        def position(ms):
            mix = (ms - t1) / (t2 - t1)
            x = max(0, min(1, x1 + mix * (x2 - x1)))
            y = max(0, min(1, y1 + mix * (y2 - y1)))
            return f"{round(x * 1920)},{round(y * 1080)}"

        yield start, end, position(start), position(end)


def export_ass(
    subtitles: list[dict[str, Any]],
    style: dict[str, Any],
    lang_mode: str = "bilingual",
    title: str = "Default Aegisub file",
) -> str:
    """
    Compile subtitles + visual style configuration into a standard 1920x1080 ASS v4+ file!
    Supports exact subtitle-group style fields (ScaleX, blur, fsvp, YCbCr Matrix, custom style names)
    with inline {\\rSecondary} reset so multi-line wrapping never overlaps.
    """
    order = style.get("order", "zh_top")
    margin_v = int(style.get("margin_v", 15))
    line_gap = int(round(float(style.get("line_gap", 4))))
    blur_val = float(style.get("blur", 2.0))
    ycbcr_matrix = str(style.get("ycbcr_matrix", "None"))
    box_mode = bool(style.get("box_mode", False))
    box_color = style.get("box_color", "#000000")
    box_opacity = float(style.get("box_opacity", 0.6))

    border_style = 3 if box_mode else 1

    zh_cfg = style.get("zh", {})
    en_cfg = style.get("en", {})
    zh_style_name = str(zh_cfg.get("style_name") or "默认文泉").replace(",", " ")
    en_style_name = str(en_cfg.get("style_name") or "Eng - ITC").replace(",", " ")
    zh_size_val = float(zh_cfg.get("size", 70))
    en_size_val = float(en_cfg.get("size", 47))
    zh_scale_x = float(zh_cfg.get("scale_x", 93))
    en_scale_x = float(en_cfg.get("scale_x", 95))
    zh_margin_lr = int(zh_cfg.get("margin_l", 10)) + int(zh_cfg.get("margin_r", 11))
    en_margin_lr = int(en_cfg.get("margin_l", 15)) + int(en_cfg.get("margin_r", 15))

    def fmt_num(val: float) -> str:
        rounded = round(val, 2)
        return str(int(rounded)) if rounded == int(rounded) else f"{rounded:g}"

    def estimate_wrapped_lines(txt: str, fsize: float, sx: float, margin_lr: int) -> int:
        avail_w = max(600.0, 1920.0 - margin_lr)
        width_est = 0.0
        sx_factor = max(0.5, sx / 100.0)
        for ch in txt:
            if ord(ch) > 0x2E7F:
                width_est += fsize * sx_factor
            else:
                width_est += fsize * 0.52 * sx_factor
        return max(1, int(math.ceil(width_est / avail_w)))

    def make_ass_style_line(name: str, cfg: dict[str, Any], mv_offset: int = 0) -> str:
        font = str(cfg.get("font", "WenQuanYi Micro Hei")).replace(",", " ")
        size = int(round(float(cfg.get("size", 70))))
        pri_color = hex_to_ass_color(cfg.get("color", "#B7B7B7"), 1.0)
        sec_color = hex_to_ass_color(cfg.get("secondary_color", "#000000"), 1.0)
        if box_mode:
            out_color = hex_to_ass_color(box_color, box_opacity)
            back_color = hex_to_ass_color(box_color, box_opacity)
            outline = max(6.0, float(cfg.get("outline", 2.0)) * 3.0)
            shadow = 0.0
        else:
            out_color = hex_to_ass_color(cfg.get("outline_color", "#000000"), 1.0)
            back_hex = cfg.get("back_color", "#000000")
            back_op = float(cfg.get("back_opacity", 1.0))
            back_color = hex_to_ass_color(back_hex, back_op)
            outline = float(cfg.get("outline", 0.8))
            shadow = float(cfg.get("shadow", 0.7))

        bold = -1 if cfg.get("bold", True) else 0
        italic = -1 if cfg.get("italic", False) else 0
        scale_x = int(round(float(cfg.get("scale_x", 100))))
        margin_l = int(cfg.get("margin_l", 10))
        margin_r = int(cfg.get("margin_r", 11))
        mv = max(0, margin_v + mv_offset)
        return (
            f"Style: {name},{font},{size},{pri_color},{sec_color},{out_color},{back_color},"
            f"{bold},{italic},0,0,{scale_x},100,0,0,{border_style},{fmt_num(outline)},{fmt_num(shadow)},"
            f"2,{margin_l},{margin_r},{mv},1"
        )

    zh_style_line = make_ass_style_line(zh_style_name, zh_cfg, mv_offset=0)
    en_style_line = make_ass_style_line(en_style_name, en_cfg, mv_offset=0)
    top_note_style_name = "注释-雅黑"
    top_note_color = hex_to_ass_color(zh_cfg.get("color", "#B7B7B7"), 1.0)
    top_note_style_line = (
        f"Style: {top_note_style_name},微软雅黑,75,{top_note_color},&H00000000,&H00000000,&H00000000,"
        f"-1,0,0,0,90,100,0,0,1,1,1,8,10,10,40,1"
    )

    header = f"""[Script Info]
; Script generated by EasySub Studio (傻瓜双语字幕工坊)
Title: {title}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: {ycbcr_matrix}
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{zh_style_line}
{en_style_line}
{top_note_style_line}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    def esc_ass(txt: str) -> str:
        return txt.replace("\r\n", " ").replace("\n", " ").strip()

    blur_tag = f"\\blur{fmt_num(blur_val)}" if (not box_mode and blur_val > 0) else ""
    top_prefix = f"{{{blur_tag}}}" if blur_tag else ""
    bot_mv = max(0, margin_v)
    box_pad = 12 if box_mode else 0

    events: list[str] = []
    for item in subtitles:
        zh = esc_ass(item.get("zh") or "")
        en = esc_ass(item.get("en") or "")
        is_top_note = item.get("pos") == "top"

        if item.get("motion"):
            if zh and lang_mode != "en_only":
                for t1, t2, p1, p2 in _motion_segments(item):
                    start, end = format_ass_timestamp(t1), format_ass_timestamp(t2)
                    if start == end:
                        continue
                    tag = f"\\pos({p1})" if p1 == p2 else f"\\move({p1},{p2})"
                    events.append(f"Dialogue: 3,{start},{end},{zh_style_name},,0,0,0,,{{\\an2{tag}{blur_tag}}}{zh}")
            continue

        start_str = format_ass_timestamp(item["start_ms"])
        end_str = format_ass_timestamp(item["end_ms"])

        if is_top_note:
            # Top-screen annotation / sign row (Layer 2, Alignment 8 at top center)
            parts_top = [p for p in ([zh, en] if order == "zh_top" else [en, zh]) if p]
            if lang_mode == "zh_only":
                parts_top = [zh] if zh else []
            elif lang_mode == "en_only":
                parts_top = [en] if en else []
            if parts_top:
                joined_top = "\\N".join(parts_top)
                events.append(
                    f"Dialogue: 2,{start_str},{end_str},{top_note_style_name},,0,0,0,,{top_prefix}{joined_top}"
                )
            continue

        if lang_mode == "zh_only":
            if not zh:
                continue
            events.append(f"Dialogue: 0,{start_str},{end_str},{zh_style_name},,0,0,{bot_mv},,{top_prefix}{zh}")
        elif lang_mode == "en_only":
            if not en:
                continue
            events.append(f"Dialogue: 0,{start_str},{end_str},{en_style_name},,0,0,{bot_mv},,{top_prefix}{en}")
        else:
            if zh and en:
                # Emit independent Layer 1 (upper) + Layer 0 (lower) events so libass/VSFilter/PGS
                # honor exact 1px positive, zero, or negative line_gap without collision flipping!
                if order == "zh_top":
                    bot_lines = estimate_wrapped_lines(en, en_size_val, en_scale_x, en_margin_lr)
                    top_mv = max(
                        0,
                        int(
                            round(
                                bot_mv
                                + 0.75 * en_size_val
                                + (bot_lines - 1) * en_size_val
                                - 0.10 * zh_size_val
                                + box_pad
                                + line_gap
                            )
                        ),
                    )
                    events.append(
                        f"Dialogue: 1,{start_str},{end_str},{zh_style_name},,0,0,{top_mv},,{top_prefix}{zh}"
                    )
                    events.append(
                        f"Dialogue: 0,{start_str},{end_str},{en_style_name},,0,0,{bot_mv},,{top_prefix}{en}"
                    )
                else:
                    bot_lines = estimate_wrapped_lines(zh, zh_size_val, zh_scale_x, zh_margin_lr)
                    top_mv = max(
                        0,
                        int(
                            round(
                                bot_mv
                                + 0.86 * zh_size_val
                                + (bot_lines - 1) * zh_size_val
                                - 0.02 * en_size_val
                                + box_pad
                                + line_gap
                            )
                        ),
                    )
                    events.append(
                        f"Dialogue: 1,{start_str},{end_str},{en_style_name},,0,0,{top_mv},,{top_prefix}{en}"
                    )
                    events.append(
                        f"Dialogue: 0,{start_str},{end_str},{zh_style_name},,0,0,{bot_mv},,{top_prefix}{zh}"
                    )
            elif zh:
                events.append(f"Dialogue: 0,{start_str},{end_str},{zh_style_name},,0,0,{bot_mv},,{top_prefix}{zh}")
            elif en:
                events.append(f"Dialogue: 0,{start_str},{end_str},{en_style_name},,0,0,{bot_mv},,{top_prefix}{en}")

    return header + "\n".join(events) + "\n"
