// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CSSProperties } from "react";
import { useId } from "react";
import type { MarkCuts } from "./mark-cuts.js";
import "./mark.css";

declare const __PANCODE_MARK_CUTS__: MarkCuts | undefined;
declare const __PANCODE_DISPLAY_NAME__: { dark: string; light: string } | undefined;

/**
 * The sizes PancodePulse is drawn at, defined once. An inline mark beside a word, a list or task row,
 * a step in a plan, and a stage (the setup wizard, an empty state). Pass one of these, not a number.
 */
export const PULSE_SIZE = { inline: 14, row: 16, step: 16, stage: 24 } as const;

/** To this size the small cut, whose channel is widened so it holds at favicon sizes. */
const SMALL_MARK_PX = 24;
/** Below this size gradients do not read and the mark is flat (site/DESIGN.md "Mark"). */
const GRADED_MARK_PX = 32;
/** An empty state's mark: one colour, above the sentence, never the coloured mark (identity-rollout P6). */
const EMPTY_MARK_PX = 32;
type MarkFill = "small" | "flat" | "graded" | "mono";

/**
 * The cuts of assets/brand, checked and inlined by vite.config.ts (mark-cuts.ts) so a refined mark flows through
 * without hand-copied path data. Outside a Vite build, as in the page tests, the mark has no shapes.
 */
const CUTS = typeof __PANCODE_MARK_CUTS__ === "undefined" ? null : __PANCODE_MARK_CUTS__;
/** assets/brand/pancode-display.svg and its light-ground file as image URLs, from vite.config.ts like the cuts. */
const DISPLAY_NAME = typeof __PANCODE_DISPLAY_NAME__ === "undefined" ? null : __PANCODE_DISPLAY_NAME__;

/** Palette names stay names (brand.css projects them as `--pancode-<name>`); mark.css picks the theme's paint. */
function paints(dark: string, light?: string): CSSProperties {
	return {
		"--mark-dark": `var(--pancode-${dark})`,
		...(light ? { "--mark-light": `var(--pancode-${light})` } : {}),
	} as CSSProperties;
}

/**
 * The mark: four facets of one stone with the for-all sign as the channel between them, and no tile. Fill follows
 * size: the small cut's flat facets and wider channel to 24 px, the full cut's paths in those flat colours below
 * 32 px, and from 32 px the full cut's gradients (the light cut's colours on a light theme). Mono, for every
 * single-colour context at any size, is the small cut's facets in the current text colour (site/DESIGN.md "Mark").
 */
function MarkArt({ className, fill = "graded" }: { className: string; fill?: MarkFill }) {
	const scope = useId().replace(/[^\w-]/g, "");
	if (!CUTS) return <svg className={className} viewBox="0 0 64 64" aria-hidden="true" />;
	if (fill === "mono")
		return (
			<svg className={className} viewBox={CUTS.small.viewBox} aria-hidden="true">
				{CUTS.small.facets.map((facet) => (
					<path key={facet.part} className="pancode-mark__mono" d={facet.d} />
				))}
			</svg>
		);
	if (fill !== "graded") {
		const { viewBox, facets } =
			fill === "small"
				? CUTS.small
				: { viewBox: CUTS.full.viewBox, facets: CUTS.full.facets.map((facet) => ({ ...facet, colour: facet.flat })) };
		return (
			<svg className={className} viewBox={viewBox} aria-hidden="true">
				{facets.map((facet) => (
					<path
						key={facet.part}
						className={`pancode-mark__flat pancode-mark__flat--${facet.part}`}
						d={facet.d}
						style={paints(facet.colour)}
					/>
				))}
			</svg>
		);
	}
	return (
		<svg className={className} viewBox={CUTS.full.viewBox} aria-hidden="true">
			<defs>
				{CUTS.full.facets.map(({ part, gradient }) => (
					<linearGradient
						key={part}
						id={`${scope}-${part}`}
						x1={gradient.x1}
						y1={gradient.y1}
						x2={gradient.x2}
						y2={gradient.y2}
						gradientUnits="userSpaceOnUse"
					>
						{gradient.stops.map((stop) => (
							<stop
								key={stop.offset}
								offset={stop.offset}
								className="pancode-mark__stop"
								style={paints(stop.dark, stop.light)}
							/>
						))}
					</linearGradient>
				))}
			</defs>
			{CUTS.full.facets.map((facet) => (
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
			<MarkArt
				className="pancode-logo__art"
				fill={size <= SMALL_MARK_PX ? "small" : size < GRADED_MARK_PX ? "flat" : "graded"}
			/>
		</span>
	);
}

/** The mark above an empty state's sentence, in the muted ink. */
export function PancodeEmptyMark() {
	return (
		<span
			className="pancode-logo pancode-logo--empty"
			style={{ width: EMPTY_MARK_PX, height: EMPTY_MARK_PX }}
			aria-hidden="true"
		>
			<MarkArt className="pancode-logo__art" fill="mono" />
		</span>
	);
}

/**
 * The display name, for the opening stage only: the artwork's outlines with the for-all sign in place of the A, at
 * 28 px cap height (mark.css). The theme shows one of the two files.
 */
export function PancodeDisplayName() {
	if (!DISPLAY_NAME) return null;
	return (
		<span className="pancode-display" aria-hidden="true">
			<img className="pancode-display__dark" src={DISPLAY_NAME.dark} alt="" />
			<img className="pancode-display__light" src={DISPLAY_NAME.light} alt="" />
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
