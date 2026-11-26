"""Report ASS faces unavailable to VSFilterMod's Windows GDI renderer."""

from __future__ import annotations

import ctypes
import re
from collections.abc import Iterable
from ctypes import wintypes

from core.lyrics_fx import parse_ass_playres_and_styles

ASS_OVERRIDE_BLOCK = re.compile(r"(\{[^}]*\})")
ASS_FONT_TAG = re.compile(r"\\(?:(fn|r)([^\\}]*)|p(-?\d+))", re.IGNORECASE)


class _LogFont(ctypes.Structure):
    _fields_ = [
        ("height", wintypes.LONG),
        ("width", wintypes.LONG),
        ("escapement", wintypes.LONG),
        ("orientation", wintypes.LONG),
        ("weight", wintypes.LONG),
        ("italic", wintypes.BYTE),
        ("underline", wintypes.BYTE),
        ("strikeout", wintypes.BYTE),
        ("charset", wintypes.BYTE),
        ("out_precision", wintypes.BYTE),
        ("clip_precision", wintypes.BYTE),
        ("quality", wintypes.BYTE),
        ("pitch_and_family", wintypes.BYTE),
        ("face_name", wintypes.WCHAR * 32),
    ]


def _missing_gdi_faces(faces: Iterable[str]) -> list[str]:
    callback = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.POINTER(_LogFont), ctypes.c_void_p, wintypes.DWORD, wintypes.LPARAM
    )
    gdi = ctypes.WinDLL("gdi32")
    gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi.CreateCompatibleDC.restype = wintypes.HDC
    gdi.DeleteDC.argtypes = [wintypes.HDC]
    gdi.EnumFontFamiliesExW.argtypes = [
        wintypes.HDC, ctypes.POINTER(_LogFont), callback, wintypes.LPARAM, wintypes.DWORD
    ]
    dc = gdi.CreateCompatibleDC(None)
    if not dc:
        return []

    found = False

    @callback
    def mark_found(*_args):
        nonlocal found
        found = True
        return 0

    try:
        missing = []
        for face in sorted(set(faces), key=str.casefold):
            if len(face.encode("utf-16-le")) // 2 >= 32:
                missing.append(face)
                continue
            query = _LogFont()
            query.charset = 1  # DEFAULT_CHARSET lets GDI resolve localized family and face names.
            query.face_name = face
            found = False
            gdi.EnumFontFamiliesExW(dc, ctypes.byref(query), mark_found, 0, 0)
            if not found:
                missing.append(face)
        return missing
    finally:
        gdi.DeleteDC(dc)


def missing_ass_fonts(
    header: str, events_format: str, dialogue_rows: Iterable[list[str]]
) -> list[str]:
    # VSFilterMod can load embedded ASS fonts privately after opening the script.
    if re.search(r"^\s*\[fonts\]\s*$", header, re.IGNORECASE | re.MULTILINE):
        return []

    _, _, styles = parse_ass_playres_and_styles(header)
    style_fonts = {name.casefold(): fields["fontname"] for name, fields in styles.items()}
    columns = [field.strip().lower() for field in events_format.partition(":")[2].split(",")]
    if "style" not in columns or "text" not in columns:
        return []
    style_idx, text_idx = columns.index("style"), columns.index("text")

    faces: set[str] = set()
    for style, text in {(parts[style_idx], parts[text_idx]) for parts in dialogue_rows}:
        base = style_fonts.get(style.strip().lstrip("*").casefold(), style_fonts.get("default", ""))
        face = base
        drawing = False
        for chunk in ASS_OVERRIDE_BLOCK.split(text):
            if chunk.startswith("{") and chunk.endswith("}"):
                for tag, value, drawing_level in ASS_FONT_TAG.findall(chunk[1:-1]):
                    value = value.strip()
                    if drawing_level:
                        drawing = int(drawing_level) > 0
                    elif tag.lower() == "fn":
                        face = value or base
                    elif not value or value.casefold() in style_fonts:
                        face = style_fonts.get(value.casefold(), base)
            elif not drawing and face and re.sub(r"\\[nNh]", "", chunk).strip():
                faces.add(face.lstrip("@"))
    return _missing_gdi_faces(face for face in faces if face)
