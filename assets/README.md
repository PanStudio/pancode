# Media assets

`assets/` contains the canonical brand artwork and product captures.
[`media-manifest.json`](media-manifest.json) records source paths, hashes,
dimensions, descriptions, and delivery copies for the website and browser app.
The brand sources are hand-written SVG. `brand/pancode-mark.svg` draws the mark:
four facets of one stone on a 64 unit grid, with the for-all sign as the channel
between them. `brand/pancode-mark-small.svg` is its flat cut for 16 to 24 pixels
and `brand/pancode-mark-light.svg` its cut for light grounds.
`brand/pancode-wordmark.svg` and `brand/pancode-wordmark-light.svg` set the name
as outlines, Pan in green and Code in azure, for dark and light grounds.
`brand/pancode-display.svg` and `brand/pancode-display-light.svg` set the display
name, with the sign in place of the A, and `brand/banner.svg` adds the mark, the
tagline and the site address. Every brand raster derives from the mark, its small
cut and the banner.

## Regenerate the brand

```bash
node site/render-brand.mjs
python3 site/image-variants.py
node site/export-brand.mjs --out <scratch>/kit
python3 apps/pancode-gui/scripts/sync-brand-assets.py --kit <scratch>/kit
```

The SVGs hold geometry only. Every colour is a `var(--palette-<name>, #hex)`
reference, and `render-brand.mjs` rewrites each fallback from the palette in
`site/design-system.json` before it renders, so a palette change reaches the
sources and every derived raster in one run.

`render-brand.mjs` rasterizes both SVGs with Chrome and writes the banner PNG
and WebP plus `site/assets/brand/pancode-mark.png`, its WebP, and its
provenance. Then copy the GUI `favicon.png`, `icon-192.png`, `icon-512.png`, and
`pancode-logo.webp` into the `pancode-app-*` and `pancode-mark-gui.webp`
masters, update the `?v=` hashes in the GUI `index.html` and
`manifest.webmanifest`, render the preview cards, and synchronize the delivery
copies.

## Product captures

The PNG files in `screenshots/` include the current terminal boot and actual
desktop overview, conversation, and Artifacts captures in dark and light themes.
The v0.5.7 desktop examples use a real model-created temperature-calibration
session with seven passing tests recorded by `verify`. Its runnable source is in
[`examples/temperature-calibration`](../examples/temperature-calibration/README.md).
The overview captures redact the recent project's absolute path for publication;
the terminal uses an isolated model profile and crops only blank bottom margin.
The manifest records this provenance. WebP companions are optimized for inline
reading; links open the full-resolution PNGs. Keep the remaining interface content
intact when preparing derivatives.

## Synchronize and check

```bash
python3 scripts/media-assets.py --sync
python3 scripts/media-assets.py --check
```

The check verifies hashes, dimensions, delivery copies, and card exports.
After replacing a master, update its description and record the new hashes:

```bash
python3 scripts/media-assets.py --record-hashes
python3 scripts/media-assets.py --check
```

## Preview cards

Card templates live in `site/cards/` and use the website's fonts and palette.
Render the landscape and square exports with Chrome:

```bash
node site/render-cards.mjs
# Use --chrome /path/to/chrome when needed.
```

The renderer waits for fonts, captures the declared dimensions, and updates
source and export hashes. Product captures and illustrated cards are identified
separately in the manifest.
