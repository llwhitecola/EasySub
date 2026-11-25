"""Track an on-screen annotation in normalized video coordinates."""

from __future__ import annotations

import math
import os
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path


_FPS = 20
_STEP_MS = 1000 // _FPS
_LK = {"winSize": (21, 21), "maxLevel": 3}
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class TrackingCancelled(Exception):
    pass


def _simplify(points: list[list[float]], width: int, height: int) -> list[list[float]]:
    """Keep points needed to reproduce the timed path within about one analysis pixel."""
    keep = {0, len(points) - 1}
    pending = [(0, len(points) - 1)]
    while pending:
        left, right = pending.pop()
        start, x1, y1 = points[left]
        end, x2, y2 = points[right]
        worst, pivot = 1.0, None
        for i in range(left + 1, right):
            ms, x, y = points[i]
            mix = (ms - start) / (end - start)
            error = math.hypot((x - x1 - mix * (x2 - x1)) * width, (y - y1 - mix * (y2 - y1)) * height)
            if error > worst:
                worst, pivot = error, i
        if pivot is not None:
            keep.add(pivot)
            pending.extend(((left, pivot), (pivot, right)))
    return [points[i] for i in sorted(keep)]


def track_motion(
    video_path: Path,
    start_ms: int,
    end_ms: int,
    box: list[float],
    video_size: list[int],
    cancelled: Callable[[], bool] = lambda: False,
) -> dict:
    import cv2
    import numpy as np

    if start_ms < 0 or end_ms - start_ms < 2 * _STEP_MS:
        raise ValueError("请选择至少 0.1 秒的追踪片段")
    x, y, w, h = box
    if not all(math.isfinite(v) for v in box) or min(x, y) < 0 or min(w, h) <= 0 or max(x + w, y + h) > 1.000001:
        raise ValueError("请在画面内框选追踪目标")
    source_width, source_height = video_size
    if min(video_size) < 1:
        raise ValueError("无法读取视频尺寸")
    scale = min(1, 960 / source_width, 540 / source_height)
    width, height = (max(2, round(n * scale)) for n in video_size)
    if min(w * width, h * height) < 8:
        raise ValueError("框选范围太小，请把路牌的边缘和文字一起框进去")

    corners = np.float32([
        [x * width, y * height], [(x + w) * width, y * height],
        [(x + w) * width, (y + h) * height], [x * width, (y + h) * height],
    ])
    # Use the midpoint above the sign as the bottom-centre anchor of the label.
    anchor = np.float32([(x + w / 2) * width, (y - min(0.018, h / 3)) * height])

    def features(gray):
        mask = np.zeros(gray.shape, dtype=np.uint8)
        cv2.fillConvexPoly(mask, np.int32(np.rint(corners)), 255)
        return cv2.goodFeaturesToTrack(gray, maxCorners=80, qualityLevel=0.012, minDistance=4, mask=mask)

    def point(ms):
        # Keep the bottom-centre label anchor far enough inside the frame to read it.
        return [ms, round(float(np.clip(anchor[0] / width, 0.02, 0.98)), 6),
                round(float(np.clip(anchor[1] / height, 0.08, 0.98)), 6)]

    frames = math.ceil((end_ms - start_ms) / _STEP_MS)
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start_ms / 1000:.3f}", "-i", str(video_path),
        "-map", "0:v:0", "-an", "-sn", "-dn", "-filter_threads", "1",
        "-vf", f"fps={_FPS}:start_time=0,scale={width}:{height},format=gray",
        "-frames:v", str(frames), "-f", "rawvideo", "pipe:1",
    ]
    points = []
    with tempfile.TemporaryFile() as errors:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors, creationflags=_NO_WINDOW)
        except FileNotFoundError as exc:
            raise RuntimeError("跟随标注需要安装 FFmpeg，并加入系统 PATH") from exc
        try:
            previous, seeds = None, None
            for i in range(frames):
                if cancelled():
                    raise TrackingCancelled()
                raw = proc.stdout.read(width * height)
                if len(raw) != width * height:
                    break
                gray = np.frombuffer(raw, np.uint8).reshape(height, width)
                if previous is not None:
                    forward, f_status, _ = cv2.calcOpticalFlowPyrLK(previous, gray, seeds, None, **_LK)
                    if forward is None:
                        break
                    back, b_status, _ = cv2.calcOpticalFlowPyrLK(gray, previous, forward, None, **_LK)
                    if back is None:
                        break
                    valid = ((f_status.ravel() != 0) & (b_status.ravel() != 0)
                             & (np.linalg.norm((back - seeds).reshape(-1, 2), axis=1) < 1.3))
                    if valid.sum() < 4:
                        break
                    transform, inliers = cv2.estimateAffinePartial2D(seeds[valid], forward[valid], ransacReprojThreshold=2.5)
                    if transform is None or inliers.sum() < max(4, math.ceil(len(seeds) * 0.35)):
                        break
                    if not 0.83 <= math.hypot(transform[0, 0], transform[0, 1]) <= 1.2:
                        break
                    corners = cv2.transform(corners[None], transform)[0]
                    anchor = cv2.transform(anchor.reshape(1, 1, 2), transform)[0, 0]
                    center_x, center_y = corners.mean(axis=0)
                    if not (0 <= center_x < width and 0 <= center_y < height):
                        break
                seeds = features(gray)
                if seeds is None or len(seeds) < 4:
                    break
                points.append(point(start_ms + i * _STEP_MS))
                previous = gray
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.stdout.close()
            proc.wait()
        if len(points) < 2:
            errors.seek(0)
            if error := errors.read(450).decode("utf-8", "replace").strip():
                raise RuntimeError(f"无法读取追踪片段：{error}")
            raise ValueError("没有找到足够稳定的特征，请换一帧，框入路牌文字和边缘后再试")

    tracked_end = min(end_ms, start_ms + len(points) * _STEP_MS)
    points.append([tracked_end, *points[-1][1:]])
    return {"motion": _simplify(points, width, height), "end_ms": tracked_end}
