"""启动打好的 exe，确认窗口、界面、后端和打包进去的模块都正常，再让它自己退出。

    python tools/smoke_test.py dist/EasySubStudio-v1.8.0.exe [截图.png]

数据写到临时目录，不碰 %LOCALAPPDATA% 里的真实设置。只用标准库。
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import winreg
from pathlib import Path

START_TIMEOUT = 120  # a onefile exe unpacks itself first, which is slow on a cold machine
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Page:
    """Just enough of the DevTools protocol to evaluate expressions in the window."""

    def __init__(self, ws_url: str) -> None:
        host, port, path = re.fullmatch(r"ws://([^:/]+):(\d+)(/.*)", ws_url).groups()
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall(
            (
                f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self._more()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(f"DevTools 握手失败：{head[:120]!r}")
        self.seq = 0
        self.errors: list[str] = []
        self.call("Runtime.enable")

    def _more(self) -> None:
        chunk = self.sock.recv(1 << 16)
        if not chunk:
            raise RuntimeError("窗口意外断开，程序可能已经崩溃")
        self.buf += chunk

    def _take(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._more()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode: int, data: bytes) -> None:
        mask = secrets.token_bytes(4)
        n = len(data)
        if n < 126:
            size = bytes([0x80 | n])
        elif n < 65536:
            size = bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            size = bytes([0x80 | 127]) + struct.pack(">Q", n)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes([0x80 | opcode]) + size + mask + body)

    def _message(self) -> dict:
        whole = b""
        while True:
            first, second = self._take(2)
            n = second & 0x7F
            if n == 126:
                (n,) = struct.unpack(">H", self._take(2))
            elif n == 127:
                (n,) = struct.unpack(">Q", self._take(8))
            data, opcode = self._take(n), first & 0x0F
            if opcode == 9:
                self._send(10, data)
            elif opcode == 8:
                raise RuntimeError("窗口关闭了调试连接")
            elif opcode in (0, 1):
                whole += data
                if first & 0x80:
                    return json.loads(whole)

    def call(self, method: str, **params) -> dict:
        self.seq += 1
        self._send(1, json.dumps({"id": self.seq, "method": method, "params": params}).encode())
        while True:
            msg = self._message()
            if msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                self.errors.append(d.get("exception", {}).get("description") or d.get("text", ""))
            elif msg.get("method") == "Runtime.consoleAPICalled" and msg["params"]["type"] == "error":
                self.errors.append(" ".join(str(a.get("value") or a.get("description")) for a in msg["params"]["args"]))
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]

    def ev(self, js: str):
        r = self.call("Runtime.evaluate", expression=js, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", "脚本出错"))
        return r["result"].get("value")


def allow_debugging_in_ci(exe: Path, port: int) -> None:
    """CI runs elevated, where WebView2 ignores the environment variable and only obeys machine
    policy. Set it for this one exe name; the machine is thrown away after the run."""
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    key = r"SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
    with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, exe.name, 0, winreg.REG_SZ, f"--remote-debugging-port={port}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_page(port: int, proc: subprocess.Popen) -> str:
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"程序启动后立刻退出，退出码 {proc.returncode}")
        try:
            with NO_PROXY.open(f"http://127.0.0.1:{port}/json/list", timeout=3) as r:
                for target in json.load(r):
                    if target.get("type") == "page" and "index.html" in target.get("url", ""):
                        return target["webSocketDebuggerUrl"]
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"{START_TIMEOUT} 秒内没有出现程序窗口")


def close_window(proc: subprocess.Popen) -> None:
    """Close the real window (a child of the onefile launcher), never another running copy."""
    script = (
        f"Get-CimInstance Win32_Process -Filter 'ParentProcessId={proc.pid}' | "
        "ForEach-Object { [void](Get-Process -Id $_.ProcessId).CloseMainWindow() }"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, timeout=60)


def diagnose(shot: Path | None) -> None:
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(Path(__file__).with_name("diagnose.ps1"))]
    if shot:
        cmd += ["-Shot", str(shot.resolve())]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=120)
    print(r.stdout + r.stderr, flush=True)


def main() -> int:
    exe = Path(sys.argv[1]).resolve()
    shot = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    version = re.search(r"-v(.+)\.exe$", exe.name).group(1)
    failed: list[str] = []

    def check(name: str, ok: object, detail: object = "") -> None:
        print(("通过  " if ok else "失败  ") + name + ("" if ok else f"  {detail}"), flush=True)
        if not ok:
            failed.append(name)

    port = free_port()
    allow_debugging_in_ci(exe, port)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as data:
        env = {
            **os.environ,
            "LOCALAPPDATA": data,
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": f"--remote-debugging-port={port}",
        }
        t0 = time.time()
        proc = subprocess.Popen([str(exe)], env=env)
        try:
            page = Page(find_page(port, proc))
            label = ""
            while time.time() - t0 < START_TIMEOUT:
                label = page.ev("document.getElementById('appVersion')?.textContent || ''")
                if label not in ("", "EasySub Studio"):
                    break
                time.sleep(0.5)
            print(f"窗口就绪，用时 {time.time() - t0:.1f} 秒", flush=True)

            check("界面脚本运行完成", page.ev("document.documentElement.classList.contains('ready')"))
            check("版本号与文件名一致", label == f"EasySub Studio v{version}", label)
            check("后端返回字幕模板", page.ev("document.querySelectorAll('.preset').length") >= 6)
            fonts = page.ev(
                "document.fonts.ready.then(() => "
                "[...document.fonts].filter(f => f.status === 'loaded').map(f => f.family).join())"
            )
            check("自带字体已加载", "EasySub" in fonts, fonts)
            cues = "[{id:1,start_ms:0,end_ms:900,zh:'你好，世界。',en:'Hi'}]"
            r = page.ev(f"window.pywebview.api.clean_us_drama_punctuation({cues})")
            check("字幕处理可用", isinstance(r, dict) and r.get("ok"), r)
            r = page.ev("window.pywebview.api.test_llm_connection({llm_base:'http://127.0.0.1:9',llm_key:'x',llm_model:'y'})")
            check("AI 模块可用（连不上时给出正常提示）", isinstance(r, dict) and r.get("ok") is False and r.get("error"), r)
            page.ev("window.pywebview.api.update_user_settings({smoke_test: 1})")
            saved = Path(data) / "EasySubStudio" / "settings.json"
            check("设置写入用户数据目录", saved.exists() and json.loads(saved.read_text("utf-8")).get("smoke_test") == 1)
            if shot:
                time.sleep(1.5)
                shot.write_bytes(base64.b64decode(page.call("Page.captureScreenshot", format="png")["data"]))
            check("界面没有报错", not page.errors, page.errors)

            close_window(proc)
            try:
                check("能正常退出", proc.wait(30) == 0, f"退出码 {proc.returncode}")
            except subprocess.TimeoutExpired:
                check("能正常退出", False, "关闭窗口 30 秒后仍在运行")
        except Exception as err:  # any failure here means the exe must not ship
            check("试运行", False, err)
            diagnose(shot)
        finally:
            if proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)

    print("全部通过" if not failed else f"{len(failed)} 项失败：{'、'.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
