// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type CSSProperties, useId } from "react";
import "./mark.css";

declare const __PANCODE_MARK_SVG__: string | undefined;
declare const __PANCODE_MARK_LIGHT_SVG__: string | undefined;
declare const __PANCODE_MARK_SMALL_SVG__: string | undefined;

/**
 * The sizes PancodePulse is drawn at, defined once. An inline mark beside a word, a list or task row,
 * a step in a plan, and a stage (the setup wizard, an empty state). Pass one of these, not a number.
 */
export const PULSE_SIZE = { inline: 14, row: 16, step: 16, stage: 24 } as const;

/** The four facets of the stone, in the order every cut draws them. */
const PARTS = ["left", "top", "right", "point"] as const;
/** At this size and below the mark is the small cut, whose wider channel holds at favicon sizes. */
const SMALL_MARK_PX = 24;
/** Below this size the mark is flat (site/DESIGN.md "Mark"); from it the facets are graded. */
const GRADED_MARK_PX = 32;
/** How the mark is filled: the small cut, the full cut in the small cut's flat colours, or the graded full cut. */
type MarkFill = "small" | "flat" | "graded";

type Stop = { offset: string; colour: string | undefined };
type Gradient = { x1: string; y1: string; x2: string; y2: string; stops: Stop[] };
/** One facet: its part name, its path, and the palette colour a flat cut fills it with. */
type Facet = { part: string; d: string; colour: string | undefined };
type Cut = { viewBox: string; facets: Facet[]; gradients: Map<string, Gradient> };

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * One cut of the mark exactly as assets/brand draws it. Vite inlines the files when the bundle is built
 * (vite.config.ts), so a refined mark flows through without hand-copied path data; outside a Vite build the
 * mark has no shapes. Colours stay palette names (`.green300 { stop-color: var(--palette-green300, …) }`), which
 * brand.css projects as `--pancode-<name>`.
 */
function parseCut(source: string | undefined): Cut {
	const svg = source ?? "";
	const palette = new Map<string, string>();
	for (const [, name, colour] of svg.matchAll(/\.([\w-]+)\s*\{[^}]*var\(--palette-([\w-]+)/g))
		if (name && colour) palette.set(name, colour);
	const colourOf = (tag: string) => palette.get(attribute(tag, "class") ?? "");
	const gradients = new Map<string, Gradient>();
	for (const [, open = "", body = ""] of svg.matchAll(/<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
		const id = attribute(open, "id");
		if (!id) continue;
		gradients.set(id, {
			x1: attribute(open, "x1") ?? "0",
			y1: attribute(open, "y1") ?? "0",
			x2: attribute(open, "x2") ?? "0",
			y2: attribute(open, "y2") ?? "0",
			stops: [...body.matchAll(/<stop\b[^>]*>/g)].map(([stop]) => ({
				offset: attribute(stop, "offset") ?? "0",
				colour: colourOf(stop),
			})),
		});
	}
	const facets = [...svg.matchAll(/<path\b[^>]*>/g)].flatMap(([tag], index) => {
		const d = attribute(tag, "d");
		const gradient = /url\(#([\w-]+)\)/.exec(attribute(tag, "fill") ?? "")?.[1];
		return d ? [{ part: gradient ?? PARTS[index] ?? `facet${index}`, d, colour: colourOf(tag) }] : [];
	});
	return { viewBox: attribute(/<svg\b[^>]*>/.exec(svg)?.[0] ?? "", "viewBox") ?? "0 0 64 64", facets, gradients };
}

const FULL = parseCut(typeof __PANCODE_MARK_SVG__ === "string" ? __PANCODE_MARK_SVG__ : undefined);
const LIGHT = parseCut(typeof __PANCODE_MARK_LIGHT_SVG__ === "string" ? __PANCODE_MARK_LIGHT_SVG__ : undefined);
const SMALL = parseCut(typeof __PANCODE_MARK_SMALL_SVG__ === "string" ? __PANCODE_MARK_SMALL_SVG__ : undefined);

/** A dark and a light paint for one stop or facet; mark.css picks the one the theme needs. */
function paints(dark: string | undefined, light: string | undefined): CSSProperties {
	return {
		...(dark ? { "--mark-dark": `var(--pancode-${dark})` } : {}),
		...(light ? { "--mark-light": `var(--pancode-${light})` } : {}),
	} as CSSProperties;
}

function markFill(size: number): MarkFill {
	return size <= SMALL_MARK_PX ? "small" : size < GRADED_MARK_PX ? "flat" : "graded";
}

/**
 * The mark: four facets of one stone with the for-all sign as the channel between them, and no tile. Fill follows
 * size: the small cut's flat facets and wider channel to 24 px, the full cut's paths in those flat colours below
 * 32 px, and from 32 px the full cut's gradients (the light cut's colours on a light theme).
 */
function MarkArt({ className, fill = "graded" }: { className: string; fill?: MarkFill }) {
	const scope = useId().replace(/[^\w-]/g, "");
	if (fill !== "graded") {
		const cut = fill === "small" ? SMALL : FULL;
		return (
			<svg className={className} viewBox={cut.viewBox} aria-hidden="true">
				{cut.facets.map((facet) => (
					<path
						key={facet.part}
						className={`pancode-mark__flat pancode-mark__flat--${facet.part}`}
						d={facet.d}
						style={paints(SMALL.facets.find((flat) => flat.part === facet.part)?.colour, undefined)}
					/>
				))}
			</svg>
		);
	}
	return (
		<svg className={className} viewBox={FULL.viewBox} aria-hidden="true">
			<defs>
				{[...FULL.gradients].map(([id, gradient]) => (
					<linearGradient
						key={id}
						id={`${scope}-${id}`}
						x1={gradient.x1}
						y1={gradient.y1}
						x2={gradient.x2}
						y2={gradient.y2}
						gradientUnits="userSpaceOnUse"
					>
						{gradient.stops.map((stop, index) => (
							<stop
								key={stop.offset}
								offset={stop.offset}
								className="pancode-mark__stop"
								style={paints(stop.colour, LIGHT.gradients.get(id)?.stops[index]?.colour ?? stop.colour)}
							/>
						))}
					</linearGradient>
				))}
			</defs>
			{FULL.facets.map((facet) => (
				<path key={facet.part} className="pancode-mark__facet" d={facet.d} fill={`url(#${scope}-${facet.part})`} />
			))}
		</svg>
	);
}

const CHECK = "M4 8.3 6.8 11.1 12.2 5.2";

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

/** The PanCode mark as the product's logo, at rest, filled for its size (MarkArt). */
export function PancodeLogo({ size = 24 }: { size?: number }) {
	return (
		<span className="pancode-logo" style={{ width: size, height: size }} aria-hidden="true">
			<MarkArt className="pancode-logo__art" fill={markFill(size)} />
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
