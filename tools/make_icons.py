"""
Draw the app icon (a plate with three macro bars) as PNGs for the web app manifest.
Pure Python, no image library: each shape is a "signed distance" function, and a
pixel's coverage is how far inside the shape its centre is (that gives smooth edges).

    .venv\\Scripts\\python tools\\make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).parent.parent / "web" / "icons"

BACKGROUND = (23, 107, 87)
PLATE = (255, 255, 255)
PLATE_INNER = (226, 241, 235)
BARS = [  # (x centre, height, colour) in units of the icon size; protein, carbs, fat
    (-0.10, 0.20, (23, 107, 87)),
    (0.00, 0.28, (242, 163, 58)),
    (0.10, 0.14, (224, 96, 74)),
]


def rounded_box(px, py, cx, cy, half_w, half_h, radius):
    """Signed distance to a rounded rectangle (negative = inside)."""
    qx = abs(px - cx) - half_w + radius
    qy = abs(py - cy) - half_h + radius
    outside = math.hypot(max(qx, 0), max(qy, 0))
    return outside + min(max(qx, qy), 0) - radius


def render(size):
    def blend(base, colour, alpha):
        return tuple(round(b + (c - b) * alpha) for b, c in zip(base, colour))

    rows = []
    for y in range(size):
        row = bytearray([0])                        # PNG filter byte: none
        for x in range(size):
            # Coordinates in icon units, centre = (0, 0), edges at +-0.5
            u, v = (x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5
            pixel_units = 1 / size
            cover = lambda d: min(max(0.5 - d / pixel_units, 0), 1)

            colour = BACKGROUND
            r = math.hypot(u, v)
            colour = blend(colour, PLATE, cover(r - 0.34))           # plate rim
            colour = blend(colour, PLATE_INNER, cover(r - 0.27))     # plate centre
            bottom = 0.15
            for bx, height, bar_colour in BARS:
                d = rounded_box(u, v, bx, bottom - height / 2, 0.035, height / 2, 0.02)
                colour = blend(colour, bar_colour, cover(d))
            row += bytes(colour) + b"\xff"
        rows.append(bytes(row))
    return png_bytes(size, b"".join(rows))


def png_bytes(size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)   # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)):
        (OUT_DIR / name).write_bytes(render(size))
        print("wrote", OUT_DIR / name)
