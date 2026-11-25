#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Rasterize the hand-written brand SVGs with Chrome and encode them with the
// pinned Pillow 12.1.0 and libwebp 1.6.0. Colours come from the palette in
// site/design-system.json: every var(--palette-<name>, #hex) fallback in the
// sources is rewritten to the current token before rendering. assets/README.md
// lists the derived assets to regenerate afterwards.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const root = resolve(site, "..");
const { values } = parseArgs({ options: { chrome: { type: "string" } } });
const chrome = resolve(values.chrome ?? process.env.PANCODE_CHROME ?? "/usr/bin/google-chrome");
if (!existsSync(chrome)) throw new Error(`Chrome was not found at ${chrome}; pass --chrome <path>.`);
const { chromium } = createRequire(join(root, "apps/pancode-gui/package.json"))("playwright-core");

const renders = [
	{ svg: "assets/brand/pancode-mark.svg", width: 512, height: 512, outputs: ["site/assets/brand/pancode-mark"] },
	{ svg: "assets/brand/banner.svg", width: 2400, height: 750, outputs: ["assets/banner"] },
];
const { palette } = JSON.parse(readFileSync(join(site, "design-system.json"), "utf8"));
for (const { svg } of renders) {
	const path = join(root, svg);
	const source = readFileSync(path, "utf8");
	const themed = source.replace(/var\(--palette-([a-zA-Z0-9]+), #[0-9a-fA-F]{3,8}\)/g, (_, name) => {
		if (!palette[name]) throw new Error(`${svg}: palette token ${name} is not in site/design-system.json.`);
		return `var(--palette-${name}, ${palette[name]})`;
	});
	if (themed !== source) {
		writeFileSync(path, themed);
		console.log(`synced ${svg} colours from site/design-system.json`);
	}
}
const scratch = mkdtempSync(join(tmpdir(), "pancode-brand-"));
const encode = `
import hashlib, json, sys
from pathlib import Path
from PIL import Image, __version__ as pillow, features
for name, found, expected in [("Pillow", pillow, "12.1.0"), ("libwebp", features.version("webp"), "1.6.0")]:
    if found != expected:
        raise SystemExit(f"{name}: expected {expected}, found {found}; byte-identical assets require this encoder.")
root = Path(sys.argv[1])
for raw, output, svg in zip(sys.argv[2::3], sys.argv[3::3], sys.argv[4::3]):
    image = Image.open(raw).convert("RGBA")
    if image.getchannel("A").getextrema() == (255, 255):
        image = image.convert("RGB")
    image.save(root / f"{output}.png", optimize=True)
    image.save(root / f"{output}.webp", lossless=True, quality=100, method=6)
    if output.endswith("pancode-mark"):
        mark = root / f"{output}.png"
        item = {"name": "pancode-mark", "source": svg, "sha256": hashlib.sha256(mark.read_bytes()).hexdigest(), "dimensions": "SIZE"}
        text = json.dumps({"assets": [item]}, indent="\\t").replace('"SIZE"', json.dumps(list(image.size)))
        (mark.parent / "provenance.json").write_text(text + "\\n")
`;
const run = (args) => {
	const result = spawnSync("python3", args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
};
try {
	const browser = await chromium.launch({
		executablePath: chrome,
		headless: true,
		args: ["--font-render-hinting=none"],
	});
	const jobs = [];
	try {
		for (const item of renders) {
			const context = await browser.newContext({
				viewport: { width: item.width, height: item.height },
				deviceScaleFactor: 1,
			});
			try {
				const page = await context.newPage();
				await page.goto(pathToFileURL(join(root, item.svg)).href, { waitUntil: "load" });
				await page.evaluate(async ({ width, height }) => {
					document.documentElement.setAttribute("width", String(width));
					document.documentElement.setAttribute("height", String(height));
					await document.fonts.ready;
					await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
				}, item);
				const raw = join(scratch, `${jobs.length}.png`);
				await page.screenshot({ path: raw, omitBackground: true, animations: "disabled", scale: "css" });
				for (const output of item.outputs) jobs.push(raw, output, item.svg);
				console.log(`rendered ${item.svg} at ${item.width}x${item.height}`);
			} finally {
				await context.close();
			}
		}
	} finally {
		await browser.close();
	}
	run(["-c", encode, root, ...jobs]);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
