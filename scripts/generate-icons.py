#!/usr/bin/env python3
"""Generate PWA / Apple touch icons from icon-source.png.

The source is a product photo of the watermelon plushie on a white
background. We tight-crop around the plushie, then center it on a
cream canvas (matching the app theme) so the result looks like a
proper app icon instead of a stretched photo.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "icons" / "icon-source.png"
OUT_DIR = ROOT / "public" / "icons"

BG = (255, 255, 255, 255)   # white — clean app icon
CANVAS = 1024
PLUSHIE_FILL = 0.78         # plushie bbox width as fraction of canvas
VERTICAL_BIAS = -0.02       # negative = nudge up slightly so the legs sit lower


def find_bbox(im: Image.Image, threshold: int = 240) -> tuple[int, int, int, int]:
    """Find bbox of non-white pixels in an RGB(A) image."""
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    left, top, right, bottom = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r < threshold or g < threshold or b < threshold:
                if x < left: left = x
                if y < top: top = y
                if x > right: right = x
                if y > bottom: bottom = y
    if right < left or bottom < top:
        return (0, 0, w, h)
    return (left, top, right + 1, bottom + 1)


def remap_white_to_alpha(im: Image.Image) -> Image.Image:
    """Replace near-white pixels with transparency so the plushie
    floats on whatever background we composite it onto.

    Soft threshold: brightness >= 248 → fully transparent,
    brightness <= 232 → fully opaque, linear in between to avoid
    a hard edge around the plushie's soft fuzz."""
    rgba = im.convert("RGBA").copy()
    px = rgba.load()
    w, h = rgba.size
    HI, LO = 248, 232
    span = HI - LO
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            m = min(r, g, b)  # min channel — robust to slight color cast
            if m >= HI:
                px[x, y] = (r, g, b, 0)
            elif m > LO:
                a = int(255 * (HI - m) / span)
                px[x, y] = (r, g, b, a)
    return rgba


def build_master() -> Image.Image:
    src = Image.open(SRC).convert("RGBA")
    bbox = find_bbox(src)
    cropped = src.crop(bbox)
    cropped = remap_white_to_alpha(cropped)
    cw, ch = cropped.size

    target_w = int(CANVAS * PLUSHIE_FILL)
    scale = target_w / cw
    new_w = target_w
    new_h = int(ch * scale)
    resized = cropped.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), BG)
    x = (CANVAS - new_w) // 2
    y = (CANVAS - new_h) // 2 + int(CANVAS * VERTICAL_BIAS)
    canvas.paste(resized, (x, y), resized)
    return canvas


def main() -> None:
    master = build_master()
    sizes = {
        "icon-192.png": 192,
        "icon-512.png": 512,
        "apple-touch-icon.png": 180,
        "favicon.png": 180,
        "favicon-32.png": 32,
        "favicon-16.png": 16,
    }
    for name, size in sizes.items():
        out = master.resize((size, size), Image.LANCZOS).convert("RGB")
        out.save(OUT_DIR / name, "PNG", optimize=True)
        print(f"  wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
