#!/usr/bin/env python3
"""
Renders MagicaVoxel .vox models to transparent top-down PNG sprites.

Why this exists: dima's "boardgames-vox" asset pack (2026-07-22 batch, see
_staging_assets/2026-07-22/boardgames-vox/) ships raw .vox voxel models, not
images -- there's no way to <img src="..."> a .vox file directly. This is a
minimal, dependency-free .vox parser (RIFF-style chunks: SIZE for the
model's x/y/z bounding box, XYZI for each voxel's position + a 1-255 palette
index, RGBA for the model's own 256-color palette) plus a simple TOP-DOWN
renderer: for every (x, y) column, take the color of the HIGHEST z voxel
(a z-buffer with only one layer, since we only care about what's visible
looking straight down) and draw that as one pixel. This suits checkers
pieces well specifically -- they're short, disc-shaped tokens meant to be
seen from directly above on a 2D board, exactly how this app already
displays them (see public/js/checkers.js) -- so a full 3D/isometric render
would add complexity for a look nobody would actually see edge-on.

Usage: python3 renderVoxToPng.py <input.vox> <output.png> [pixel_size]
  pixel_size: final square output size in px (default 128), nearest-
  neighbor upscaled from the model's native resolution so it stays crisp
  pixel art rather than blurring, matching the same
  image-rendering:pixelated treatment as the Phase 5 chess sprites.

Requires: Pillow (already a dependency in this sandbox; no other packages).
"""
import struct
import sys
from PIL import Image


def read_vox(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'VOX ':
        raise ValueError(path + ' is not a .vox file (missing VOX  magic bytes)')
    i = 8  # skip "VOX " + 4-byte version
    cid, csize, ccsize = struct.unpack('<4sII', data[i:i + 12])
    if cid != b'MAIN':
        raise ValueError(path + ': expected a MAIN chunk first')
    i += 12
    end = i + csize + ccsize
    size = None
    voxels = []
    palette = None
    while i < end:
        cid, csize, ccsize = struct.unpack('<4sII', data[i:i + 12])
        content_start = i + 12
        if cid == b'SIZE':
            size = struct.unpack('<3i', data[content_start:content_start + 12])
        elif cid == b'XYZI':
            n = struct.unpack('<i', data[content_start:content_start + 4])[0]
            off = content_start + 4
            for _ in range(n):
                x, y, z, c = struct.unpack('<4B', data[off:off + 4])
                voxels.append((x, y, z, c))
                off += 4
        elif cid == b'RGBA':
            palette = []
            off = content_start
            for _ in range(256):
                r, g, b, a = struct.unpack('<4B', data[off:off + 4])
                palette.append((r, g, b, a))
                off += 4
        i = content_start + csize + ccsize
    if size is None or not voxels:
        raise ValueError(path + ': missing SIZE or XYZI chunk (empty/corrupt model?)')
    return size, voxels, palette


# MagicaVoxel's built-in default palette, used when a model has no custom
# RGBA chunk of its own. Every model in dima's pack DOES ship its own RGBA
# chunk (confirmed while building this script), so this is only a defensive
# fallback -- but 256 hardcoded fallback colors would bloat this file for a
# path that never actually runs on the real asset set, so it just falls
# back to opaque mid-gray per voxel instead of reproducing the full palette.
def palette_lookup(palette, color_index):
    if palette is not None:
        return palette[color_index - 1] if 1 <= color_index <= 256 else (128, 128, 128, 255)
    return (128, 128, 128, 255)


def render_top_down(size, voxels, palette, pixel_size=128):
    sx, sy, sz = size
    # z-buffer keyed by (x, y): keep whichever voxel has the greatest z
    # (highest = closest to a camera looking straight down from above).
    top = {}
    for x, y, z, c in voxels:
        key = (x, y)
        if key not in top or z > top[key][0]:
            top[key] = (z, c)

    img = Image.new('RGBA', (sx, sy), (0, 0, 0, 0))
    px = img.load()
    for (x, y), (z, c) in top.items():
        r, g, b, a = palette_lookup(palette, c)
        # image row 0 is the TOP of the picture; vox y grows "away from the
        # viewer" -- flip so the piece isn't rendered mirrored top/bottom.
        px[x, sy - 1 - y] = (r, g, b, a if a else 255)

    return img.resize((pixel_size, pixel_size), Image.NEAREST)


def main():
    if len(sys.argv) < 3:
        print('Usage: renderVoxToPng.py <input.vox> <output.png> [pixel_size]')
        sys.exit(1)
    in_path, out_path = sys.argv[1], sys.argv[2]
    pixel_size = int(sys.argv[3]) if len(sys.argv) > 3 else 128
    size, voxels, palette = read_vox(in_path)
    img = render_top_down(size, voxels, palette, pixel_size)
    img.save(out_path)
    print('Rendered %s (%d voxels, native %dx%dx%d) -> %s @ %dpx' % (
        in_path, len(voxels), size[0], size[1], size[2], out_path, pixel_size))


if __name__ == '__main__':
    main()
