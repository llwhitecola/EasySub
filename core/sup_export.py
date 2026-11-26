"""
ASS to Blu-ray HDMV PGS (.sup) Graphic Subtitle Encoder Engine.
Uses FFmpeg's built-in libass renderer for 100% authentic vector/tag/blur rendering,
splits VSFilterMod \\1vc gradients into isolated glyph masks and applies the bilinear
gradient on the CPU, then quantizes with Pillow FASTOCTREE and encodes Blu-ray PGS RLE.
"""

from __future__ import annotations

import os
import re
import struct
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image

from core.lyrics_fx import split_ass_vc_for_pgs
from core.subtitles import (
    export_ass,
    format_ass_timestamp,
    parse_ass_timestamp,
    read_text_auto_encoding,
)

ProgressCallback = Callable[[str, int], None]
WIN_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

PGS_FPS_CODES: dict[str, int] = {
    "23.976": 0x10,
    "24": 0x20,
    "25": 0x30,
    "29.97": 0x40,
    "50": 0x60,
    "59.94": 0x70,
}

PGS_FPS_VALUES: dict[str, float] = {
    "23.976": 24000.0 / 1001.0,
    "24": 24.0,
    "25": 25.0,
    "29.97": 30000.0 / 1001.0,
    "50": 50.0,
    "59.94": 60000.0 / 1001.0,
}

FAD_TAG_RE = re.compile(r"\\fade?\([^)]*\)", re.IGNORECASE)


def _read_exact(stream: Any, n: int) -> bytes:
    """Read exactly n bytes from a pipe stream unless EOF is reached."""
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _ms_to_pts90k(ms: float) -> int:
    return int(round(max(0.0, ms) * 90.0)) & 0xFFFFFFFF


def _pack_pgs_segment(seg_type: int, pts_ticks: int, payload: bytes) -> bytes:
    header = struct.pack(">2sIIBH", b"PG", pts_ticks, 0, seg_type, len(payload))
    return header + payload


def _rgba_palette_to_pds_payload(rgba_entries: list[tuple[int, int, int, int]]) -> bytes:
    """
    Convert list of (R, G, B, A) palette entries (up to 256) into a PGS PDS (0x14) payload
    using ITU-R BT.709 studio-swing Y, Cr, Cb, Alpha byte order.
    """
    buf = bytearray([0x00, 0x00])  # palette_id=0, version=0
    for idx, (r, g, b, a) in enumerate(rgba_entries[:256]):
        if a == 0:
            buf.extend((idx, 16, 128, 128, 0))
            continue
        y = int(round(16.0 + 0.182586 * r + 0.614231 * g + 0.062007 * b))
        cb = int(round(128.0 - 0.100644 * r - 0.338572 * g + 0.439216 * b))
        cr = int(round(128.0 + 0.439216 * r - 0.398942 * g - 0.040274 * b))
        y = max(16, min(235, y))
        cr = max(16, min(240, cr))
        cb = max(16, min(240, cb))
        buf.extend((idx, y, cr, cb, a))
    return bytes(buf)


def _encode_pgs_rle(index_grid: np.ndarray) -> bytes:
    """
    Fast Blu-ray HDMV PGS Run-Length Encoder using NumPy run-boundary detection per scanline.
    index_grid: 2D uint8 array of shape (H, W) where 0 = transparent.
    """
    out = bytearray()
    h, w = index_grid.shape

    for y in range(h):
        row = index_grid[y]
        if w == 0:
            out.extend(b"\x00\x00")
            continue

        # Vectorized run-length finding for the scanline
        diffs = np.flatnonzero(row[1:] != row[:-1]) + 1
        starts = np.empty(len(diffs) + 1, dtype=np.int32)
        starts[0] = 0
        starts[1:] = diffs
        lengths = np.empty_like(starts)
        lengths[:-1] = diffs - starts[:-1]
        lengths[-1] = w - starts[-1]
        colors = row[starts]

        for c_val, run_len in zip(colors.tolist(), lengths.tolist()):
            rem = run_len
            while rem > 0:
                n = min(rem, 16383)
                rem -= n
                if c_val == 0:
                    if n <= 63:
                        out.extend((0x00, n))
                    else:
                        out.extend((0x00, 0x40 | (n >> 8), n & 0xFF))
                else:
                    if n == 1:
                        out.append(c_val)
                    elif n == 2:
                        out.extend((c_val, c_val))
                    elif n <= 63:
                        out.extend((0x00, 0x80 | n, c_val))
                    else:
                        out.extend((0x00, 0xC0 | (n >> 8), n & 0xFF, c_val))

        # End of line marker
        out.extend(b"\x00\x00")

    return bytes(out)


def _unpremultiply_rgba(frame: np.ndarray) -> np.ndarray:
    """FFmpeg's subtitles filter hands back premultiplied RGBA; PGS stores straight alpha.

    Without this, every antialiased edge/blurred outline is composited a second time by
    the player and the SUP looks thin and dark compared with the same ASS in Aegisub.
    """
    alpha = frame[:, :, 3].astype(np.float32)
    rgb = frame[:, :, :3].astype(np.float32)
    scale = np.where(alpha > 0, 255.0 / np.maximum(alpha, 1.0), 0.0)
    out = frame.copy()
    out[:, :, :3] = np.clip(rgb * scale[:, :, None], 0, 255).astype(np.uint8)
    return out


def _composite_gradient_fill(
    base: np.ndarray,
    alpha: np.ndarray,
    corners: tuple[tuple[int, int, int], ...],
) -> None:
    """Apply a bilinear gradient over the glyph bounds, preserving anti-aliasing."""
    ys, xs = np.nonzero(alpha > 2)
    if not xs.size:
        return

    x0, y0 = xs.min(), ys.min()
    u = ((xs - x0) / max(1, xs.max() - x0)).astype(np.float32)
    v = ((ys - y0) / max(1, ys.max() - y0)).astype(np.float32)
    tl, tr, bl, br = np.asarray(corners, dtype=np.float32)
    top = tl + (tr - tl) * u[:, None]
    bottom = bl + (br - bl) * u[:, None]
    colour = top + (bottom - top) * v[:, None]

    af = alpha[ys, xs].astype(np.float32) / 255.0
    ab = base[ys, xs, 3].astype(np.float32) / 255.0
    out_a = af + ab * (1.0 - af)
    base_rgb = base[ys, xs, :3].astype(np.float32)
    out_rgb = (
        colour * af[:, None] + base_rgb * ab[:, None] * (1.0 - af)[:, None]
    ) / out_a[:, None]
    base[ys, xs, :3] = np.rint(np.clip(out_rgb, 0, 255)).astype(np.uint8)
    base[ys, xs, 3] = np.rint(np.clip(out_a * 255, 0, 255)).astype(np.uint8)


def _extract_subtitle_regions(frame_rgba: np.ndarray) -> list[tuple[int, int, np.ndarray]]:
    """
    Find up to 2 vertical bounding-box regions with non-zero alpha (e.g. top sign + bottom dialogue).
    Returns list of (x, y, cropped_rgba_ndarray) with even dimensions >= 8x8.
    """
    alpha = frame_rgba[:, :, 3]
    active_rows = np.flatnonzero(alpha.max(axis=1) > 2)
    if len(active_rows) == 0:
        return []

    # Check if there is a large vertical transparent gap (> 13% of screen height) separating top & bottom text
    gap_threshold = max(90, int(frame_rgba.shape[0] * 0.13))
    row_gaps = active_rows[1:] - active_rows[:-1]
    split_indices = np.flatnonzero(row_gaps > gap_threshold)

    row_bands: list[tuple[int, int]] = []
    if len(split_indices) >= 1:
        # Split at the largest vertical gap into at most 2 PGS windows (Blu-ray spec max = 2 objects!)
        biggest_gap_pos = int(split_indices[np.argmax(row_gaps[split_indices])])
        row_bands.append((int(active_rows[0]), int(active_rows[biggest_gap_pos])))
        row_bands.append((int(active_rows[biggest_gap_pos + 1]), int(active_rows[-1])))
    else:
        row_bands.append((int(active_rows[0]), int(active_rows[-1])))

    H, W, _ = frame_rgba.shape
    regions: list[tuple[int, int, np.ndarray]] = []

    for y0_raw, y1_raw in row_bands:
        band_alpha = alpha[y0_raw : y1_raw + 1, :]
        active_cols = np.flatnonzero(band_alpha.max(axis=0) > 2)
        if len(active_cols) == 0:
            continue

        pad = 2
        x0 = max(0, int(active_cols[0]) - pad)
        x1 = min(W, int(active_cols[-1]) + 1 + pad)
        y0 = max(0, y0_raw - pad)
        y1 = min(H, y1_raw + 1 + pad)

        # Ensure even coordinates/sizes and minimum 8x8 for hardware Blu-ray decoders
        if (x1 - x0) < 8:
            x1 = min(W, x0 + 8)
        if (y1 - y0) < 8:
            y1 = min(H, y0 + 8)
        if (x1 - x0) % 2 == 1:
            if x1 < W:
                x1 += 1
            elif x0 > 0:
                x0 -= 1
        if (y1 - y0) % 2 == 1:
            if y1 < H:
                y1 += 1
            elif y0 > 0:
                y0 -= 1

        crop = frame_rgba[y0:y1, x0:x1].copy()
        # Clean near-zero alpha noise
        crop[crop[:, :, 3] <= 2] = 0
        regions.append((x0, y0, crop))

    return regions


def _quantize_regions_shared_palette(
    regions: list[tuple[int, int, np.ndarray]]
) -> tuple[list[tuple[int, int, int, int]], list[tuple[int, int, int, int, bytes]]]:
    """
    Quantize 1 or 2 cropped RGBA regions into a single shared 256-entry RGBA palette
    (with index 0 guaranteed to be transparent (0,0,0,0)), and RLE-encode each object.
    Returns (palette_entries, [(x, y, w, h, rle_bytes), ...]).
    """
    if len(regions) == 1:
        x0, y0, crop = regions[0]
        composite = crop
        slices = [(x0, y0, crop.shape[1], crop.shape[0], 0, crop.shape[0])]
    else:
        max_w = max(r[2].shape[1] for r in regions)
        total_h = sum(r[2].shape[0] for r in regions)
        composite = np.zeros((total_h, max_w, 4), dtype=np.uint8)
        slices = []
        cy = 0
        for x0, y0, crop in regions:
            ch, cw, _ = crop.shape
            composite[cy : cy + ch, 0:cw] = crop
            slices.append((x0, y0, cw, ch, cy, cy + ch))
            cy += ch

    pil_img = Image.fromarray(composite, mode="RGBA")
    quantized = pil_img.quantize(colors=254, method=Image.Quantize.FASTOCTREE)
    raw_pal = quantized.getpalette("RGBA") or []
    idx_arr = np.array(quantized, dtype=np.uint8)

    # Remap so index 0 is strictly transparent (0,0,0,0) and active colors start at 1..255
    used_indices = np.unique(idx_arr)
    remap = np.zeros(256, dtype=np.uint8)
    palette_entries: list[tuple[int, int, int, int]] = [(0, 0, 0, 0)]

    for old_idx in used_indices.tolist():
        base = old_idx * 4
        if base + 4 <= len(raw_pal):
            r, g, b, a = raw_pal[base : base + 4]
        else:
            r, g, b, a = 0, 0, 0, 0
        if a <= 2:
            remap[old_idx] = 0
        else:
            new_idx = len(palette_entries)
            if new_idx < 256:
                palette_entries.append((r, g, b, a))
                remap[old_idx] = new_idx
            else:
                remap[old_idx] = 255

    remapped_all = remap[idx_arr]
    # Also force pixels where original composite alpha == 0 to index 0
    remapped_all[composite[:, :, 3] <= 2] = 0

    encoded_objects: list[tuple[int, int, int, int, bytes]] = []
    for x0, y0, cw, ch, sy0, sy1 in slices:
        sub_idx = remapped_all[sy0:sy1, 0:cw]
        rle_bytes = _encode_pgs_rle(sub_idx)
        encoded_objects.append((x0, y0, cw, ch, rle_bytes))

    return palette_entries, encoded_objects


def _build_show_display_set(
    pts_ticks: int,
    comp_num: int,
    canvas_w: int,
    canvas_h: int,
    fps_code: int,
    palette: list[tuple[int, int, int, int]],
    objects: list[tuple[int, int, int, int, bytes]],
) -> bytes:
    out = bytearray()

    # 1. PCS (0x16) - Epoch Start (0x80)
    pcs = bytearray(
        struct.pack(
            ">HHBHB3B",
            canvas_w,
            canvas_h,
            fps_code,
            comp_num & 0xFFFF,
            0x80,  # Epoch Start
            0x00,  # palette_update_flag = False
            0x00,  # palette_id = 0
            len(objects),
        )
    )
    for obj_id, (x, y, w, h, _) in enumerate(objects):
        pcs.extend(struct.pack(">HBBHH", obj_id, obj_id, 0x00, x, y))
    out.extend(_pack_pgs_segment(0x16, pts_ticks, bytes(pcs)))

    # 2. WDS (0x17)
    wds = bytearray([len(objects)])
    for win_id, (x, y, w, h, _) in enumerate(objects):
        wds.extend(struct.pack(">BHHHH", win_id, x, y, w, h))
    out.extend(_pack_pgs_segment(0x17, pts_ticks, bytes(wds)))

    # 3. PDS (0x14)
    pds_payload = _rgba_palette_to_pds_payload(palette)
    out.extend(_pack_pgs_segment(0x14, pts_ticks, pds_payload))

    # 4. ODS (0x15) - Supports automatic multi-packet splitting if RLE > 65514 bytes
    for obj_id, (x, y, w, h, rle_data) in enumerate(objects):
        obj_data_len = len(rle_data) + 4
        len_3bytes = struct.pack(">I", obj_data_len)[1:]
        full_obj_body = len_3bytes + struct.pack(">HH", w, h) + rle_data

        max_chunk = 65515
        if len(full_obj_body) <= max_chunk:
            ods_payload = struct.pack(">HBB", obj_id, 0x00, 0xC0) + full_obj_body
            out.extend(_pack_pgs_segment(0x15, pts_ticks, ods_payload))
        else:
            chunks = [
                full_obj_body[i : i + max_chunk]
                for i in range(0, len(full_obj_body), max_chunk)
            ]
            for c_idx, chunk in enumerate(chunks):
                if c_idx == 0:
                    seq_flag = 0x80
                elif c_idx == len(chunks) - 1:
                    seq_flag = 0x40
                else:
                    seq_flag = 0x00
                ods_payload = struct.pack(">HBB", obj_id, 0x00, seq_flag) + chunk
                out.extend(_pack_pgs_segment(0x15, pts_ticks, ods_payload))

    # 5. END (0x80)
    out.extend(_pack_pgs_segment(0x80, pts_ticks, b""))
    return bytes(out)


def _build_clear_display_set(
    pts_ticks: int,
    comp_num: int,
    canvas_w: int,
    canvas_h: int,
    fps_code: int,
    prev_objects: list[tuple[int, int, int, int, bytes]],
) -> bytes:
    out = bytearray()
    # PCS (0x16) - Normal state (0x00) with 0 composition objects clears the screen
    pcs = struct.pack(
        ">HHBHB3B",
        canvas_w,
        canvas_h,
        fps_code,
        comp_num & 0xFFFF,
        0x00,
        0x00,
        0x00,
        0,
    )
    out.extend(_pack_pgs_segment(0x16, pts_ticks, pcs))

    # WDS (0x17) - Reference the window geometry being cleared
    wds = bytearray([len(prev_objects)])
    for win_id, (x, y, w, h, _) in enumerate(prev_objects):
        wds.extend(struct.pack(">BHHHH", win_id, x, y, w, h))
    out.extend(_pack_pgs_segment(0x17, pts_ticks, bytes(wds)))

    # END (0x80)
    out.extend(_pack_pgs_segment(0x80, pts_ticks, b""))
    return bytes(out)


def _parse_ass_into_render_intervals(ass_content: str) -> tuple[str, str, list[dict[str, Any]]]:
    """
    Parse any ASS file preserving its exact [Script Info], [V4+ Styles], and raw Dialogue lines,
    and compute non-overlapping atomic active time intervals [(start_ms, end_ms, [dialogue_lines])].
    """
    text = ass_content.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    header_lines: list[str] = []
    events_format_line = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    dialogues: list[dict[str, Any]] = []

    in_events = False
    in_garbage = False
    format_fields: list[str] = []

    for line in lines:
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("[aegisub project garbage]"):
            in_garbage = True
            in_events = False
            continue
        if low == "[events]":
            in_events = True
            in_garbage = False
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            in_garbage = False
            if in_events:
                in_events = False
                continue

        if in_garbage:
            continue

        if not in_events:
            header_lines.append(line)
            continue

        if low.startswith("format:"):
            events_format_line = stripped
            format_fields = [f.strip().lower() for f in stripped.split(":", 1)[1].split(",")]
        elif low.startswith("dialogue:"):
            if not format_fields:
                format_fields = [
                    "layer", "start", "end", "style", "name",
                    "marginl", "marginr", "marginv", "effect", "text",
                ]
            payload = stripped.split(":", 1)[1].lstrip()
            parts = payload.split(",", len(format_fields) - 1)
            if len(parts) < len(format_fields):
                continue
            start_idx = format_fields.index("start")
            end_idx = format_fields.index("end")
            text_idx = format_fields.index("text")

            s_ms = parse_ass_timestamp(parts[start_idx])
            e_ms = parse_ass_timestamp(parts[end_idx])
            if e_ms <= s_ms + 20:
                continue
            if not parts[text_idx].strip():
                continue

            # Strip \fad/\fade on static PGS conversion so single-snapshot bitmaps are at full opacity
            parts[text_idx] = FAD_TAG_RE.sub("", parts[text_idx])

            dialogues.append(
                {
                    "start_ms": s_ms,
                    "end_ms": e_ms,
                    "parts": parts,
                    "start_idx": start_idx,
                    "end_idx": end_idx,
                }
            )

    if not dialogues:
        return "\n".join(header_lines), events_format_line, []

    # Build atomic active intervals with a sweep line over the cue boundaries.  The old
    # per-interval scan was O(intervals × dialogues); a feature-length script with a few
    # thousand cues spent seconds in it before ffmpeg even started.
    by_start: dict[int, list[int]] = {}
    by_end: dict[int, list[int]] = {}
    for i, d in enumerate(dialogues):
        by_start.setdefault(d["start_ms"], []).append(i)
        by_end.setdefault(d["end_ms"], []).append(i)

    boundaries = sorted(set(by_start) | set(by_end))
    active: set[int] = set()
    intervals: list[dict[str, Any]] = []
    for b_idx in range(len(boundaries) - 1):
        t0 = boundaries[b_idx]
        t1 = boundaries[b_idx + 1]
        for i in by_end.get(t0, ()):
            active.discard(i)
        for i in by_start.get(t0, ()):
            active.add(i)
        if t1 - t0 < 30 or not active:
            continue
        intervals.append(
            {
                "start_ms": t0,
                "end_ms": t1,
                # Keep the script's dialogue order for equal-layer collisions.
                "active": [dialogues[i] for i in sorted(active)],
            }
        )

    return "\n".join(header_lines), events_format_line, intervals


def convert_ass_content_to_sup(
    ass_content: str,
    out_sup_path: str | Path,
    resolution: str = "1080p",
    fps: str = "23.976",
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """
    Render an ASS subtitle string into a Blu-ray PGS (.sup) binary file!
    resolution: '1080p' (1920x1080) | '4k' (3840x2160) | '720p' (1280x720)
    fps: '23.976' | '24' | '25' | '29.97' | '50' | '59.94'
    """
    res_map = {
        "720p": (1280, 720),
        "1080p": (1920, 1080),
        "4k": (3840, 2160),
    }
    canvas_w, canvas_h = res_map.get(resolution.lower(), (1920, 1080))
    fps_code = PGS_FPS_CODES.get(fps, 0x10)
    fps_val = PGS_FPS_VALUES.get(fps, 24000.0 / 1001.0)
    frame_step_ms = 1000.0 / fps_val

    header_block, events_fmt_line, intervals = _parse_ass_into_render_intervals(ass_content)
    if not intervals:
        raise ValueError("ASS 字幕中没有检测到任何有效时间轴对白行，无法生成 SUP。")

    total = len(intervals)
    if progress:
        progress(f"共解析 {total} 个字幕画面区间，正在准备 libass 矢量渲染…", 6)

    with tempfile.TemporaryDirectory(prefix="easysub_pgs_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        synthetic_ass = tmp_path / "pgs_render.ass"

        # Map interval k (0..total-1) to the virtual timestamp [k+0.75s, k+1.25s],
        # sampled at t=(k+1).00s (1 fps).  A later sample would settle imported \t()
        # intros but would also advance karaoke \k states; the midpoint keeps both close
        # to the frame the viewer sees when the interval starts.
        synth_event_lines: list[str] = []
        for k, iv in enumerate(intervals):
            virt_start = format_ass_timestamp((k + 1) * 1000 - 250)
            virt_end = format_ass_timestamp((k + 1) * 1000 + 250)
            for d in iv["active"]:
                p = list(d["parts"])
                p[d["start_idx"]] = virt_start
                p[d["end_idx"]] = virt_end
                synth_event_lines.append("Dialogue: " + ",".join(p))

        full_synth_ass = (
            f"{header_block.strip()}\n\n[Events]\n{events_fmt_line}\n"
            + "\n".join(synth_event_lines)
            + "\n"
        )
        base_ass, fill_ass, gradients = split_ass_vc_for_pgs(full_synth_ass)
        mask_count = sum(len(corners) for corners in gradients.values())
        synthetic_ass.write_text(base_ass, encoding="utf-8-sig")
        fill_ass_path = tmp_path / "pgs_fill.ass"
        if fill_ass:
            fill_ass_path.write_text(fill_ass, encoding="utf-8-sig")

        def render_cmd(ass_name: str, frames: int, *, mask: bool = False) -> list[str]:
            video_filter = f"subtitles={ass_name}:alpha=1,trim=start_frame=1:end_frame={frames + 1}"
            if mask:
                video_filter += ",alphaextract"
            return [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color=c=black@0.0:s={canvas_w}x{canvas_h}:r=1:d={frames + 2},format=rgba",
                "-vf",
                video_filter,
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray" if mask else "rgba",
                "-",
            ]

        mask_byte_len = canvas_w * canvas_h
        frame_byte_len = mask_byte_len * 4
        out_path = Path(out_sup_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        comp_num = 0
        last_pts_ticks = -1
        written_events = 0
        last_objects: list[tuple[int, int, int, int, bytes]] = []

        base_proc = subprocess.Popen(
            render_cmd(synthetic_ass.name, total),
            cwd=str(tmp_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=WIN_NO_WINDOW,
        )
        fill_proc = (
            subprocess.Popen(
                render_cmd(fill_ass_path.name, mask_count, mask=True),
                cwd=str(tmp_path),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=WIN_NO_WINDOW,
            )
            if fill_ass
            else None
        )
        procs = [base_proc] + ([fill_proc] if fill_proc is not None else [])

        try:
            try:
                with out_path.open("wb") as sup_file:
                    assert base_proc.stdout is not None
                    for k, iv in enumerate(intervals):
                        raw_frame = _read_exact(base_proc.stdout, frame_byte_len)
                        if len(raw_frame) < frame_byte_len:
                            raise RuntimeError("FFmpeg 渲染输出提前结束，SUP 可能不完整。")
                        frame_arr = _unpremultiply_rgba(
                            np.frombuffer(raw_frame, dtype=np.uint8).reshape(
                                (canvas_h, canvas_w, 4)
                            )
                        )
                        if fill_proc is not None:
                            assert fill_proc.stdout is not None
                            start = format_ass_timestamp((k + 1) * 1000 - 250)
                            for corners in gradients.get(start, ()):
                                raw_fill = _read_exact(fill_proc.stdout, mask_byte_len)
                                if len(raw_fill) < mask_byte_len:
                                    raise RuntimeError("FFmpeg 渐变蒙版输出提前结束，SUP 可能不完整。")
                                alpha = np.frombuffer(raw_fill, dtype=np.uint8).reshape(canvas_h, canvas_w)
                                _composite_gradient_fill(frame_arr, alpha, corners)
                        regions = _extract_subtitle_regions(frame_arr)
                        if not regions:
                            # Fully transparent interval (e.g. an alpha-hidden line):
                            # clear whatever the previous display set left on screen,
                            # otherwise the old subtitle would linger into this gap.
                            if last_objects:
                                clear_ticks = _ms_to_pts90k(iv["start_ms"])
                                if clear_ticks <= last_pts_ticks:
                                    clear_ticks = last_pts_ticks + 900  # +10ms
                                sup_file.write(
                                    _build_clear_display_set(
                                        pts_ticks=clear_ticks,
                                        comp_num=comp_num,
                                        canvas_w=canvas_w,
                                        canvas_h=canvas_h,
                                        fps_code=fps_code,
                                        prev_objects=last_objects,
                                    )
                                )
                                comp_num += 1
                                last_pts_ticks = clear_ticks
                                last_objects = []
                            continue

                        palette, objects = _quantize_regions_shared_palette(regions)

                        # Enforce strictly monotonic PTS ticks
                        start_ticks = _ms_to_pts90k(iv["start_ms"])
                        if start_ticks <= last_pts_ticks:
                            start_ticks = last_pts_ticks + int(round(frame_step_ms * 90.0))

                        show_ds = _build_show_display_set(
                            pts_ticks=start_ticks,
                            comp_num=comp_num,
                            canvas_w=canvas_w,
                            canvas_h=canvas_h,
                            fps_code=fps_code,
                            palette=palette,
                            objects=objects,
                        )
                        sup_file.write(show_ds)
                        comp_num += 1
                        last_pts_ticks = start_ticks
                        written_events += 1
                        last_objects = objects

                        # Determine whether to emit a Clear Display Set before the next subtitle
                        next_start_ms = intervals[k + 1]["start_ms"] if (k + 1 < total) else 1e12
                        if next_start_ms - iv["end_ms"] >= frame_step_ms * 0.85:
                            clear_ticks = _ms_to_pts90k(iv["end_ms"])
                            if clear_ticks <= last_pts_ticks:
                                clear_ticks = last_pts_ticks + 900  # +10ms
                            next_ticks = _ms_to_pts90k(next_start_ms)
                            if clear_ticks < next_ticks:
                                clear_ds = _build_clear_display_set(
                                    pts_ticks=clear_ticks,
                                    comp_num=comp_num,
                                    canvas_w=canvas_w,
                                    canvas_h=canvas_h,
                                    fps_code=fps_code,
                                    prev_objects=objects,
                                )
                                sup_file.write(clear_ds)
                                comp_num += 1
                                last_pts_ticks = clear_ticks
                                last_objects = []

                        if progress and (k % 5 == 0 or k == total - 1):
                            pct = min(98, 10 + int(((k + 1) / total) * 88))
                            progress(
                                f"正在压制蓝光 PGS (.sup) 图形字幕：{k + 1} / {total} 幕 ({pct}%)…",
                                pct,
                            )
            except Exception:
                out_path.unlink(missing_ok=True)
                raise
        finally:
            stderr_chunks: list[bytes] = []
            for render_proc in procs:
                if render_proc.stdout:
                    render_proc.stdout.close()
                stderr_chunks.append(render_proc.stderr.read() if render_proc.stderr else b"")
                if render_proc.stderr:
                    render_proc.stderr.close()
                render_proc.wait(timeout=15)

        for render_proc, stderr_bytes in zip(procs, stderr_chunks):
            if render_proc.returncode != 0:
                out_path.unlink(missing_ok=True)
                err_msg = stderr_bytes.decode("utf-8", errors="ignore")
                raise RuntimeError(
                    f"FFmpeg libass 渲染失败（退出码 {render_proc.returncode}）: {err_msg[:300]}"
                )
        if written_events == 0:
            out_path.unlink(missing_ok=True)
            raise RuntimeError("没有生成任何 PGS 字幕画面，请检查字幕事件是否可见。")

    if progress:
        progress(f"蓝光 SUP 转换完成！共写入 {written_events} 幕高清图形字幕", 100)

    return {
        "ok": True,
        "saved_path": str(out_path),
        "events_written": written_events,
        "file_size_mb": round(out_path.stat().st_size / (1024 * 1024), 2),
    }


def convert_ass_file_to_sup(
    ass_path: str | Path,
    out_sup_path: str | Path | None = None,
    resolution: str = "1080p",
    fps: str = "23.976",
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    src = Path(ass_path)
    if not src.exists():
        raise FileNotFoundError(f"找不到 ASS 文件: {ass_path}")
    target = Path(out_sup_path) if out_sup_path else src.with_suffix(".sup")
    content = read_text_auto_encoding(src)
    return convert_ass_content_to_sup(
        content,
        out_sup_path=target,
        resolution=resolution,
        fps=fps,
        progress=progress,
    )


def export_editor_subtitles_to_sup(
    subtitles: list[dict[str, Any]],
    style: dict[str, Any],
    lang_mode: str,
    out_sup_path: str | Path,
    resolution: str = "1080p",
    fps: str = "23.976",
    title: str = "EasySub Blu-ray PGS",
    progress: ProgressCallback | None = None,
    ink: list[Any] | None = None,
) -> dict[str, Any]:
    # The PGS converter renders one static picture per active interval.
    ass_content = export_ass(
        subtitles,
        style=style,
        lang_mode=lang_mode,
        title=title,
        include_fades=False,
        ink=ink,
    )
    return convert_ass_content_to_sup(
        ass_content,
        out_sup_path=out_sup_path,
        resolution=resolution,
        fps=fps,
        progress=progress,
    )
