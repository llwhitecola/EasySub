"""
Lyrics narrative aesthetics, ASS \\1vc 4-corner vertex gradients, kinetic \\t() animations,
and PGS gradient splitting (true bilinear \\1vc compositing) for Blu-ray SUP rasterization.
"""

from __future__ import annotations

import math
import re
from typing import Any

HEX_COLOR_RE = re.compile(r"^#([0-9a-fA-F]{6})$")
ASS_VC_RE = re.compile(
    r"\\1?vc\(\s*&H([0-9a-fA-F]{6})&?\s*,\s*&H([0-9a-fA-F]{6})&?\s*,\s*&H([0-9a-fA-F]{6})&?\s*,\s*&H([0-9a-fA-F]{6})&?\s*\)",
    re.IGNORECASE,
)
_MASK_DECORATION_RE = re.compile(
    r"\\(?:[xy]?(?:bord|shad)|blur|be)\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)", re.IGNORECASE
)

VALID_ANIM_IDS = frozenset(
    {
        "none",
        "snyder_push",
        "nolan_dissolve",
        "wkw_afterimage",
        "shinkai_focus",
        "breath_glow",
        "neon_flicker",
        "impact_flash",
    }
)


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    m = HEX_COLOR_RE.match((hex_color or "").strip())
    if not m:
        return (255, 255, 255)
    raw = m.group(1)
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))


def rgb_to_ass_bgr(r: int, g: int, b: int) -> str:
    rc = max(0, min(255, int(round(r))))
    gc = max(0, min(255, int(round(g))))
    bc = max(0, min(255, int(round(b))))
    return f"&H{bc:02X}{gc:02X}{rc:02X}&"


def hex_to_ass_bgr(hex_color: str) -> str:
    r, g, b = hex_to_rgb(hex_color)
    return rgb_to_ass_bgr(r, g, b)


def ass_bgr_to_rgb(bgr_hex6: str) -> tuple[int, int, int]:
    b = int(bgr_hex6[0:2], 16)
    g = int(bgr_hex6[2:4], 16)
    r = int(bgr_hex6[4:6], 16)
    return (r, g, b)


def is_valid_gradient(val: Any) -> bool:
    return (
        isinstance(val, (list, tuple))
        and len(val) == 4
        and all(isinstance(c, str) and bool(HEX_COLOR_RE.match(c)) for c in val)
    )


def gradient_representative_hex(grad: list[str] | tuple[str, ...]) -> str:
    """Return a clean representative #RRGGBB fallback color for libass players without VSFilterMod."""
    if not is_valid_gradient(grad):
        return "#FFFFFF"
    # Weight top-left & bottom-right slightly higher so high-contrast diagonals preserve their lead hue
    rgbs = [hex_to_rgb(c) for c in grad]
    weights = (0.34, 0.22, 0.22, 0.22)
    r = sum(c[0] * w for c, w in zip(rgbs, weights))
    g = sum(c[1] * w for c, w in zip(rgbs, weights))
    b = sum(c[2] * w for c, w in zip(rgbs, weights))
    return f"#{int(round(r)):02X}{int(round(g)):02X}{int(round(b)):02X}"


def build_ass_gradient_tag(grad: Any) -> str:
    """
    Build dual-compatible ASS fill tags: \\1c&HBBGGRR& fallback + \\1vc(TL,TR,BL,BR) 4-corner gradient.
    """
    if not is_valid_gradient(grad):
        return ""
    tl, tr, bl, br = (hex_to_ass_bgr(c) for c in grad)
    if tl == tr == bl == br:
        return f"\\1c{tl}"
    rep = hex_to_ass_bgr(gradient_representative_hex(grad))
    return f"\\1c{rep}\\1vc({tl},{tr},{bl},{br})"


def _scale_t(t1: int, t2: int, mult: float) -> tuple[int, int]:
    s1 = max(0, int(math.floor(t1 * mult)))
    s2 = max(s1 + 1, int(math.floor(t2 * mult)))
    return s1, s2


def build_ass_anim_tag(anim_id: Any, anim_mult: Any = 1.0) -> str:
    """
    Build rhythm-scaled ASS \\t() kinetic animation tags matching Aegisub v4.2 Narrative Aesthetics.
    """
    if not isinstance(anim_id, str) or anim_id not in VALID_ANIM_IDS or anim_id == "none":
        return ""
    mult = float(anim_mult) if isinstance(anim_mult, (int, float)) and math.isfinite(anim_mult) and anim_mult > 0 else 1.0
    mult = max(0.2, min(3.0, mult))

    if anim_id == "snyder_push":
        t1, t2 = _scale_t(0, 600, mult)
        return f"\\fscx106\\fscy106\\blur2\\t({t1},{t2},\\fscx100\\fscy100\\blur1)"
    if anim_id == "nolan_dissolve":
        t1, t2 = _scale_t(0, 900, mult)
        return f"\\fscx103\\fscy103\\blur3\\t({t1},{t2},\\fscx100\\fscy100\\blur1.5)"
    if anim_id == "wkw_afterimage":
        a1, a2 = _scale_t(0, 500, mult)
        b1, b2 = _scale_t(1800, 2400, mult)
        return f"\\blur5\\t({a1},{a2},\\blur1.5)\\t({b1},{b2},\\blur4)"
    if anim_id == "shinkai_focus":
        t1, t2 = _scale_t(0, 400, mult)
        return f"\\fscx96\\fscy96\\blur3\\t({t1},{t2},\\fscx100\\fscy100\\blur1.5)"
    if anim_id == "breath_glow":
        a1, a2 = _scale_t(0, 900, mult)
        b1, b2 = _scale_t(900, 1800, mult)
        return f"\\t({a1},{a2},\\blur4)\\t({b1},{b2},\\blur1.5)"
    if anim_id == "neon_flicker":
        a1, a2 = _scale_t(0, 100, mult)
        b1, b2 = _scale_t(100, 200, mult)
        c1, c2 = _scale_t(200, 320, mult)
        d1, d2 = _scale_t(320, 500, mult)
        return (
            f"\\t({a1},{a2},\\alpha&H55&)\\t({b1},{b2},\\alpha&H00&)"
            f"\\t({c1},{c2},\\alpha&H77&)\\t({d1},{d2},\\alpha&H00&)"
        )
    if anim_id == "impact_flash":
        t1, t2 = _scale_t(0, 180, mult)
        return f"\\fscx128\\fscy128\\blur8\\alpha&H88&\\t({t1},{t2},\\fscx100\\fscy100\\blur0.5\\alpha&H00&)"
    return ""


def _parse_playres_and_styles(ass_content: str) -> tuple[int, int, dict[str, dict[str, Any]]]:
    play_w, play_h = 1920, 1080
    styles: dict[str, dict[str, Any]] = {}
    section = ""
    style_fields: list[str] = []

    for raw in ass_content.splitlines():
        line = raw.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line.lower()
            continue
        if section == "[script info]":
            low = line.lower()
            if low.startswith("playresx:"):
                try:
                    play_w = max(320, int(line.split(":", 1)[1].strip()))
                except ValueError:
                    pass
            elif low.startswith("playresy:"):
                try:
                    play_h = max(240, int(line.split(":", 1)[1].strip()))
                except ValueError:
                    pass
        elif section in ("[v4+ styles]", "[v4 styles]"):
            if line.lower().startswith("format:"):
                style_fields = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
            elif line.lower().startswith("style:") and style_fields:
                parts = [p.strip() for p in line.split(":", 1)[1].split(",")]
                row = dict(zip(style_fields, parts))
                name = row.get("name", "")
                if name:
                    try:
                        mv = int(float(row.get("marginv", "20") or 20))
                    except ValueError:
                        mv = 20
                    try:
                        align = int(row.get("alignment", "2") or 2)
                    except ValueError:
                        align = 2
                    try:
                        ml = int(float(row.get("marginl", "10") or 10))
                    except ValueError:
                        ml = 10
                    try:
                        mr = int(float(row.get("marginr", "10") or 10))
                    except ValueError:
                        mr = 10
                    styles[name] = {
                        "marginv": mv,
                        "alignment": align,
                        "marginl": ml,
                        "marginr": mr,
                    }
    return play_w, play_h, styles


def _bilerp_bgr(
    tl: tuple[int, int, int],
    tr: tuple[int, int, int],
    bl: tuple[int, int, int],
    br: tuple[int, int, int],
    u: float,
    v: float,
) -> str:
    u = max(0.0, min(1.0, u))
    v = max(0.0, min(1.0, v))
    r = (1 - u) * (1 - v) * tl[0] + u * (1 - v) * tr[0] + (1 - u) * v * bl[0] + u * v * br[0]
    g = (1 - u) * (1 - v) * tl[1] + u * (1 - v) * tr[1] + (1 - u) * v * bl[1] + u * v * br[1]
    b = (1 - u) * (1 - v) * tl[2] + u * (1 - v) * tr[2] + (1 - u) * v * bl[2] + u * v * br[2]
    return rgb_to_ass_bgr(int(round(r)), int(round(g)), int(round(b)))


def _inject_leading_tags(text: str, extra_tags: str) -> str:
    if text.startswith("{"):
        return "{" + extra_tags + text[1:]
    return f"{{{extra_tags}}}{text}"


def split_ass_vc_for_pgs(
    ass_content: str,
) -> tuple[str, str, dict[str, list[tuple[tuple[int, int, int], ...]]]]:
    """
    Split the PGS render script into base frames and isolated gradient mask frames.

    Each gradient event gets its own mask frame in script order. Group the corresponding
    corner colours by the base frame's synthetic start timestamp.
    """
    if "vc(" not in ass_content.lower():
        return ass_content, "", {}

    from core.subtitles import format_ass_timestamp

    play_w, play_h, styles = _parse_playres_and_styles(ass_content)
    header_lines: list[str] = []
    base_events: list[str] = []
    fill_events: list[str] = []
    gradients: dict[str, list[tuple[tuple[int, int, int], ...]]] = {}
    fmt_fields: list[str] = []
    events_format = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    in_events = False

    for raw in ass_content.splitlines():
        stripped = raw.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if stripped.lower() == "[events]":
                in_events = True
                continue
            in_events = False
            header_lines.append(raw)
            continue
        if not in_events:
            header_lines.append(raw)
            continue

        low = stripped.lower()
        if low.startswith("format:"):
            events_format = stripped
            fmt_fields = [f.strip().lower() for f in stripped.split(":", 1)[1].split(",")]
            continue
        if not low.startswith("dialogue:"):
            base_events.append(raw)
            continue
        if not fmt_fields:
            fmt_fields = [
                "layer", "start", "end", "style", "name",
                "marginl", "marginr", "marginv", "effect", "text",
            ]

        payload = stripped.split(":", 1)[1].lstrip()
        parts = payload.split(",", len(fmt_fields) - 1)
        if len(parts) < len(fmt_fields):
            base_events.append(raw)
            continue

        text_idx = fmt_fields.index("text") if "text" in fmt_fields else len(fmt_fields) - 1
        text = parts[text_idx]
        m = ASS_VC_RE.search(text)
        # Multi-line \N gradient events stay untouched: libass falls back to the flat
        # \1c colour rather than getting an invisible or misaligned fill.
        if not m or "\\N" in text:
            base_events.append(raw)
            continue

        start_idx = fmt_fields.index("start")
        end_idx = fmt_fields.index("end")
        style_idx = fmt_fields.index("style") if "style" in fmt_fields else 3
        mv_idx = fmt_fields.index("marginv") if "marginv" in fmt_fields else 7
        ml_idx = fmt_fields.index("marginl") if "marginl" in fmt_fields else -1
        mr_idx = fmt_fields.index("marginr") if "marginr" in fmt_fields else -1

        corners = tuple(ass_bgr_to_rgb(m.group(i)) for i in (1, 2, 3, 4))
        clean_text = ASS_VC_RE.sub("", text)
        clean_text = re.sub(r"\\1?c&H[0-9a-fA-F]+&?", "", clean_text)

        st_info = styles.get(
            parts[style_idx].strip(),
            {"marginv": 20, "alignment": 2, "marginl": 10, "marginr": 10},
        )
        try:
            ev_mv = int(parts[mv_idx].strip())
        except (ValueError, IndexError):
            ev_mv = 0
        mv = ev_mv if ev_mv > 0 else int(st_info["marginv"])
        align = int(st_info["alignment"])
        an_m = re.search(r"\\an([1-9])", clean_text)
        if an_m:
            align = int(an_m.group(1))

        def _event_int(idx: int) -> int:
            if idx < 0:
                return 0
            try:
                return int(parts[idx].strip())
            except (ValueError, IndexError):
                return 0

        ev_ml, ev_mr = _event_int(ml_idx), _event_int(mr_idx)
        ml = ev_ml if ev_ml > 0 else int(st_info.get("marginl", 10))
        mr = ev_mr if ev_mr > 0 else int(st_info.get("marginr", 10))

        if align in (1, 4, 7):
            ax = ml
        elif align in (3, 6, 9):
            ax = play_w - mr
        else:
            ax = (ml + play_w - mr) // 2
        if align in (7, 8, 9):
            ay = mv
        elif align in (4, 5, 6):
            ay = play_h // 2
        else:
            ay = play_h - mv
        anchor = "" if re.search(r"\\(?:pos|move)\s*\(", clean_text, re.IGNORECASE) else f"\\an{align}\\pos({ax},{ay})"
        base_parts = list(parts)
        base_parts[text_idx] = _inject_leading_tags(clean_text, anchor + "\\1a&HFF&")
        base_events.append("Dialogue: " + ",".join(base_parts))

        fill_parts = list(parts)
        mask_time = (len(fill_events) + 1) * 1000
        fill_parts[start_idx] = format_ass_timestamp(mask_time - 250)
        fill_parts[end_idx] = format_ass_timestamp(mask_time + 250)
        # Later inline blur/border/shadow tags would override the leading mask tags.
        fill_text = re.sub(r"\{[^}]*\}", lambda block: _MASK_DECORATION_RE.sub("", block.group()), clean_text)
        fill_parts[text_idx] = _inject_leading_tags(
            fill_text,
            anchor + "\\1a&H00&\\3a&HFF&\\4a&HFF&\\bord0\\shad0\\blur0\\be0\\1c&HFFFFFF&",
        )
        fill_events.append("Dialogue: " + ",".join(fill_parts))
        gradients.setdefault(parts[start_idx], []).append(corners)

    if not gradients:
        return ass_content, "", {}

    base_ass = "\n".join(header_lines + ["[Events]", events_format] + base_events) + "\n"
    fill_ass = "\n".join(header_lines + ["[Events]", events_format] + fill_events) + "\n"
    return base_ass, fill_ass, gradients
