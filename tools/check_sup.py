"""Regression checks for SUP gradient masks. Requires FFmpeg with libass."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.lyrics_fx import split_ass_vc_for_pgs
from core.subtitles import export_ass
from core.sup_export import convert_ass_content_to_sup


def main() -> None:
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

    with tempfile.TemporaryDirectory(prefix="easysub_check_sup_") as folder:
        sup = Path(folder) / "gradient.sup"
        result = convert_ass_content_to_sup(ass, sup, resolution="720p")
        assert result["events_written"] == 1
        raw = subprocess.check_output(
            [
                "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi",
                "-i", "color=c=black:s=1280x720:r=10:d=3", "-i", str(sup),
                "-filter_complex", "[0:v][1:s]overlay", "-ss", "1.2", "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ],
            timeout=30,
        )
        frame = np.frombuffer(raw, np.uint8).reshape(720, 1280, 3)
        chroma = np.ptp(frame, axis=2)
        assert np.count_nonzero((frame.max(axis=2) > 45) & (chroma > 25)) > 150
    print("Small blurred gradient stays visible after SUP encoding and decoding")


if __name__ == "__main__":
    main()
