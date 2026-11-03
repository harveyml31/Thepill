"""Generate The Pill's icons (app icon + tray icons) with Pillow.

Run: python3 scripts/make-icons.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)
CLAY = (217, 119, 87, 255)      # warm terracotta
INK = (31, 30, 29, 255)
WATCH = (229, 72, 77, 255)


def spark(draw, cx, cy, r, color, rays=8, width_ratio=0.17):
    """Rounded multi-ray asterisk."""
    w = max(2, int(r * width_ratio * 2))
    for i in range(rays):
        a = math.pi * 2 * i / rays + math.pi / rays
        inner = r * 0.12
        x1, y1 = cx + math.cos(a) * inner, cy + math.sin(a) * inner
        x2, y2 = cx + math.cos(a) * r, cy + math.sin(a) * r
        draw.line([(x1, y1), (x2, y2)], fill=color, width=w)
        draw.ellipse([x2 - w / 2, y2 - w / 2, x2 + w / 2, y2 + w / 2], fill=color)
    draw.ellipse([cx - w * 0.8, cy - w * 0.8, cx + w * 0.8, cy + w * 0.8], fill=color)


def app_icon(size=1024):
    s = 4  # supersample
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * s * 0.06
    d.rounded_rectangle([pad, pad, size * s - pad, size * s - pad], radius=size * s * 0.23, fill=INK)
    spark(d, size * s / 2, size * s / 2, size * s * 0.30, CLAY)
    return img.resize((size, size), Image.LANCZOS)


def tray_icon(size, watching):
    s = 8
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    spark(d, size * s / 2, size * s / 2, size * s * 0.42, CLAY, width_ratio=0.2)
    if watching:
        r = size * s * 0.2
        cx, cy = size * s - r - 2, size * s - r - 2
        d.ellipse([cx - r - s, cy - r - s, cx + r + s, cy + r + s], fill=(255, 255, 255, 255))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WATCH)
    return img.resize((size, size), Image.LANCZOS)


app_icon(1024).save(OUT / "icon.png")
app_icon(256).save(OUT / "icon-256.png")
for watching, name in ((False, "tray"), (True, "tray-watching")):
    tray_icon(16, watching).save(OUT / f"{name}.png")
    tray_icon(32, watching).save(OUT / f"{name}@2x.png")
print("icons written to", OUT)
