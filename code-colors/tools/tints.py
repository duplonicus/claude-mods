"""WCAG contrast of every palette color on the diff tints, read from hooks/highlight.ts and hooks/diff.ts.

python3 tools/tints.py [palette]   (default: the DEFAULT_PALETTE in highlight.ts)
"""
import re
import sys
from pathlib import Path

HOOKS = Path(__file__).resolve().parent.parent / "hooks"


def luminance(hex_color):
    def channel(c):
        c = int(c, 16) / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(hex_color[i:i + 2]) for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def palette(name):
    block = re.search(rf"\n  {name}: \{{(.*?)\n  \}}", (HOOKS / "highlight.ts").read_text(), re.S).group(1)
    return dict(re.findall(r"(\w+): '(#[0-9A-Fa-f]{6})'", block))


def tints():
    text = (HOOKS / "diff.ts").read_text()
    out = {}
    for const in ("DIFF_TINT", "CHANGED_WORD_TINT"):
        body = re.search(rf"{const}[^=]*= \{{([^}}]*)\}}", text).group(1)
        for kind, color in re.findall(r"(add|remove): '(#[0-9A-Fa-f]{6})'", body):
            out[f"{const}.{kind}"] = color
    return out


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else re.search(
        r"DEFAULT_PALETTE: PaletteName = '(\w+)'", (HOOKS / "highlight.ts").read_text()).group(1)
    colors, backgrounds = palette(name), tints()
    print(f"palette {name}")
    print(f"{'':10}" + "".join(f"{k:>26}" for k in backgrounds))
    for kind, color in colors.items():
        print(f"{kind:10}" + "".join(f"{contrast(color, bg):>26.2f}" for bg in backgrounds.values()))
