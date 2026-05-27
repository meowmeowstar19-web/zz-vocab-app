#!/usr/bin/env python3
"""Generate PWA / Apple touch icons from icon-source.png.

App-surface icons (apple-touch-icon, favicon.png, icon-192, icon-512)
are composed as: white rounded tile (iOS 22.37% radius, transparent
outside) + watermelon inset to 78% of the canvas. This matches the
visual proportions of native macOS Dock icons (Chrome, WeChat etc.),
where content sits inside the tile with ~20% padding.

Browser-tab favicons (favicon-16/32) stay full-bleed square — at that
size, rounded corners and insets just blur the recognisable shape.
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "icons" / "icon-source.png"
OUT_DIR = ROOT / "public" / "icons"

# Apple's macOS Big Sur+ icon template: tile fills ~80% of the 1024 canvas,
# with ~10% transparent padding all around. Corner radius is ~22.5% of the tile.
TILE_FILL = 0.82            # rounded tile as fraction of canvas
CONTENT_FILL_IN_TILE = 1.00 # watermelon fills the tile edge-to-edge (matches icon-source)
TILE_RADIUS_RATIO = 0.2237  # corner radius as fraction of tile side
TILE_BG = (255, 255, 255, 255)


def build_tile_icon(src: Image.Image, size: int) -> Image.Image:
    """Rounded white tile inside a transparent canvas, watermelon inset in the tile.

    Matches Apple's icon template proportions so the result sits flush with
    other macOS Dock icons instead of looking oversized.
    """
    tile_side = int(round(size * TILE_FILL))
    inner = int(round(tile_side * CONTENT_FILL_IN_TILE))
    watermelon = src.resize((inner, inner), Image.LANCZOS)

    tile = Image.new("RGBA", (tile_side, tile_side), TILE_BG)
    tile_off = (tile_side - inner) // 2
    tile.paste(watermelon, (tile_off, tile_off),
               watermelon if watermelon.mode == "RGBA" else None)

    radius = int(round(tile_side * TILE_RADIUS_RATIO))
    mask = Image.new("L", (tile_side, tile_side), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tile_side, tile_side), radius=radius, fill=255)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas_off = (size - tile_side) // 2
    canvas.paste(tile, (canvas_off, canvas_off), mask)
    return canvas


def build_favicon_tab(src: Image.Image, size: int) -> Image.Image:
    """Plain resized square on white for browser tab favicons."""
    resized = src.resize((size, size), Image.LANCZOS)
    flat = Image.new("RGB", (size, size), (255, 255, 255))
    flat.paste(resized, (0, 0), resized if resized.mode == "RGBA" else None)
    return flat


def main() -> None:
    src = Image.open(SRC).convert("RGBA")

    # name -> (size, kind)  kind: "tile" = rounded+inset, "tab" = flat square
    targets = {
        "icon-192.png":         (192, "tile"),
        "icon-512.png":         (512, "tile"),
        "apple-touch-icon.png": (180, "tile"),
        "favicon.png":          (180, "tile"),
        "favicon-32.png":       (32,  "tab"),
        "favicon-16.png":       (16,  "tab"),
    }

    for name, (size, kind) in targets.items():
        if kind == "tile":
            out = build_tile_icon(src, size)
        else:
            out = build_favicon_tab(src, size)
        out.save(OUT_DIR / name, "PNG", optimize=True)
        print(f"  wrote {name} ({size}x{size}, {kind})")


if __name__ == "__main__":
    main()
