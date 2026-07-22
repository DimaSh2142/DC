#!/usr/bin/env python3
"""
2026-07-22, dima uploaded "Super Pixel Effects Gigapack (Free Version)
v2.7.0.zip" (Will Tice / unTied Games -- see the pack's own license.txt:
free for commercial/non-commercial use bundled with a game, credit required
in the credits, raw asset files must not be reuploaded/resold separately).

Packs a curated selection of that pack's frame-sequence animations into
single horizontal sprite-strip PNGs plus a JSON manifest under
public/img/effects/ -- see public/js/effects.js for the client-side player
that reads manifest.json and steps background-position across each strip.

Why pack instead of shipping the raw frameNNNN.png folders: each effect
ships as 8-50 tiny separate files -- fine for a game engine's asset
pipeline, wasteful as individual HTTP requests for this plain static-file
Node app with no build step. One PNG + one manifest entry per effect means
the browser makes exactly one request per effect. Same "process raw assets
into something web-ready, keep the raw source out of the repo" pattern as
the chess/checkers voxel textures (see renderVoxToPng.py in this folder).

This is a ONE-TIME, ad-hoc script (like renderVoxToPng.py) -- not part of
the running app, and not meant to be re-run automatically. Re-run it only if
you want to add/swap which effects are included. Requires the original zip
extracted somewhere locally first (the raw pack itself is intentionally NOT
committed to this repo -- 1196 loose frame files for 6 actually-used
effects isn't worth the repo bloat, same reasoning as _staging_assets/ in
.gitignore); update SRC_ROOT below to wherever you extracted it.
"""
import json
import os
from PIL import Image

SRC_ROOT = "PATH/TO/Super Pixel Effects Gigapack (Free Version)/PNG"  # <- update to your extracted copy
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'effects')

# key -> effect/variant folder (relative to SRC_ROOT) -- picked for variety
# of use (generic win / big win / capture-hit / loss / jackpot / dramatic
# bust) rather than trying to include everything in the pack. See
# public/js/effects.js for exactly which game moment fires which key.
EFFECTS = {
    "coin-burst":  "Magic Bursts/directional_coin_burst_001/directional_coin_burst_001_large_yellow",
    "firework":    "Magic Bursts/round_firework_burst_001/round_firework_burst_001_large_green",
    "impact":      "Impacts/symmetrical_impact_002/symmetrical_impact_002_large_blue",
    "poison":      "Fantasy Spells/status_poison_001/status_poison_001_large_green",
    "lightning":   "Lightning/lightning_burst_002/lightning_burst_002_large_violet",
    "explosion":   "Explosions/epic_explosion_001/epic_explosion_001_large_orange",
}

def pack(key, rel_path):
    src_dir = os.path.join(SRC_ROOT, rel_path)
    frames = sorted(f for f in os.listdir(src_dir) if f.startswith("frame") and f.endswith(".png"))
    if not frames:
        raise SystemExit(f"no frames found for {key} in {src_dir}")
    images = [Image.open(os.path.join(src_dir, f)).convert("RGBA") for f in frames]
    w, h = images[0].size
    for im in images:
        assert im.size == (w, h), f"{key}: frame size mismatch ({im.size} vs {(w, h)})"
    strip = Image.new("RGBA", (w * len(images), h), (0, 0, 0, 0))
    for i, im in enumerate(images):
        strip.paste(im, (i * w, 0))
    out_path = os.path.join(OUT_DIR, f"{key}.png")
    strip.save(out_path, optimize=True)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"{key}: {len(images)} frames @ {w}x{h} -> {out_path} ({size_kb:.1f} KB)")
    return {"frames": len(images), "w": w, "h": h}

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {}
    for key, rel_path in EFFECTS.items():
        manifest[key] = pack(key, rel_path)
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nmanifest written to {manifest_path}")

if __name__ == "__main__":
    main()
