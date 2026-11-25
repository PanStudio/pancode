// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
export async function designSystem() {
	return JSON.parse(await readFile(file("design-system.json"), "utf8"));
}
/** Font files and license texts every consumer of the identity ships, in publication order. */
export function fontFiles(design) {
	return [...design.type.faces.map((face) => face.file), ...design.type.licenses];
}
export async function tokenCSS() {
	const design = await designSystem();
	const { palette, themes, code, type, space, layout, radius, elevation, glow, motion, defaultTheme } = design;
	if (!["dark", "light", "system"].includes(defaultTheme))
		throw new Error("defaultTheme must be dark, light, or system.");
	const initial = defaultTheme === "light" ? "light" : "dark";
	const sanctioned = (color) => {
		if (!palette[color]) throw new Error(`Unknown sanctioned color: ${color}`);
		return `var(--pancode-${color})`;
	};
	const lines = (entries, prefix = "") =>
		Object.entries(entries)
			.map(([key, value]) => `\t--${prefix}${key}: ${value};`)
			.join("\n");
	const theme = (name) =>
		[
			`\tcolor-scheme: ${name};`,
			...Object.entries(themes[name]).map(([key, color]) => `\t--${key}: ${sanctioned(color)};`),
			lines(elevation[name], "elevation-"),
			lines(glow[name], "glow-"),
		].join("\n");
	const family = (role) => `"${type.families[role].family}", ${type.families[role].fallback}`;
	const { syntax, note: _note, ...codeRoles } = code;
	return `/* Generated from design-system.json by tokens.mjs. Edit the source, then regenerate. */
${type.faces
	.map(
		(face) =>
			`@font-face { font-family: "${face.family}"; font-style: ${face.style}; font-weight: ${face.weight}; font-display: swap; src: url("../assets/fonts/${face.file}") format("woff2"); }`,
	)
	.join("\n")}
:root {
${lines(palette, "pancode-")}
${theme(initial)}
	--font-display: ${family("display")};
	--font-ui: ${family("text")};
	--font-mono: ${family("mono")};
${Object.entries(type.scale)
	.map(
		([key, step]) =>
			`\t--type-${key}: ${step.weight} ${step.size} / ${step.line} var(--font-${step.face === "text" ? "ui" : step.face});\n\t--tracking-${key}: ${step.tracking};`,
	)
	.join("\n")}
${lines(layout)}
${lines(space, "space-")}
	--radius-xs: ${radius.xs};
	--radius-sm: ${radius.sm};
	--radius: ${radius.md};
	--radius-lg: ${radius.lg};
	--radius-pill: ${radius.pill};
${lines(motion, "motion-")}
	--code: ${sanctioned(codeRoles.surface)};
	--code-sunk: ${sanctioned(codeRoles.sunk)};
	--code-border: ${sanctioned(codeRoles.border)};
	--code-control: ${sanctioned(codeRoles.control)};
	--code-accent: ${sanctioned(codeRoles.accent)};
	--code-accent-soft: ${sanctioned(codeRoles["accent-soft"])};
	--code-ink: ${sanctioned(codeRoles.text)};
	--code-muted: ${sanctioned(codeRoles.muted)};
${Object.entries(syntax)
	.map(([key, color]) => `\t--syntax-${key}: ${sanctioned(color)};`)
	.join("\n")}
	--selection-bg: var(--selection);
	--selection-ink: var(--on-selection);
	--menu-shadow: var(--elevation-2);
}
html[data-theme="dark"] {
${theme("dark")}
}
html[data-theme="light"] {
${theme("light")}
}
${
	defaultTheme === "system"
		? `@media (prefers-color-scheme: light) {
	html:not([data-theme]) {
${theme("light")}
	}
}`
		: ""
}
`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const css = await tokenCSS();
	if (process.argv.includes("--check")) {
		if ((await readFile(file("css/brand.css"), "utf8")) !== css)
			throw new Error("brand.css differs from the sanctioned tokens. Run node site/tokens.mjs.");
	} else await writeFile(file("css/brand.css"), css);
}
