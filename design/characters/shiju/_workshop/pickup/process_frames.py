#!/usr/bin/env python3
"""Scale rembg 720x720 RGBA frames with fixed viewport into 180x240 webp tracks."""
from pathlib import Path
from PIL import Image
import json

SCALE = 0.4081237911025145
SRC = 720
SCALED = round(SRC * SCALE)  # 294
VX = round(360 * SCALE - 90)  # 57
VY = round(153 * SCALE - 17)  # 45
VW, VH = 180, 240

def fit_frame(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    scaled = im.resize((SCALED, SCALED), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (VW, VH), (0, 0, 0, 0))
    canvas.paste(scaled, (-VX, -VY), scaled)
    return canvas

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--tracks", required=True)
    ap.add_argument("--preview-dir", required=True)
    args = ap.parse_args()
    src = Path(args.src)
    tracks = Path(args.tracks)
    preview = Path(args.preview_dir)
    tracks.mkdir(parents=True, exist_ok=True)
    preview.mkdir(parents=True, exist_ok=True)

    files = sorted(src.glob("*.png"))
    files = [f for f in files if f.stem.isdigit()]
    assert len(files) == 193, f"expected 193 got {len(files)}"
    print(f"scale={SCALE} scaled={SCALED} viewport=({VX},{VY},{VW},{VH}) n={len(files)}", flush=True)

    outs = []
    for i, f in enumerate(files, start=1):
        im = Image.open(f)
        out = fit_frame(im)
        name = f"frame{i:03d}.webp"
        path = tracks / name
        out.save(path, "WEBP", lossless=True, quality=100, method=6)
        outs.append(out)
        if i in (1, 193) or i % 20 == 0:
            print(f"  wrote {name} {out.size} {out.mode}", flush=True)

    preview_path = preview / "all_in_one.webp"
    outs[0].save(
        preview_path,
        "WEBP",
        save_all=True,
        append_images=outs[1:],
        duration=int(1000 / 24),
        loop=0,
        lossless=True,
        quality=100,
        method=4,
    )
    print(f"preview -> {preview_path} frames={len(outs)} fps=24", flush=True)

    idxs = [1, 36, 37, 72, 73, 132, 133, 193]
    cells = [outs[idx - 1].copy() for idx in idxs]
    sheet = Image.new("RGBA", (VW * len(cells), VH), (40, 40, 48, 255))
    for i, c in enumerate(cells):
        bg = Image.new("RGBA", c.size, (40, 40, 48, 255))
        bg.alpha_composite(c)
        sheet.paste(bg.convert("RGB"), (i * VW, 0))
    sheet_path = preview / "contact_phases.png"
    sheet.convert("RGB").save(sheet_path)
    print(f"contact -> {sheet_path}", flush=True)
    outs[0].save(preview / "frame001.png")
    outs[-1].save(preview / "frame193.png")
    meta = {
        "scale": SCALE,
        "scaledSize": [SCALED, SCALED],
        "viewport": {"x": VX, "y": VY, "w": VW, "h": VH},
        "frameCount": len(outs),
        "fps": 24,
    }
    (preview / "process_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print("done", meta, flush=True)

if __name__ == "__main__":
    main()
