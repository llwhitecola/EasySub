"""
Subtitle parsing, bilingual auto-splitting, merging/alignment,
style presets, and ASS v4+ / SRT export engine.
"""

from __future__ import annotations

import json
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
        "desc": "文泉驿微米黑银灰白 + ITC 暖沙金英文，93%窄字宽与柔边羽化(\\blur2)，HDR/蓝光原盘同款",
        "order": "zh_top",
        "margin_v": 15,
        "line_gap": 9,
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
        "line_gap": 6,
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
        "line_gap": 6,
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
        "line_gap": 8,
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
        "line_gap": 6,
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
        "line_gap": 7,
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
        if has_cjk(line):
            return line, ""
        return "", line

    # Multi-line cue: separate lines with CJK vs non-CJK
    zh_lines: list[str] = []
    en_lines: list[str] = []
    for ln in lines:
        if has_cjk(ln):
            zh_lines.append(ln)
        else:
            en_lines.append(ln)

    if zh_lines and en_lines:
        return " ".join(zh_lines), " ".join(en_lines)

    # All lines same language: keep together
    joined = " ".join(lines)
    if has_cjk(joined):
        return joined, ""
    return "", joined


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
    return items


def parse_ass(content: str, lang_hint: str = "auto") -> list[dict[str, Any]]:
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    in_events = False
    format_fields: list[str] = []
    raw_events: list[dict[str, Any]] = []

    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.lower() == "[events]":
            in_events = True
            continue
        if in_events and stripped.startswith("[") and stripped.endswith("]"):
            break
        if not in_events or not stripped:
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
            text = row.get("text", "")
            zh, en = split_bilingual_lines(text, lang_hint=lang_hint)
            if not zh and not en:
                continue
            raw_events.append(
                {
                    "start_ms": start_ms,
                    "end_ms": max(end_ms, start_ms + 500),
                    "zh": zh,
                    "en": en,
                }
            )

    # Some ASS files put Chinese and English as two separate Dialogue lines at identical timestamps.
    # Automatically merge adjacent/identical timestamp events if one is ZH and the other is EN!
    raw_events.sort(key=lambda x: (x["start_ms"], x["end_ms"]))
    merged: list[dict[str, Any]] = []
    for ev in raw_events:
        if merged:
            prev = merged[-1]
            same_time = (
                abs(prev["start_ms"] - ev["start_ms"]) <= 120
                and abs(prev["end_ms"] - ev["end_ms"]) <= 120
            )
            if same_time:
                if prev["zh"] and not prev["en"] and ev["en"] and not ev["zh"]:
                    prev["en"] = ev["en"]
                    continue
                if prev["en"] and not prev["zh"] and ev["zh"] and not ev["en"]:
                    prev["zh"] = ev["zh"]
                    continue
        ev["id"] = len(merged) + 1
        merged.append(ev)

    return merged


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


def merge_two_subtitles(
    primary_subs: list[dict[str, Any]],
    secondary_subs: list[dict[str, Any]],
    secondary_lang: str = "auto",
    align_mode: str = "time",
) -> list[dict[str, Any]]:
    """
    Merge two subtitle lists into one clean bilingual subtitle list!
    - align_mode == 'time': Smart overlap & midpoint alignment (handles slightly mismatched line counts!)
    - align_mode == 'index': Line-by-line 1-to-1 pairing (ideal when secondary comes from plain text lines)
    """
    result = [dict(item) for item in primary_subs]

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
        return ("zh", combined) if has_cjk(combined) else ("en", combined)

    if align_mode == "index":
        for idx, sec in enumerate(secondary_subs):
            lang_key, txt = extract_sec_text(sec)
            if not txt:
                continue
            if idx < len(result):
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
        return reindex_subtitles(result)

    # Time-based alignment
    unmatched_secondary: list[dict[str, Any]] = []
    for sec in secondary_subs:
        lang_key, txt = extract_sec_text(sec)
        if not txt:
            continue
        s_start = sec["start_ms"]
        s_end = sec["end_ms"]
        s_mid = (s_start + s_end) / 2.0

        best_idx = -1
        best_score = -1e9

        for idx, pri in enumerate(result):
            p_start = pri["start_ms"]
            p_end = pri["end_ms"]
            overlap = min(p_end, s_end) - max(p_start, s_start)
            if overlap > 0:
                score = overlap * 2.0 - abs(p_start - s_start) * 0.2
                if score > best_score:
                    best_score = score
                    best_idx = idx
            else:
                p_mid = (p_start + p_end) / 2.0
                dist = abs(p_mid - s_mid)
                if dist <= 1200:
                    score = -dist
                    if score > best_score:
                        best_score = score
                        best_idx = idx

        if best_idx >= 0:
            existing = result[best_idx].get(lang_key, "").strip()
            result[best_idx][lang_key] = f"{existing} {txt}".strip() if existing else txt
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
    result.sort(key=lambda x: (x["start_ms"], x["end_ms"]))
    return reindex_subtitles(result)


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
    line_gap = int(round(float(style.get("line_gap", 9))))
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

    def fmt_num(val: float) -> str:
        rounded = round(val, 2)
        return str(int(rounded)) if rounded == int(rounded) else f"{rounded:g}"

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
    en_style_line = make_ass_style_line(en_style_name, en_cfg, mv_offset=2)

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

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    def esc_ass(txt: str) -> str:
        return txt.replace("\r\n", " ").replace("\n", " ").strip()

    blur_tag = f"\\blur{fmt_num(blur_val)}" if (not box_mode and blur_val > 0) else ""
    top_prefix = f"{{{blur_tag}}}" if blur_tag else ""
    fsvp_tag = f"\\fsvp{line_gap}" if line_gap > 0 else ""

    events: list[str] = []
    for item in subtitles:
        zh = esc_ass(item.get("zh") or "")
        en = esc_ass(item.get("en") or "")

        start_str = format_ass_timestamp(item["start_ms"])
        end_str = format_ass_timestamp(item["end_ms"])

        if lang_mode == "zh_only":
            if not zh:
                continue
            events.append(f"Dialogue: 0,{start_str},{end_str},{zh_style_name},,0,0,0,,{top_prefix}{zh}")
        elif lang_mode == "en_only":
            if not en:
                continue
            events.append(f"Dialogue: 0,{start_str},{end_str},{en_style_name},,0,0,0,,{top_prefix}{en}")
        else:
            if zh and en:
                if order == "zh_top":
                    events.append(
                        f"Dialogue: 0,{start_str},{end_str},{zh_style_name},,0,0,0,,{top_prefix}{zh}\\N{{\\r{en_style_name}{fsvp_tag}{blur_tag}}}{en}"
                    )
                else:
                    events.append(
                        f"Dialogue: 0,{start_str},{end_str},{en_style_name},,0,0,0,,{top_prefix}{en}\\N{{\\r{zh_style_name}{fsvp_tag}{blur_tag}}}{zh}"
                    )
            elif zh:
                events.append(f"Dialogue: 0,{start_str},{end_str},{zh_style_name},,0,0,0,,{top_prefix}{zh}")
            elif en:
                events.append(f"Dialogue: 0,{start_str},{end_str},{en_style_name},,0,0,0,,{top_prefix}{en}")

    return header + "\n".join(events) + "\n"
