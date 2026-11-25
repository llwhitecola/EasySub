/* A motion path uses video milliseconds and normalized coordinates. */

export const isMotion = (cue) => Array.isArray(cue?.motion) && cue.motion.length > 1;

export function trimMotionTime(cue, edge, ms) {
  const from = edge === "start" ? cue.motion[0][0] : cue.start_ms + 1;
  const to = edge === "start" ? cue.end_ms - 1 : cue.motion.at(-1)[0];
  return Math.max(from, Math.min(to, ms));
}

export function normalizeMotion(points) {
  const path = [];
  for (const point of Array.isArray(points) ? points : []) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) continue;
    const [time, x, y] = point;
    const ms = Math.round(time);
    if (ms < 0 || (path.length && ms <= path.at(-1)[0])) continue;
    path.push([ms, Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
  }
  return path;
}

export function motionAt(path, ms) {
  if (ms < path[0][0] || ms > path.at(-1)[0]) return null;
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (path[mid][0] <= ms) lo = mid;
    else hi = mid;
  }
  const [t1, x1, y1] = path[lo];
  const [t2, x2, y2] = path[hi];
  const mix = (ms - t1) / (t2 - t1);
  return [x1 + mix * (x2 - x1), y1 + mix * (y2 - y1)];
}

/** The intrinsic picture within a video element styled with object-fit: contain. */
export function pictureRect(video, width, height) {
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}
