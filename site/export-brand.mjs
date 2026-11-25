#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { designSystem, fontFiles, tokenCSS } from "./tokens.mjs";

const site = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string", default: "/tmp/pancode-brand-kit" } } });
const out = resolve(values.out);
if (out === "/" || out === site || site.startsWith(`${out}/`))
	throw new Error("The export must not replace source files.");
const marker = ".pancode-brand-kit";
const existing = await readdir(out).catch((error) => {
	if (error.code === "ENOENT") return [];
	throw error;
});
if (existing.length && (!existing.includes(marker) || (await readFile(join(out, marker), "utf8")) !== `${site}\n`))
	throw new Error("Refusing to replace an export directory not owned by this tool.");
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "css"), { recursive: true });
await mkdir(join(out, "assets/brand"), { recursive: true });
await mkdir(join(out, "assets/fonts"), { recursive: true });
await writeFile(join(out, marker), `${site}\n`);
await writeFile(join(out, "css/pancode.css"), await tokenCSS());
await cp(join(site, "design-system.json"), join(out, "design-system.json"));
for (const name of ["pancode-mark.png", "pancode-mark.webp", "provenance.json"])
	await cp(join(site, "assets/brand", name), join(out, "assets/brand", name));
await cp(join(site, "../assets/brand/pancode-mark.svg"), join(out, "assets/brand/pancode-mark.svg"));
for (const name of fontFiles(await designSystem()))
	await cp(join(site, "assets/fonts", name), join(out, "assets/fonts", name));
await writeFile(
	join(out, "README.md"),
	`# PanCode identity kit\n\nUse the PanCode mark for every PanCode application: the P of the wordmark in the brand green on a black tile. Pair it with the name PanCode, set with Pan in the brand green and Code in the secondary azure, and a plain descriptor such as "in the terminal" or "on the desktop". Do not draw a separate product mark or recolour the artwork.\n\nImport css/pancode.css for the palette, the semantic roles, type, space, radius, elevation, glow and motion tokens. It contains no site layout or components. Dark is true black with the brand green and an azure secondary; light keeps the same roles on a pale ground with black fills. Select a theme with html[data-theme], or use the configured defaultTheme from design-system.json (dark, light, or system). design-system.json is the sole colour source: it names every ramp, role, state colour, data series and syntax colour, and says where glow is allowed. Source changes are made in pancode/site/ and regenerated.\n\nThe typography is Schibsted Grotesk for headings, Instrument Sans for text and controls, and IBM Plex Mono for commands, code and labels. All fonts and their upstream licenses are included. Preserve relative asset paths when importing the CSS.\n\nThe original artwork is assets/brand/pancode-mark.svg; the hash of its rendered PNG is in assets/brand/provenance.json. Public copyright wording: Copyright 2026 Anthony Kougkas. The PanCode project is under the PanCode License 1.0; third-party font licenses remain with their owners. See pancode/site/DESIGN.md for the complete identity and public prose rules.\n`,
);
console.log(`Exported the reusable PanCode identity to ${out}`);
