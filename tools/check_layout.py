"""Verify how the exported ASS places the upper bilingual event.

`line_gap` is a visible pixel gap: the upper event's MarginV is
`lowerMarginV + lowerLines × lowerFontSize - lowerInkTop - upperInkBottom + gap + 1`
when the preview supplies the per-cue ink padding, and a font-ratio approximation when it
does not. BorderStyle 3 measures between the drawn boxes instead. This script checks that
arithmetic for every built-in preset, both language orders, box mode, wrapped lines and
per-cue overrides.

    python tools/check_layout.py
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.subtitles import DEFAULT_PRESETS, export_ass  # noqa: E402

ZH = "这是一句中文测试台词"
EN = "This is an English test line"
LONG_EN = "This is a deliberately long English subtitle line that should wrap onto a second row of text"
LONG_ZH = (
    "这是一句故意写得很长的中文测试台词用来确认换行之后上行位置仍然保持精确的间距"
    "并且第二行也不会把两行字幕之间的距离挤掉哪怕一个像素"
)
HINT = [10.5, 8.25]


def styles(ass: str) -> dict[str, dict]:
    found = {}
    for line in ass.splitlines():
        if not line.startswith("Style:"):
            continue
        parts = line[len("Style: "):].split(",")
        found[parts[0]] = {
            "size": int(parts[2]),
            "border": int(parts[15]),
            "outline": float(parts[16]),
            "margin_v": int(parts[21]),
        }
    return found


def events(ass: str) -> list[dict]:
    found = []
    for line in ass.splitlines():
        if not (line.startswith("Dialogue: 0,") or line.startswith("Dialogue: 1,")):
            continue
        parts = line.split(",")
        found.append(
            {
                "layer": int(parts[0].split(":")[1]),
                "style": parts[3],
                "margin_v": int(parts[7]),
            }
        )
    return found


def cue(zh: str = ZH, en: str = EN, **extra) -> dict:
    return {"start_ms": 0, "end_ms": 3000, "zh": zh, "en": en, **extra}


def two_events(name: str, style: dict, item: dict, ink: list | None) -> tuple[dict, dict, str]:
    ass = export_ass([item], style, "bilingual", "layout check", ink=[ink] if ink else None)
    st, ev = styles(ass), events(ass)
    if len(ev) != 2:
        raise AssertionError(f"{name}: 预期两条事件，实际 {len(ev)} 条")
    upper = next(e for e in ev if e["layer"] == 1)
    lower = next(e for e in ev if e["layer"] == 0)
    return upper, lower, st


def check_hint(name: str, style: dict, item: dict, hint: list, expected_gap: int | None = None) -> bool:
    upper, lower, st = two_events(name, style, item, hint)
    lower_style = st[lower["style"]]
    gap = int(round(float(style.get("line_gap", 4)))) if expected_gap is None else expected_gap
    t, b = hint
    span = upper["margin_v"] - lower["margin_v"] + t + b - gap - 1
    lines, remainder = divmod(int(round(span)), lower_style["size"])
    ok = remainder == 0 and lines >= 1 and lower["margin_v"] == lower_style["margin_v"]
    detail = (
        f"上行 MV {upper['margin_v']} = 下行 {lower['margin_v']} + {lines} 行 × {lower_style['size']} "
        f"- 墨迹 {t:g} - {b:g} + 间距 {gap} + 1"
    )
    print(("通过  " if ok else "失败  ") + name + ("  " + detail if ok else f"  {detail} (span={span})"))
    return ok


def check_box(name: str, style: dict, item: dict) -> bool:
    upper, lower, st = two_events(name, style, item, None)
    up_style, lower_style = st[upper["style"]], st[lower["style"]]
    gap = int(round(float(style.get("line_gap", 4))))
    pad = up_style["outline"] + lower_style["outline"]
    span = upper["margin_v"] - lower["margin_v"] - pad - gap
    lines, remainder = divmod(int(round(span)), lower_style["size"])
    ok = remainder == 0 and lines >= 1
    detail = (
        f"上行 MV {upper['margin_v']} = 下行 {lower['margin_v']} + {lines} 行 × {lower_style['size']} "
        f"+ 盒边 {pad:g} + 间距 {gap}"
    )
    print(("通过  " if ok else "失败  ") + name + ("  " + detail if ok else f"  {detail} (span={span})"))
    return ok


def check_fallback(name: str, style: dict, item: dict, order: str) -> bool:
    upper, lower, st = two_events(name, style, item, None)
    up_size = st[upper["style"]]["size"]
    lower_size = st[lower["style"]]["size"]
    gap = int(round(float(style.get("line_gap", 4))))
    extra = 0.25 * lower_size + 0.10 * up_size if order == "zh_top" else 0.14 * lower_size + 0.02 * up_size
    want = max(0, int(round(lower["margin_v"] + lower_size - extra + gap)))
    ok = upper["margin_v"] == want
    print(("通过  " if ok else "失败  ") + name + f"  上行 MV {upper['margin_v']}（期望 {want}，无预览提示时的回退）")
    return ok


def check_classic_bluray(style: dict) -> bool:
    ass = export_ass([cue()], style, ink=[HINT])
    expected_styles = (
        "Style: chs,方正黑体_GBK,66,&H00DBDBDB,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,145,1",
        "Style: eng,Tahoma,45,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,1,1,2,10,10,20,1",
    )
    ok = all(line in ass.splitlines() for line in expected_styles)
    ok &= "YCbCr Matrix: None" in ass and r"\blur" not in ass
    ok &= {event["style"]: event["margin_v"] for event in events(ass)} == {"chs": 145, "eng": 20}
    for mode, margin in (("zh_only", 145), ("en_only", 20)):
        single = events(export_ass([cue()], style, lang_mode=mode))
        ok &= len(single) == 1 and single[0]["margin_v"] == margin
    # Applying this preset to one cue must keep its independent margins.
    override = cue(style_override=style)
    rows = events(export_ass([override], DEFAULT_PRESETS[0], ink=[HINT]))
    ok &= {event["layer"]: event["margin_v"] for event in rows} == {0: 20, 1: 145}
    print(("通过  " if ok else "失败  ") + "经典蓝光保留原 ASS 样式与距底位置")
    return ok


def main() -> int:
    results = []

    for preset in DEFAULT_PRESETS:
        style = copy.deepcopy(preset)
        if style.get("line_gap_mode") == "ass_margin":
            results.append(check_classic_bluray(style))
        elif style.get("box_mode"):
            results.append(check_box(preset["name"] + " · 黑底盒", style, cue()))
        else:
            results.append(check_hint(preset["name"], style, cue(), HINT))

    results.append(check_hint("默认模板 · 英文折行", copy.deepcopy(DEFAULT_PRESETS[0]), cue(en=LONG_EN), HINT))
    results.append(check_hint("默认模板 · 中文折行", copy.deepcopy(DEFAULT_PRESETS[0]), cue(zh=LONG_ZH), HINT))
    results.append(check_hint("英语学习 · 英文在上", copy.deepcopy(DEFAULT_PRESETS[5]), cue(), HINT))

    override = copy.deepcopy(DEFAULT_PRESETS[0])
    results.append(
        check_hint(
            "本句覆盖（间距 12 / 字号 80+40）",
            override,
            cue(style_override={"line_gap": 12, "zh": {"size": 80}, "en": {"size": 40}}),
            HINT,
            expected_gap=12,
        )
    )

    negative = copy.deepcopy(DEFAULT_PRESETS[0])
    negative["line_gap"] = -6
    results.append(check_hint("负间距（-6）", negative, cue(), HINT))

    results.append(check_fallback("无预览提示 · 中文在上", copy.deepcopy(DEFAULT_PRESETS[0]), cue("你好", "Hi"), "zh_top"))

    learner = copy.deepcopy(DEFAULT_PRESETS[5])
    results.append(check_fallback("无预览提示 · 英文在上", learner, cue("你好", "Hi"), "en_top"))

    ok = sum(results)
    print(f"\n{ok}/{len(results)} 项通过")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
