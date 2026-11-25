# EasySub · 傻瓜双语字幕工坊 (EasySub Studio)

一款像 Aegisub 一样专业、但真正零门槛**“傻瓜式”**的中英双语字幕桌面客户端软件。无需背诵任何 `\fn`、`\3c`、`\blur`、`\r` 复杂特效代码，点点鼠标即可完成双语打轴、AI 听写翻译、美剧原盘级 `.ASS` 排版以及蓝光原盘 PGS (`.SUP`) 图形字幕压制。

## 核心特性

- **🎨 一键影视级双语样式模板（所见即所得）**
  - 默认内置 **美剧双语原盘风**（`WenQuanYi Micro Hei` 银灰白 `#B7B7B7` 93% 窄字宽 + `ITCAvantGardePro-Demi` 暖沙金 `#C0A783` 95% 字宽 + `\blur2` 柔边羽化 + `YCbCr Matrix: None` 防 HDR/杜比视界偏色），另含蓝光亮白、纪录片黑底沉浸盒、文艺电影、TED 高对比、英语学习主英辅中等共 6 套模板。
  - 支持可视化独立微调中英文各自的字体、字号、颜色、描边、阴影、字宽比例与柔边强度，16:9 画面实时 1:1 预览。
- **🖥️ 所见即所得的画面**
  - 预览按 libass 的字体度量排版，位置与大小和导出文件一致；可直接在画面上拖动字幕调高度、双击改词。
  - `Ctrl+K` 命令面板：搜功能、`#12` 跳句号、`1:30` 跳时间、搜台词。3000 句字幕也能满帧滚动与播放。
- **⚡ 声波时间轴 + 边打字边打轴快捷键**
  - 拖入音视频（`.mp4` / `.mkv` / `.mov` / `.avi` / `.mp3` / `.wav` 等）自动通过 FFmpeg 提取音频波形。
  - 光标在文本框内打字时依然可直接按：`F2` 播放/暂停、`F3` 设为本句开始、`F4` 设为本句结束并自动跳下一句、`F5` 单句重播；也可直接在声波条上用鼠标拖拽字幕块微调时间。
- **✨ AI 自动语音听写 + 双语互译**
  - **语音识别**：内置免费离线 `Faster-Whisper` 模型（自动适配显卡/CPU 与国内镜像下载），同时支持 OpenAI 兼容语音转写接口。
  - **双语翻译**：内置**免配置极速批量神经网络翻译**（无需 API Key 开箱即用），也支持配置 DeepSeek / OpenAI 等大模型结合上下文进行影视级精翻。
- **🩺 一键智能精修**
  - 先体检再修复：断句孤行合并或 AI 切分、清除听障音效 (SDH)、修平时间重叠、AI 补全漏译，一次完成且可整体撤销。
- **🧠 AI 影视精翻 Agent**
  - 六种内置人设与可微调提示词，三阶段全片术语自学习 + 上下文精翻；一键填入 DeepSeek / 硅基流动 / 通义千问 / OpenAI / Kimi / Ollama，可测试连接，配置自动保存在本机。
- **🧲 智能双语合并与纯文本成轴**
  - 导入已有双语 `.srt` / `.ass` 自动拆分中英两栏；支持将两份独立的单语字幕**按时间轴重叠智能对齐合并**；支持直接粘贴纯文本台词一键生成字幕行。
- **💿 专业级 `.ASS` / `.SRT` 导出与蓝光原盘 `.SUP` (PGS) 压制**
  - 导出 `1920x1080` 标准 `.ass`（采用主副样式 `{\r}` 内联重置，长句多行绝不发生中英文重叠）。
  - 内置 **ASS 转蓝光 PGS (`.sup`) 图形字幕引擎**（支持 `1080p` / `4K UHD` / `720p` 与 `23.976`–`59.94 fps`、支持同屏顶部注释+底部双语双窗口 PGS 编码、支持本地 `.ass` 多选整季批量直转 `.sup`），让芝杜、Infuse、Plex、Jellyfin 与蓝光碟机无需安装字体也能 100% 还原字幕特效。

---

## 环境要求与快速运行

1. 系统已安装 **Python 3.10+** 与 **FFmpeg**（需加入系统环境变量 `PATH`）。
2. 安装依赖：
   ```bash
   pip install -r requirements.txt
   ```
3. 启动桌面客户端：
   ```bash
   python app.py
   ```
   （Windows 下也可直接双击 `启动双语字幕工坊.bat` 无控制台黑框启动。）

## 打包独立单文件 `.exe`

```bash
pip install pyinstaller pillow
python -m PyInstaller --noconfirm --onefile --noconsole --name "傻瓜双语字幕工坊" --icon "icon.ico" --add-data "ui;ui" --collect-all webview --collect-all pythonnet --collect-all clr_loader --collect-data faster_whisper --hidden-import core.media_ai --hidden-import core.sup_export --hidden-import faster_whisper --hidden-import ctranslate2 --hidden-import onnxruntime --hidden-import httpx --hidden-import PIL.Image --exclude-module av --exclude-module cryptography --exclude-module hf_xet --exclude-module PIL._avif app.py
```

## 目录结构

- `app.py`：桌面端窗口容器（`pywebview` Edge WebView2）、懒加载后台预热、本地 `Range` 视频流服务器与原生文件对话框桥接
- `core/subtitles.py`：SRT/ASS/VTT/TXT 解析、中英智能拆分、v4.1 增强双语合轴、美剧标点清洗、智能拆句与 ASS/SRT 导出引擎
- `core/media_ai.py`：FFmpeg 声波峰值提取、无 PyAV 轻量离线 Faster-Whisper 语音识别、专有名词锁定与多引擎双语翻译服务
- `core/sup_export.py`：`libass` 矢量透明渲染 + 8-bit RGBA 调色板量化 + 蓝光 HDMV PGS (`.sup`) RLE 双窗口编码器
- `ui/index.html`：桌面界面骨架与图标
- `ui/css/`：设计变量（`tokens.css`）与各区域样式；浅色 / 深色、四套氛围色都从同一组变量派生
- `ui/js/`：原生 ES 模块，无需构建。`store.js` 状态与撤销、`subs-render.js` 与 libass 对齐的字幕预览、`timeline.js` 时间轴、`script.js` 虚拟台词列表、`palette.js` 命令面板
- `ui/fonts/`：界面用的思源黑体 / 思源宋体子集（SIL OFL 1.1，见 `OFL.txt`）
