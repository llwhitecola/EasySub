"""打包单文件 exe，本机和 GitHub Actions 用的是同一份命令。

    python tools/build_exe.py 1.8.0      ->  dist/EasySubStudio-v1.8.0.exe
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIDDEN = ["core.media_ai", "core.sup_export", "faster_whisper", "ctranslate2", "onnxruntime", "httpx", "PIL.Image", "cv2"]
COLLECT_ALL = ["webview", "pythonnet", "clr_loader"]
EXCLUDE = ["av", "cryptography", "hf_xet", "PIL._avif"]


def main() -> int:
    version = sys.argv[1].removeprefix("v") if len(sys.argv) == 2 else ""
    if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", version):
        print("用法：python tools/build_exe.py 1.8.0", file=sys.stderr)
        return 2

    # PyInstaller only warns about a missing hidden import and then ships a broken exe.
    sys.path.insert(0, str(ROOT))
    missing = [m for m in HIDDEN + COLLECT_ALL if importlib.util.find_spec(m) is None]
    if missing:
        print(f"缺少依赖：{', '.join(missing)}，请先 pip install -r requirements-build.txt", file=sys.stderr)
        return 1

    work = ROOT / "build"
    work.mkdir(exist_ok=True)
    stamp = work / "version.txt"
    stamp.write_text(version, encoding="utf-8")

    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--noconsole"]
    cmd += ["--name", f"EasySubStudio-v{version}", "--icon", str(ROOT / "icon.ico")]
    cmd += ["--distpath", str(ROOT / "dist"), "--workpath", str(work), "--specpath", str(work)]
    cmd += ["--add-data", f"{ROOT / 'ui'};ui", "--add-data", f"{stamp};."]
    opencv = Path(importlib.util.find_spec("cv2").origin).parent
    cmd += ["--add-data", f"{opencv / 'LICENSE*.txt'};licenses/OpenCV"]
    cmd += ["--collect-data", "faster_whisper"]
    for name in COLLECT_ALL:
        cmd += ["--collect-all", name]
    for name in HIDDEN:
        cmd += ["--hidden-import", name]
    for name in EXCLUDE:
        cmd += ["--exclude-module", name]
    subprocess.run([*cmd, str(ROOT / "app.py")], cwd=ROOT, check=True)

    exe = ROOT / "dist" / f"EasySubStudio-v{version}.exe"
    print(f"{exe}  {exe.stat().st_size / 1048576:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
