#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PanCode-1.0
# SPDX-FileCopyrightText: 2026 Anthony Kougkas
"""Generate reproducible WebP sizes from actual product and brand artwork."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

SITE = Path(__file__).resolve().parent
MANIFEST = SITE / "image-variants.json"
SOCIAL_MANIFEST = SITE / "social-images.json"
# Link previews use real product captures: every article cover, plus the overview
# capture as the default for pages without one.
SOCIAL_DEFAULT = "gui-task"
SOCIAL_SIZE = (1200, 630)
ICON_SIZES = [180, 192, 512]
INPUTS = {
    "assets/tui-verify.webp": [640, 960, 1280],
    "assets/tui-boot.webp": [640, 960, 1280],
    "assets/guides/tui-configure-source.webp": [640, 1024, 1600],
    "assets/guides/tui-configure-detected.webp": [640, 1024, 1600],
    "assets/guides/tui-configure-saved.webp": [640, 1024, 1600],
    "assets/guides/tui-settings-models.webp": [640, 1024, 1600],
    "assets/guides/tui-settings-fleet.webp": [640, 1024, 1600],
    "assets/guides/tui-settings-workers.webp": [640, 1024, 1600],
    "assets/guides/tui-verify-result.webp": [640, 1024, 1600],
    "assets/guides/tui-verify-table.webp": [640, 1024, 1600],
    "assets/guides/tui-view-result.webp": [640, 1024, 1600],
    "assets/guides/tui-approval-effect.webp": [640, 1024, 1600],
    "assets/guides/tui-context.webp": [640, 1024, 1600],
    "assets/guides/tui-tree.webp": [640, 1024, 1600],
    "assets/guides/tui-hub-skill-tdd.webp": [640, 1024, 1600],
    "assets/guides/cli-hub-dry-run.webp": [640, 1024, 1600],
    "assets/guides/tui-hub-installed.webp": [640, 1024, 1600],
    "assets/guides/cli-hub-list-plugin.webp": [640, 1024, 1600],
    "assets/guides/tui-interop.webp": [640, 1024, 1600],
    "assets/guides/cli-interop-inspect.webp": [640, 1024, 1600],
    "assets/guides/cli-doctor.webp": [640, 1024, 1600],
    "assets/guides/cast-first-task.webp": [640, 1024, 1600],
    "assets/guides/cast-first-launch.webp": [640, 1024, 1600],
    "assets/guides/cast-headless-run.webp": [640, 1024, 1600],
    "assets/guides/cast-sandbox.webp": [640, 1024, 1600],
    "assets/guides/cast-let-it-work.webp": [640, 1024, 1600],
    "assets/guides/cli-playbook-graph.webp": [640, 1024, 1600],
    "assets/guides/cli-telemetry-session.webp": [640, 1024, 1600],
    "assets/guides/cli-extension-validate.webp": [640, 1024, 1600],
    "assets/guides/cli-store-stat.webp": [640, 1024, 1600],
    "assets/gui-task.webp": [640, 960, 1280],
    "assets/guides/gui-home.webp": [640, 1024, 1600],
    "assets/guides/gui-approval.webp": [640, 1024, 1600],
    "assets/guides/gui-setup.webp": [640, 1024, 1600],
    "assets/brand/pancode-mark.webp": [32, 48, 64, 128],
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def social_captures():
    captures = json.loads((SITE / "content/captures.json").read_text())["captures"]
    covers = {SOCIAL_DEFAULT}
    for collection in ("tutorials", "research"):
        covers.update(item["cover"] for item in json.loads((SITE / f"content/{collection}.json").read_text()) if item.get("cover"))
    return {name: captures[name] for name in sorted(covers)}


def social_image(capture):
    """Fit a capture to the preview width on the page color, keeping its top edge."""
    design = json.loads((SITE / "design-system.json").read_text())
    paper = design["palette"][design["themes"]["dark"]["paper"]]
    image = Image.open(SITE / capture["original"]).convert("RGB")
    width, height = SOCIAL_SIZE
    scaled = image.resize((width, round(image.height * width / image.width)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", SOCIAL_SIZE, paper)
    if scaled.height >= height:
        canvas.paste(scaled.crop((0, 0, width, height)))
    else:
        canvas.paste(scaled, (0, (height - scaled.height) // 2))
    return canvas


def generate_social():
    (SITE / "assets/social").mkdir(exist_ok=True)
    images = {}
    for name, capture in social_captures().items():
        target = f"assets/social/{name}.png"
        social_image(capture).save(SITE / target, "PNG", optimize=True)
        images[name] = {"source": capture["original"], "path": target, "width": SOCIAL_SIZE[0], "height": SOCIAL_SIZE[1], "sha256": digest(SITE / target)}
    SOCIAL_MANIFEST.write_text(json.dumps({"default": SOCIAL_DEFAULT, "images": images}, indent="\t")+"\n")
    print(f"Generated {len(images)} social preview images.")


def generate():
    (SITE / "assets/responsive").mkdir(exist_ok=True)
    result = {}
    for source, widths in INPUTS.items():
        image = Image.open(SITE / source).convert("RGBA")
        variants = []
        for width in widths:
            height = round(image.height * width / image.width)
            target = f"assets/responsive/{Path(source).stem}-{width}.webp"
            image.resize((width, height), Image.Resampling.LANCZOS).save(SITE / target, "WEBP", quality=88, method=6)
            variants.append({"path": target, "width": width, "height": height, "sha256": digest(SITE / target)})
        result[source] = {"width": image.width, "height": image.height, "sha256": digest(SITE / source), "variants": variants}
    MANIFEST.write_text(json.dumps(result, indent=2)+"\n")
    generate_icons()
    print(f"Generated {sum(len(item['variants']) for item in result.values())} responsive captures and marks, plus the icon set.")
    generate_social()


def generate_icons():
    """Square browser and app icons, the maskable app icon, and favicon.ico, all from the rendered mark."""
    mark = Image.open(SITE / "assets/brand/pancode-mark.png").convert("RGBA")
    small_cut = Image.open(SITE / "assets/brand/pancode-mark-small.png").convert("RGBA")

    def fit(size, scale, ground=None, source=mark):
        canvas = Image.new("RGBA", (size, size), ground or (0, 0, 0, 0))
        fitted = source.copy()
        fitted.thumbnail((round(size*scale), round(size*scale)), Image.Resampling.LANCZOS)
        canvas.alpha_composite(fitted, ((size-fitted.width)//2, (size-fitted.height)//2))
        return canvas

    brand = json.loads((SITE / "design-system.json").read_text())
    black = Image.new("RGB", (1, 1), brand["palette"]["black"]).getpixel((0, 0))
    # App icons set the stone at 80% on a black ground (DESIGN.md, Mark); only favicons stay transparent.
    for size in ICON_SIZES:
        fit(size, .8, (*black, 255)).save(SITE / f"assets/responsive/pancode-icon-{size}.png", optimize=True)
    # A maskable icon is cropped to a circle by the platform: a full black ground, with every painted
    # pixel inside the safe circle of radius 40% of the canvas (check() measures it).
    fit(512, .74, (*black, 255)).save(SITE / "assets/responsive/pancode-icon-maskable-512.png", optimize=True)
    # The 16 pixel image takes the small cut, whose wider channel survives at that size.
    small = [fit(48, 1), fit(32, 1), fit(16, 1, source=small_cut)]
    small[0].save(SITE / "assets/responsive/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=small[1:])


def check():
    manifest = json.loads(MANIFEST.read_text())
    for source, item in manifest.items():
        if digest(SITE / source) != item["sha256"]:
            raise ValueError(f"image source changed: {source}")
        for variant in item["variants"]:
            path = SITE / variant["path"]
            if digest(path) != variant["sha256"] or Image.open(path).size != (variant["width"], variant["height"]):
                raise ValueError(f"image derivative drift: {path}")
    for size in ICON_SIZES:
        if Image.open(SITE / f"assets/responsive/pancode-icon-{size}.png").size != (size, size):
            raise ValueError("square application icon dimensions differ")
    maskable = Image.open(SITE / "assets/responsive/pancode-icon-maskable-512.png").convert("RGBA")
    if maskable.size != (512, 512):
        raise ValueError("maskable application icon dimensions differ")
    black = Image.new("RGB", (1, 1), json.loads((SITE / "design-system.json").read_text())["palette"]["black"]).getpixel((0, 0))
    pixels = maskable.load()
    if any(pixels[x, y][3] != 255 for y in range(512) for x in range(512)):
        raise ValueError("maskable application icon ground is not fully opaque")
    # Any pixel that differs from the black ground, however dim its antialiasing, is painted.
    painted = [(x, y) for y in range(512) for x in range(512) if pixels[x, y][:3] != black]
    if any((x + .5 - 256) ** 2 + (y + .5 - 256) ** 2 > (512 * .4) ** 2 for x, y in painted):
        raise ValueError("maskable application icon paints outside its safe circle")
    if sorted(Image.open(SITE / "assets/responsive/favicon.ico").info["sizes"]) != [(16, 16), (32, 32), (48, 48)]:
        raise ValueError("favicon.ico must carry 16, 32 and 48 pixel images")
    social = json.loads(SOCIAL_MANIFEST.read_text())
    if sorted(social["images"]) != sorted(social_captures()) or social["default"] != SOCIAL_DEFAULT:
        raise ValueError("social previews differ from the article covers; regenerate image variants")
    for name, item in social["images"].items():
        path = SITE / item["path"]
        if item["source"] != social_captures()[name]["original"] or digest(path) != item["sha256"]:
            raise ValueError(f"social preview drift: {path}")
        if Image.open(path).size != SOCIAL_SIZE:
            raise ValueError(f"social preview is not {SOCIAL_SIZE[0]}x{SOCIAL_SIZE[1]}: {path}")
    print("Responsive source hashes, derivatives, social previews, and icon dimensions checked.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--social", action="store_true", help="regenerate only the social previews")
    parser.add_argument("--icons", action="store_true", help="regenerate only the icons from the rendered mark")
    args = parser.parse_args()
    check() if args.check else generate_social() if args.social else generate_icons() if args.icons else generate()
