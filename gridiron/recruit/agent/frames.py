"""Per-play key-frame extraction for the evaluator's v2 pass (GolfSnapPro trinity_client._extract_video_frames, kept as the
same idea: N evenly spaced JPEGs per clip, resized, base64/JPEG for the vision call) plus a denser option around the throw.

RUNS ON THE RUNPOD POD, not on this machine (house rule: ffmpeg / cv2 decode work goes to the pod on the project's RunPod network volume).
Clip paths come from REEL_ROOT/catalog.json ("clip", relative to REEL_ROOT, or to --workspace on the pod). On the pod:

    python agent/frames.py --athlete <athlete-id> --out /workspace/reel/frames --per-play 8 [--dense] [--workspace /workspace/reel]
    rsync / cloud_down.ps1 the frames folder back, then: python -P agent/film_evaluator.py --frames-dir recruit/data/frames

The v1 pass used the 1-second broadcast sheets already on disk; the model said plainly that release, footwork and eyes are not
judgeable at that cadence. Eight frames across the ~6-20 s play window at 1080p (and 16 dense frames across the 2 s around the
throw when --dense) is what the GolfSnapPro reports were built on."""
from __future__ import annotations
import argparse
import os
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(os.environ.get("REEL_ROOT") or HERE.parent / "data" / "reel")   # reel catalog and clips stay out of git


def extract(clip: pathlib.Path, out_dir: pathlib.Path, n: int = 8, t_in: float | None = None, t_out: float | None = None, width: int = 1280, dense: bool = False) -> list[str]:
    import cv2  # pod-only import
    cap = cv2.VideoCapture(str(clip))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    f0 = int((t_in or 0) * fps) if t_in is not None and total > (t_in * fps) else 0
    f1 = int(t_out * fps) if t_out is not None and total > (t_out * fps) else total - 1
    picks = [f0 + int(i * (f1 - f0) / max(1, n - 1)) for i in range(n)]
    if dense:                       # 16 frames across the middle 2 s (where the throw usually is)
        mid = (f0 + f1) // 2; span = int(fps * 2)
        picks += [max(f0, mid - span // 2) + int(i * span / 15) for i in range(16)]
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for idx in sorted(set(picks)):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            continue
        h, w = frame.shape[:2]
        if w > width:
            frame = cv2.resize(frame, (width, int(h * width / w)))
        p = out_dir / f"{clip.stem}_{idx:06d}_{idx / fps:07.2f}s.jpg"
        cv2.imwrite(str(p), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
        written.append(str(p))
    cap.release()
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--athlete", default="quinn-placeholder"); ap.add_argument("--out", required=True); ap.add_argument("--per-play", type=int, default=8)
    ap.add_argument("--dense", action="store_true"); ap.add_argument("--workspace", default="")
    a = ap.parse_args()
    plays = json.load(open(ROOT / "catalog.json", encoding="utf-8")).get("plays", [])
    base = pathlib.Path(a.workspace) if a.workspace else ROOT
    manifest = {}
    for s in plays:
        if not s.get("clip"):
            continue
        clip = base / s["clip"]
        if not clip.exists():
            print("missing clip", clip); continue
        # catalog clips are already cut to the play -> the whole clip is the window
        frames = extract(clip, pathlib.Path(a.out) / s["id"], a.per_play, None, None, dense=a.dense)
        manifest[s["id"]] = {"clip": str(clip), "frames": frames, "desc": s.get("desc", ""), "window": s.get("window")}
        print(s["id"], len(frames), "frames")
    pathlib.Path(a.out, "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print("manifest", pathlib.Path(a.out, "manifest.json"))


if __name__ == "__main__":
    main()
