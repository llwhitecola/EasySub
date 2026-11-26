"""Regression checks for SUP gradient masks. Requires FFmpeg with libass."""

from __future__ import annotations

from argparse import ArgumentParser
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.lyrics_fx import split_ass_vc_for_pgs
from core.subtitles import export_ass
from core.sup_export import _quantize_rgba, convert_ass_content_to_sup, convert_ass_file_to_sup


def decode_frame(sup: Path) -> np.ndarray:
    raw = subprocess.check_output(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi",
            "-i", "color=c=black:s=1280x720:r=10:d=3", "-i", str(sup),
            "-filter_complex", "[0:v][1:s]overlay", "-ss", "0.3", "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        timeout=30,
    )
    return np.frombuffer(raw, np.uint8).reshape(720, 1280, 3)


def check_vsfiltermod(folder: Path, dll: Path) -> None:
    cue = {"start_ms": 1000, "end_ms": 2250, "zh": "Native gradient", "en": ""}
    style = {
        "blur": 0,
        "zh": {
            "font": "Arial", "size": 70, "outline": 0, "shadow": 0,
            "gradient": ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF"],
        },
    }
    ass = export_ass([cue], style).replace("Native gradient", r"Native gradient\NSecond gradient")
    source = folder / "歌词.ass"
    source.write_text(ass, encoding="utf-8-sig")
    sup = source.with_suffix(".sup")
    result = convert_ass_file_to_sup(
        source, sup, resolution="720p", renderer="vsfiltermod", vsfiltermod_dll=dll
    )
    assert result["events_written"] == 1
    assert result["missing_fonts"] == []
    frame = decode_frame(sup).astype(np.int16)
    assert frame[:360].max() == 0
    for primary, other_a, other_b in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
        dominant = (frame[:, :, primary] - frame[:, :, other_a] > 35) & (
            frame[:, :, primary] - frame[:, :, other_b] > 35
        )
        assert np.count_nonzero(dominant) > 100
    print("VSFilterMod preserves the position and native colors of a multiline gradient")

    missing = "EasySub Test Missing Face"
    source.write_text(ass.replace("Arial", missing), encoding="utf-8-sig")
    result = convert_ass_file_to_sup(
        source, sup, resolution="720p", renderer="vsfiltermod", vsfiltermod_dll=dll
    )
    assert result["missing_fonts"] == [missing]
    print("VSFilterMod reports a missing ASS font while keeping the exported SUP")


def check_gradient_palette() -> None:
    frame = np.zeros((8, 100, 4), dtype=np.uint8)
    frame[:4, :, 0] = np.arange(100, dtype=np.uint8) // 3 + 96
    frame[:4, :, 1:3] = [107, 112]
    frame[:4, :, 3] = 255
    frame[4:, :, 3] = np.arange(100, dtype=np.uint8)
    errors = []
    for preserve_fill in (False, True):
        indices, palette = _quantize_rgba(frame, preserve_fill=preserve_fill)
        assert len(palette) <= 254 * 4
        rgb = np.array(palette, dtype=np.int16).reshape(-1, 4)[indices[:4], :3]
        errors.append(np.mean(np.abs(frame[:4, :, :3] - rgb)))
    assert errors[1] < errors[0] / 2, errors
    print("SUP palette keeps subtle gradient steps without exceeding the PGS limit")


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("--vsfiltermod-dll", type=Path)
    args = parser.parse_args()
    cue = {"start_ms": 1000, "end_ms": 2250, "zh": "Small gradient edge test", "en": ""}
    style = {
        "blur": 2.5,
        "zh": {
            "font": "Arial", "size": 20, "outline": 1.2, "shadow": 0.7,
            "gradient": ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF"],
        },
    }
    ass = export_ass([cue], style)
    header, event = ass.split("Dialogue:", 1)
    _, masks, groups = split_ass_vc_for_pgs(header + ("Dialogue:" + event) * 300)
    assert masks.count("Dialogue:") == sum(map(len, groups.values())) == 300
    assert r"\blur2.5" not in masks and r"\blur0" in masks
    print("300 independent masks and no fill blur")
    check_gradient_palette()

    with tempfile.TemporaryDirectory(prefix="easysub_check_sup_") as folder:
        sup = Path(folder) / "gradient.sup"
        result = convert_ass_content_to_sup(ass, sup, resolution="720p")
        assert result["events_written"] == 1
        frame = decode_frame(sup)
        chroma = np.ptp(frame, axis=2)
        assert np.count_nonzero((frame.max(axis=2) > 45) & (chroma > 25)) > 150
        print("Small blurred gradient stays visible after SUP encoding and decoding")
        if args.vsfiltermod_dll:
            check_vsfiltermod(Path(folder), args.vsfiltermod_dll)


if __name__ == "__main__":
    main()
