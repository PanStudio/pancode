// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The four facets of the stone, in the order every cut draws them. */
export const MARK_PARTS = ["left", "top", "right", "point"] as const;
export type MarkPart = (typeof MARK_PARTS)[number];

/** One gradient stop: the palette names the full cut and the light cut give it. */
export type MarkStop = { offset: string; dark: string; light: string };
export type MarkGradient = { x1: string; y1: string; x2: string; y2: string; stops: MarkStop[] };
/** A facet of the full cut: its path, its gradient, and the small cut's colour for the flat tier. */
export type FullFacet = { part: MarkPart; d: string; gradient: MarkGradient; flat: string };
export type SmallFacet = { part: MarkPart; d: string; colour: string };
export type MarkCuts = {
	full: { viewBox: string; facets: FullFacet[] };
	small: { viewBox: string; facets: SmallFacet[] };
};

type Source = { file: string; svg: string };

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function fail(source: Source, where: string, problem: string): never {
	throw new Error(`assets/brand/${source.file}.svg: ${where}: ${problem}`);
}

function viewBoxOf(source: Source): string {
	return attribute(/<svg\b[^>]*>/.exec(source.svg)?.[0] ?? "", "viewBox") ?? fail(source, "svg", "no viewBox");
}

/** Class name to palette name, from rules such as `.green300 { stop-color: var(--palette-green300, …) }`. */
function colourOf(source: Source): (tag: string, where: string) => string {
	const palette = new Map<string, string>();
	for (const [, name = "", colour = ""] of source.svg.matchAll(/\.([\w-]+)\s*\{[^}]*var\(--palette-([\w-]+)/g))
		palette.set(name, colour);
	return (tag, where) => {
		const name = attribute(tag, "class") ?? fail(source, where, "a shape or stop has no class");
		return palette.get(name) ?? fail(source, where, `class "${name}" names no --palette colour`);
	};
}

function paths(source: Source): string[] {
	const tags = [...source.svg.matchAll(/<path\b[^>]*>/g)].map(([tag]) => tag);
	if (tags.length !== MARK_PARTS.length)
		fail(source, "svg", `${tags.length} paths, expected the ${MARK_PARTS.length} facets ${MARK_PARTS.join(", ")}`);
	return tags;
}

type Graded = Map<
	MarkPart,
	{ d: string; gradient: Omit<MarkGradient, "stops">; stops: { offset: string; colour: string }[] }
>;

/** A graded cut: each facet fills with the gradient named for its part. */
function graded(source: Source): Graded {
	const gradients = new Map<string, { open: string; body: string }>();
	for (const [, open = "", body = ""] of source.svg.matchAll(/<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/g))
		gradients.set(attribute(open, "id") ?? fail(source, "linearGradient", "no id"), { open, body });
	const colour = colourOf(source);
	const facets: Graded = new Map();
	for (const tag of paths(source)) {
		const id =
			/url\(#([\w-]+)\)/.exec(attribute(tag, "fill") ?? "")?.[1] ?? fail(source, "path", "fill is not a gradient");
		const part = MARK_PARTS.find((name) => name === id) ?? fail(source, id, "not one of the four facets");
		if (facets.has(part)) fail(source, part, "drawn twice");
		const gradient = gradients.get(part) ?? fail(source, part, "no linearGradient with this id");
		const at = (name: string) => attribute(gradient.open, name) ?? fail(source, part, `gradient has no ${name}`);
		const stops = [...gradient.body.matchAll(/<stop\b[^>]*>/g)].map(([stop]) => ({
			// SVG's own default for a stop without an offset.
			offset: attribute(stop, "offset") ?? "0",
			colour: colour(stop, part),
		}));
		if (stops.length < 2) fail(source, part, `${stops.length} gradient stops, expected at least 2`);
		facets.set(part, {
			d: attribute(tag, "d") ?? fail(source, part, "path has no d"),
			gradient: { x1: at("x1"), y1: at("y1"), x2: at("x2"), y2: at("y2") },
			stops,
		});
	}
	return facets;
}

/**
 * Reads the mark's three cuts as assets/brand draws them and checks their contract: four facets each, every gradient
 * and colour present, and a light cut that pairs stop for stop with the full cut. vite.config.ts calls it when the
 * bundle is built, so a broken source fails the build naming the cut and facet instead of shipping a partial logo.
 */
export function readMarkCuts(full: Source, light: Source, small: Source): MarkCuts {
	const dark = graded(full);
	const pale = graded(light);
	const smallColour = colourOf(small);
	// The small cut has no gradient ids, so its paths are the facets in MARK_PARTS order.
	const smallFacets = paths(small).map((tag, index) => {
		const part = MARK_PARTS[index] as MarkPart;
		return { part, d: attribute(tag, "d") ?? fail(small, part, "path has no d"), colour: smallColour(tag, part) };
	});
	const facets = [...dark].map(([part, facet]): FullFacet => {
		const paired = pale.get(part) ?? fail(light, part, "missing");
		if (paired.stops.length !== facet.stops.length)
			fail(light, part, `${paired.stops.length} gradient stops, the full cut has ${facet.stops.length}`);
		return {
			part,
			d: facet.d,
			gradient: {
				...facet.gradient,
				stops: facet.stops.map((stop, index) => {
					const pair = paired.stops[index] as { offset: string; colour: string };
					if (pair.offset !== stop.offset)
						fail(light, part, `stop ${index + 1} at offset ${pair.offset}, the full cut's is at ${stop.offset}`);
					return { offset: stop.offset, dark: stop.colour, light: pair.colour };
				}),
			},
			flat: smallFacets.find((flat) => flat.part === part)?.colour ?? fail(small, part, "missing"),
		};
	});
	return {
		full: { viewBox: viewBoxOf(full), facets },
		small: { viewBox: viewBoxOf(small), facets: smallFacets },
	};
}
