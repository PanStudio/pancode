// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import "./mark.css";

declare const __PANCODE_MARK_SVG__: string | undefined;

/**
 * The sizes PancodePulse is drawn at, defined once. An inline mark beside a word, a list or task row,
 * a step in a plan, and a stage (the setup wizard, an empty state). Pass one of these, not a number.
 */
export const PULSE_SIZE = { inline: 14, row: 16, step: 16, stage: 24 } as const;

/** One drawn shape of the mark, named by its class in the source: the glyph, or another layer. */
type Shape = { part: string; d: string };
type Tile = { width: string; height: string; rx: string };

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * The mark exactly as assets/brand/pancode-mark.svg draws it. Vite inlines the file when the bundle is built
 * (vite.config.ts), so a refined mark flows through without hand-copied path data; outside a Vite build the
 * mark has no shapes. The tile is drawn too: on the black ground it disappears and the glyph floats, and on
 * any other ground it is the mark's container (site/DESIGN.md "Mark").
 */
const MARK = (() => {
	const source = typeof __PANCODE_MARK_SVG__ === "string" ? __PANCODE_MARK_SVG__ : "";
	const svg = /<svg\b[^>]*>/.exec(source)?.[0] ?? "";
	const viewBox = attribute(svg, "viewBox") ?? "0 0 16 16";
	const rect = /<rect\b[^>]*>/.exec(source)?.[0];
	const tile: Tile | null = rect
		? {
				width: attribute(rect, "width") ?? "16",
				height: attribute(rect, "height") ?? "16",
				rx: attribute(rect, "rx") ?? "0",
			}
		: null;
	const shapes: Shape[] = [];
	for (const [tag] of source.matchAll(/<path\b[^>]*>/g)) {
		const d = attribute(tag, "d");
		if (d) shapes.push({ part: attribute(tag, "class") ?? "glyph", d });
	}
	return { viewBox, tile, shapes };
})();

const CHECK = "M4 8.3 6.8 11.1 12.2 5.2";

function MarkArt({ className }: { className: string }) {
	return (
		<svg className={className} viewBox={MARK.viewBox} aria-hidden="true">
			{MARK.tile ? (
				<rect className="pancode-mark__tile" width={MARK.tile.width} height={MARK.tile.height} rx={MARK.tile.rx} />
			) : null}
			{MARK.shapes.map((shape) => (
				<path key={shape.d} className={`pancode-mark__${shape.part}`} d={shape.d} />
			))}
		</svg>
	);
}

/**
 * The "PanCode is working" indicator: a still blue live dot in the running status colour, always beside
 * the words that say what is running. It means PanCode, a worker, a tool or the setup child is doing
 * something right now, never ordinary data loading. `done` turns it into the leaf check, shown only
 * after a reported completion. It is decorative to assistive technology unless it gets a `label`.
 */
export function PancodePulse({ size = 16, label, done = false }: { size?: number; label?: string; done?: boolean }) {
	return (
		<span
			className="pancode-pulse"
			data-state={done ? "done" : "busy"}
			style={{ width: size, height: size }}
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
		>
			{done ? (
				<svg className="pancode-pulse__done" viewBox="0 0 16 16" aria-hidden="true">
					<path d={CHECK} strokeWidth={1.5} />
				</svg>
			) : (
				<span className="pancode-pulse__live" />
			)}
		</span>
	);
}

/** The PanCode mark as the product's logo, at rest: the brand green P on its black tile. */
export function PancodeLogo({ size = 24 }: { size?: number }) {
	return (
		<span className="pancode-logo" style={{ width: size, height: size }} aria-hidden="true">
			<MarkArt className="pancode-logo__art" />
		</span>
	);
}

/**
 * The wordmark as live text in the display face: Pan in the brand green, Code in the secondary azure
 * (site/DESIGN.md "Wordmark"). It inherits its size from the place it sits. The static offline page cannot
 * render this component, so public/offline.html repeats its markup and public/offline.css its rules.
 */
export function PancodeWordmark() {
	return (
		<span className="pancode-wordmark">
			<span className="pancode-wordmark__pan">Pan</span>
			<span className="pancode-wordmark__code">Code</span>
		</span>
	);
}

/** The bare canonical mark for a larger stage; the caller sizes it and supplies the words around it. */
export function PancodeMarkArt() {
	return <MarkArt className="pancode-mark" />;
}
