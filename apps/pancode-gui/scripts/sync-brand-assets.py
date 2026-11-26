#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PanCode-1.0
# SPDX-FileCopyrightText: 2026 Anthony Kougkas
"""Project a canonical brand kit with Pillow 12.1.0, libwebp 1.6.0 and pngquant 2.18.0.

node site/export-brand.mjs --out tmp/brand-kit
python3 apps/pancode-gui/scripts/sync-brand-assets.py --kit tmp/brand-kit
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from PIL import Image, __version__ as pillow_version, features

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--kit", type=Path, required=True)
parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "client" / "public")
args = parser.parse_args()
pngquant = shutil.which("pngquant")
if pngquant is None:
    raise SystemExit("pngquant: expected 2.18.0, found no executable on PATH.")
pngquant = str(Path(pngquant).resolve())
pngquant_version = subprocess.check_output([pngquant, "--version"], text=True).strip().partition(" ")[0]
encoders = {"pngquant": pngquant_version, "Pillow": pillow_version, "libwebp": features.version("webp")}
for name, expected in {"pngquant": "2.18.0", "Pillow": "12.1.0", "libwebp": "1.6.0"}.items():
    if encoders[name] != expected:
        raise SystemExit(f"{name}: expected {expected}, found {encoders[name]}; byte-identical assets require this encoder.")
public = args.out
public.mkdir(parents=True, exist_ok=True)
fonts = public / "fonts"
fonts.mkdir(exist_ok=True)
for source in (args.kit / "assets" / "fonts").iterdir():
    shutil.copy2(source, fonts / source.name)
brand = public / "brand"
brand.mkdir(exist_ok=True)
mark = args.kit / "assets" / "brand" / "pancode-mark.png"
provenance = json.loads((args.kit / "assets" / "brand" / "provenance.json").read_text())
provenance["assets"] = [item for item in provenance["assets"] if item["name"] == "pancode-mark"]
if (
    len(provenance["assets"]) != 1
    or provenance["assets"][0]["sha256"] != hashlib.sha256(mark.read_bytes()).hexdigest()
):
    raise ValueError("Canonical mark does not match its provenance.")
provenance["projection"] = {
    "source": "site/export-brand.mjs",
    "designSha256": hashlib.sha256((args.kit / "design-system.json").read_bytes()).hexdigest(),
    "encoders": encoders,
    "padding": "The favicon is the mark on a transparent ground; the app icons set it at 80% on the palette black, which is also maskable-safe; the header mark is unchanged.",
    "iconTreatment": {
        "source": "site/assets/brand/pancode-mark.png",
        "scale": {"favicon.png": 1, "icon-192.png": 0.8, "icon-512.png": 0.8},
        "ground": {"favicon.png": None, "icon-192.png": "black", "icon-512.png": "black"},
        "resampling": "Pillow Image.Resampling.LANCZOS",
        "alpha": "Preserved from the canonical mark before resizing.",
        "optimization": f"pngquant {pngquant_version}, quality 90-100, speed 1; palette quantization after resizing.",
    },
}
image = Image.open(mark).convert("RGBA")
header = image.copy()
header.thumbnail((128, 128), Image.Resampling.LANCZOS)
header.save(public / "pancode-logo.webp", quality=90, method=6)
treatment = provenance["projection"]["iconTreatment"]
palette = json.loads((args.kit / "design-system.json").read_text())["palette"]
for size in [32, 192, 512]:
    name = "favicon.png" if size == 32 else f"icon-{size}.png"
    resized = image.copy()
    edge = round(size * treatment["scale"][name])
    resized.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    ground = treatment["ground"][name]
    square = Image.new("RGBA", (size, size), (*bytes.fromhex(palette[ground][1:]), 255) if ground else (0, 0, 0, 0))
    square.alpha_composite(resized, ((size-resized.width)//2, (size-resized.height)//2))
    output = public / name
    square.save(output, optimize=True)
    subprocess.run([pngquant, "--quality", "90-100", "--speed", "1", "--force", "--output", str(output), str(output)], check=True)
provenance["projection"]["sha256"] = {
    name: hashlib.sha256((public/name).read_bytes()).hexdigest()
    for name in ["pancode-logo.webp", "favicon.png", "icon-192.png", "icon-512.png"]
}
(brand / "provenance.json").write_text(json.dumps(provenance, indent="\t")+"\n")
