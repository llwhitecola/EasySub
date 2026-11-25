"""生成 Release 的标题和正文。

    python tools/release_notes.py 1.8.0 dist/EasySubStudio-v1.8.0.exe 输出目录

读取 release-notes/v1.8.0.md：第一行 `# 标题` 是 Release 标题，其余是正文。
没有这个文件时，用上一个标签以来的提交记录代替。下载说明和 SHA-256 自动加在末尾。
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    return r.stdout.strip() if r.returncode == 0 else ""


def main() -> int:
    version, exe, out = sys.argv[1].removeprefix("v"), Path(sys.argv[2]), Path(sys.argv[3])
    title, body = f"EasySub Studio v{version}", ""

    notes = ROOT / "release-notes" / f"v{version}.md"
    if notes.exists():
        body = notes.read_text(encoding="utf-8-sig").strip()
        if body.startswith("# "):
            first, _, body = body.partition("\n")
            title = first[2:].strip()
    else:
        since = git("describe", "--tags", "--abbrev=0", "HEAD^")
        log = git("log", "--no-merges", "--format=- %s", f"{since}..HEAD" if since else "HEAD")
        body = f"### 更新内容\n\n{log}" if log else ""

    sha = hashlib.sha256(exe.read_bytes()).hexdigest()
    body += (
        f"\n\n### 下载\n\n下载下方 `{exe.name}`，免安装，双击即开（Windows 10 / 11 64 位）。\n\n"
        "声波提取、AI 听写、特殊格式视频预览和蓝光 SUP 压制需要系统已安装 FFmpeg 并加入 PATH。\n\n"
        f"SHA-256：`{sha}`\n"
    )

    out.mkdir(parents=True, exist_ok=True)
    (out / "title.txt").write_text(title, encoding="utf-8")
    (out / "notes.md").write_text(body.lstrip(), encoding="utf-8")
    print(title)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
