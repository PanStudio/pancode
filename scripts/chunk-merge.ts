// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { Metafile, Plugin } from "esbuild";
import { type OutputChunk, rollup } from "rollup";

/**
 * Merges esbuild's split chunks into the few files each boot path loads.
 *
 * esbuild puts a module in the chunk named by the exact set of entries and
 * `import()` targets that reach it. With about 250 of those the build has 700
 * chunks, an interactive boot loads 425 of them, and Node spends about 0.33 ms
 * resolving, reading and linking each one whatever its size: 262 ms of loader
 * time for the Stage 0 plus composition-root graph against 137 ms when the same
 * code is one file (warm compile cache, median of 10, same host). esbuild has
 * no manual chunking, so this pass regroups its output: every chunk gets a key,
 * chunks with one key become one file, and rollup does the merge because it
 * rewrites the imports, exports and `import()` sites of plain ES modules
 * without touching the code between them.
 *
 * A chunk's cell has two parts, and chunks never merge across cells:
 *   1. the first session boot stage that loads the chunk, so a stage's file
 *      holds nothing an earlier stage could have done without and the staged
 *      preload in src/entry/stage1-preload.ts keeps its event-loop turns;
 *   2. which exact paths reach it ({@link EXACT_PATHS}), so the launcher, a
 *      headless run, a native worker and the Stage 0 owner each load exactly
 *      the chunks they loaded before, only in fewer files.
 * Inside a cell, chunks fold together while every other load stays cheap. A
 * merged file loads whole, and it pulls in the imports of every chunk in it,
 * so an `import()` that needed three chunks of a group can end up loading
 * megabytes. Every import() site and entry outside the exact paths is costed
 * by what its target loads transitively, and a fold must leave each of them
 * within {@link ALLOWANCE_FLOOR_MS} or {@link ALLOWANCE_SHARE} of its load
 * time. Cells fold in boot order, and inside a cell pairs fold in the order
 * of what merging them costs on the unmerged graph, ties broken by source
 * paths. The grouping so depends on the module graph alone: esbuild's output
 * order and chunk hashes decide nothing, and an import added or removed in
 * one corner of the graph regroups only the cells it touches and those folded
 * after them.
 * If chunk A imports chunk B, B's stage is no later and its paths are a
 * superset, so the cells form a DAG exactly as the chunks did; every fold
 * re-checks that no third file sits on an import path between the two.
 */

/** The interactive session's `import()` crossings, in boot order (src/cli/pancode.ts, src/entry/stage1-preload.ts). */
const SESSION_STAGES: ReadonlyArray<readonly [name: string, roots: ReadonlyArray<string>]> = [
	["entry", ["src/cli/index.ts"]],
	// What the workspace launcher loads before it starts the pane host; the pane session repeats it.
	[
		"launch",
		["src/core/compile-cache.ts", "src/cli/pancode.ts", "src/cli/workspace-check.ts", "src/cli/workspace-launch.ts"],
	],
	// The rest of what runs before the first frame.
	[
		"shell",
		[
			"src/cli/project-trust-card.ts",
			"src/domains/mux/workspace/exit-marker.ts",
			"src/core/terminal-background.ts",
			"src/interactive/terminal-lease.ts",
		],
	],
	// The preloader stands alone: sharing a file with the stage it is about to load would link that whole stage
	// as its own import, in one task, before it could yield once.
	["preload", ["src/entry/stage1-preload.ts"]],
	["providers", ["src/domains/providers/index.ts"]],
	["session", ["src/domains/session/index.ts"]],
	[
		"domains",
		[
			"src/domains/telemetry/index.ts",
			"src/domains/dispatch/index.ts",
			"src/domains/memory/index.ts",
			"src/domains/context/index.ts",
			"src/domains/resources/index.ts",
			"src/domains/safety/index.ts",
			"src/tools/bootstrap.ts",
		],
	],
	["orchestrator", ["src/entry/orchestrator.ts"]],
	["interactive", ["src/interactive/index.ts"]],
];

/**
 * Load paths other than the session's that stay exact: each loads the chunks it
 * loaded before the merge and no others. A path lists every root its process
 * crosses from the entry on, so chunks all of them load anyway are not split
 * apart. `stage0` lists the instant shell's owner alone, and `runHelp` exists
 * although `headless` covers it, because
 * tests/extended/instant-shell-import-graph.test.ts budgets the owner's
 * static closure and pins `run --help` to load nothing of the run command.
 * `help` keeps `help --json` to the kit and the command specs: without it the
 * kit shared a file with the import() namespace stub of
 * src/domains/prompts/preload.ts, whose imports load the session stage.
 * `fleetStatus` keeps `fleet status` off the providers stage, and
 * `fleetStatusRows` keeps the ledger rows it loads by `import()` off the
 * domain barrels (src/domains/store/index.ts, src/domains/agents/index.ts,
 * src/domains/plugins/index.ts) that the allowance alone lets share a file
 * with them. A path's third element names roots it follows: everything their
 * own code reaches by `import()` joins the path, so a new import() site in
 * src/cli/fleet-status.ts needs no root of its own here.
 */
const EXACT_PATHS: ReadonlyArray<
	readonly [name: string, roots: ReadonlyArray<string>, follow?: ReadonlyArray<string>]
> = [
	// The workspace launcher: the launch stage plus what starts the pane host and the session inside it.
	[
		"launcher",
		[
			"src/cli/index.ts",
			"src/core/compile-cache.ts",
			"src/cli/pancode.ts",
			"src/cli/workspace-check.ts",
			"src/cli/workspace-launch.ts",
			"src/domains/mux/workspace/platform.ts",
			"src/lib/programs/index.ts",
			"src/domains/mux/workspace/launch.ts",
			"src/domains/mux/child-env.ts",
			"src/core/terminal-background.ts",
		],
	],
	["stage0", ["src/interactive/terminal-lease.ts"]],
	[
		"headless",
		[
			"src/cli/index.ts",
			"src/cli/run-help.ts",
			"src/core/compile-cache.ts",
			"src/cli/run.ts",
			"src/entry/orchestrator.ts",
		],
	],
	["worker", ["src/worker/entry.ts"]],
	// A headless run up to its last pre-boot refusal; run.ts imports pancode.ts, and so the orchestrator, only after it.
	// version.ts rides along so the split this path makes never adds a file to `--version`.
	[
		"headlessPreboot",
		["src/cli/index.ts", "src/cli/run-help.ts", "src/core/compile-cache.ts", "src/cli/run.ts", "src/cli/version.ts"],
	],
	["runHelp", ["src/cli/index.ts", "src/cli/run-help.ts"]],
	["help", ["src/cli/index.ts", "src/cli/help-command.ts"]],
	["fleetStatus", ["src/cli/index.ts", "src/cli/fleet-status.ts"]],
	["fleetStatusRows", ["src/cli/index.ts"], ["src/cli/fleet-status.ts"]],
];

/**
 * Load-cost model for the fold, measured on the v081 build (Node 24, 24-core
 * WSL2 host): a megabyte of chunk costs about 25 ms to parse without the
 * compile cache and evaluate, and a file costs about 0.33 ms. The allowance
 * sits inside the run-to-run noise of a cold command.
 */
const MS_PER_MEGABYTE = 25;
const MS_PER_FILE = 0.33;
/** pi-ai, the heaviest external, links 125 files in about 25 ms; every external package is costed as that megabyte. */
const EXTERNAL_PACKAGE_BYTES = 1_000_000;
const ALLOWANCE_FLOOR_MS = 3;
const ALLOWANCE_SHARE = 0.08;

type Outputs = Metafile["outputs"];

/** A set of chunks, one bit per chunk in metafile order. */
type ChunkSet = Uint32Array;
const holds = (set: ChunkSet, chunk: number): boolean => ((set[chunk >>> 5] ?? 0) & (1 << (chunk & 31))) !== 0;
const insert = (set: ChunkSet, chunk: number): void => {
	set[chunk >>> 5] = (set[chunk >>> 5] ?? 0) | (1 << (chunk & 31));
};
const include = (set: ChunkSet, other: ChunkSet): void => {
	for (let word = 0; word < set.length; word += 1) set[word] = (set[word] ?? 0) | (other[word] ?? 0);
};

/** One `import()` site or process start: what loading `to` adds for code that already holds `from`. */
interface LoadUnit {
	from: number;
	to: number;
	/** Bytes and files the load added before the merge, and the estimated milliseconds the merge may add. */
	bytes: number;
	files: number;
	allowance: number;
}

/** The package a bare specifier names: its first segment, or its first two for a scoped package. */
function packageRoot(specifier: string): string {
	return specifier.split("/", specifier.startsWith("@") ? 2 : 1).join("/");
}

function isExternalPackage(specifier: string): boolean {
	return !isBuiltin(packageRoot(specifier));
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable sort key for an esbuild output, separating dynamic-import facades from code chunks with the same source. */
function outputSourceKey(name: string, built: Outputs[string] | undefined): string {
	if (built?.entryPoint !== undefined) return `entry:${built.entryPoint}`;
	const inputs = Object.keys(built?.inputs ?? {}).sort();
	return inputs.length > 0 ? `inputs:${inputs.join("\n")}` : `output:${name}`;
}

/**
 * The file each esbuild output is merged into, keyed by metafile output name.
 * Outputs left out keep a file of their own; `entries` (the build's real entry
 * outputs) always are.
 */
function planChunkGroups(outputs: Outputs, entries: ReadonlySet<string>): Map<string, string> {
	// A package left external loads as its own tree of files the first time anything imports it, so each one is a
	// node of the graph too: a file of its own that no group absorbs, weighed by EXTERNAL_PACKAGE_BYTES.
	const packageOf = (specifier: string): string | undefined =>
		isExternalPackage(specifier) ? `package:${packageRoot(specifier)}` : undefined;
	const packages = new Set<string>();
	for (const built of Object.values(outputs)) {
		for (const edge of built.imports) {
			const name = edge.external ? packageOf(edge.path) : undefined;
			if (name !== undefined) packages.add(name);
		}
	}
	const names = [...Object.keys(outputs), ...packages];
	const index = new Map(names.map((name, chunk) => [name, chunk]));
	const at = (name: string): number => {
		const found = index.get(name);
		if (found === undefined) throw new Error(`chunk-merge: ${name} is imported but was not built`);
		return found;
	};
	const size = names.map((name) => (packages.has(name) ? EXTERNAL_PACKAGE_BYTES : (outputs[name]?.bytes ?? 0)));
	const internal = (name: string, dynamic: boolean): number[] =>
		(outputs[name]?.imports ?? [])
			.filter((edge) => (edge.kind === "dynamic-import") === dynamic)
			.map((edge) => (edge.external ? packageOf(edge.path) : edge.path))
			.filter((target) => target !== undefined)
			.map(at);
	const imports = names.map((name) => internal(name, false));
	const emptySet = (): ChunkSet => new Uint32Array(Math.ceil(names.length / 32));
	const closures: Array<ChunkSet | undefined> = [];
	const closure = (chunk: number): ChunkSet => {
		const known = closures[chunk];
		if (known) return known;
		const reached = emptySet();
		closures[chunk] = reached;
		insert(reached, chunk);
		for (const target of imports[chunk] ?? []) include(reached, closure(target));
		return reached;
	};
	const byEntryPoint = new Map<string, number>();
	names.forEach((name, chunk) => {
		const source = outputs[name]?.entryPoint;
		if (source !== undefined) byEntryPoint.set(source, chunk);
	});
	const reach = (roots: ReadonlyArray<string>): ChunkSet => {
		const all = emptySet();
		for (const root of roots) {
			const chunk = byEntryPoint.get(root);
			// A stale root would silently leave its stage unmerged, so it fails the build instead.
			if (chunk === undefined) {
				throw new Error(
					`chunk-merge: ${root} is no longer an entry or import() target; update the roots in scripts/chunk-merge.ts`,
				);
			}
			include(all, closure(chunk));
		}
		return all;
	};

	// A chunk's cell is its stage and exact paths. Chunks never merge across cells, which is what keeps those exact.
	const stages = SESSION_STAGES.map(([stage, roots]) => [stage, reach(roots)] as const);
	// What a followed root's own code reaches by import() joins its path, and is exempt from the allowance as roots are.
	const followed = new Set<number>();
	const exact = EXACT_PATHS.map(([path, roots, follow = []]) => {
		const loaded = reach([...roots, ...follow]);
		const others = reach(roots);
		for (const root of follow) {
			const own = reach([root]);
			names.forEach((name, chunk) => {
				if (!holds(own, chunk) || holds(others, chunk)) return;
				for (const target of internal(name, true)) {
					followed.add(target);
					include(loaded, closure(target));
				}
			});
		}
		return [path, loaded] as const;
	});
	const cellOf = names.map((name, chunk) => {
		if (entries.has(name) || packages.has(name)) return undefined;
		const stage = stages.find(([, chunks]) => holds(chunks, chunk))?.[0] ?? "";
		const held = exact.filter(([, chunks]) => holds(chunks, chunk)).map(([path]) => path);
		return `${stage}|${held.join("+")}`;
	});

	// group[chunk] names the group a chunk merges into by one of its members, or is -1 for a file of its own.
	const group = new Int32Array(names.length).fill(-1);
	const node = (chunk: number): number => ((group[chunk] ?? -1) === -1 ? chunk : (group[chunk] ?? -1));
	const members = new Map<number, number[]>();
	cellOf.forEach((cell, chunk) => {
		if (cell === undefined) return;
		group[chunk] = chunk;
		members.set(chunk, [chunk]);
	});

	/**
	 * What each merged file loads: itself and everything its members import, transitively. A merged file drags in
	 * the imports of every member, so this, not the group's own size, is what a load costs. Undefined when the
	 * files would import each other in a cycle.
	 */
	const settle = (): Array<ChunkSet | undefined> | undefined => {
		const importers = new Int32Array(names.length);
		for (let chunk = 0; chunk < names.length; chunk += 1) {
			for (const target of imports[chunk] ?? []) {
				if (node(target) !== node(chunk)) importers[node(target)] = (importers[node(target)] ?? 0) + 1;
			}
		}
		// Kahn's algorithm: importers settle first, so the reverse order visits every file after its imports.
		const order: number[] = [];
		const ready: number[] = [];
		let files = 0;
		for (let chunk = 0; chunk < names.length; chunk += 1) {
			if (node(chunk) !== chunk) continue;
			files += 1;
			if (importers[chunk] === 0) ready.push(chunk);
		}
		for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
			order.push(id);
			for (const chunk of members.get(id) ?? [id]) {
				for (const target of imports[chunk] ?? []) {
					const other = node(target);
					if (other === id) continue;
					importers[other] = (importers[other] ?? 0) - 1;
					if (importers[other] === 0) ready.push(other);
				}
			}
		}
		if (order.length !== files) return undefined;
		const loads: Array<ChunkSet | undefined> = [];
		const included = new Int32Array(names.length).fill(-1);
		for (const id of order.reverse()) {
			const loaded = emptySet();
			for (const chunk of members.get(id) ?? [id]) {
				insert(loaded, chunk);
				for (const target of imports[chunk] ?? []) {
					const other = node(target);
					const theirs = loads[other];
					if (other === id || included[other] === id || theirs === undefined) continue;
					included[other] = id;
					include(loaded, theirs);
				}
			}
			loads[id] = loaded;
		}
		return loads;
	};

	// Every import() site whose target is not a stage or exact-path root, and every other entry, is a load the
	// merge must not make much dearer. Stage roots, exact-path roots and followed targets are exempt: their cells keep
	// them exact.
	const megabytes = (count: number): number => (count / 1e6) * MS_PER_MEGABYTE;
	const rooted = new Set([
		...SESSION_STAGES.flatMap(([, roots]) => roots),
		...EXACT_PATHS.flatMap(([, roots, follow = []]) => [...roots, ...follow]),
	]);
	const isRooted = (chunk: number): boolean =>
		followed.has(chunk) || rooted.has(outputs[names[chunk] ?? ""]?.entryPoint ?? "");
	const units: LoadUnit[] = [];
	const addUnit = (from: number, to: number): void => {
		if (isRooted(to) || packages.has(names[to] ?? "") || (from !== -1 && holds(closure(from), to))) return;
		const unit = { from, to, bytes: 0, files: 0, allowance: 0 };
		const held = from === -1 ? emptySet() : closure(from);
		names.forEach((_, chunk) => {
			if (!holds(closure(to), chunk) || holds(held, chunk)) return;
			unit.bytes += size[chunk] ?? 0;
			unit.files += 1;
		});
		unit.allowance = Math.max(ALLOWANCE_FLOOR_MS, ALLOWANCE_SHARE * (megabytes(unit.bytes) + unit.files * MS_PER_FILE));
		units.push(unit);
	};
	names.forEach((name, chunk) => {
		if (entries.has(name)) addUnit(-1, chunk);
		for (const target of new Set(internal(name, true))) addUnit(chunk, target);
	});
	/** Estimated milliseconds the merge costs a load beyond its allowance, or 0 inside it. */
	const excess = (unit: LoadUnit, loaded: ChunkSet, held: ChunkSet | undefined): number => {
		let bytes = 0;
		let files = 0;
		for (let word = 0; word < loaded.length; word += 1) {
			let added = (loaded[word] ?? 0) & ~(held?.[word] ?? 0);
			while (added !== 0) {
				const low = added & -added;
				const chunk = word * 32 + 31 - Math.clz32(low);
				bytes += size[chunk] ?? 0;
				if (node(chunk) === chunk) files += 1;
				added ^= low;
			}
		}
		const cost = megabytes(bytes - unit.bytes) - (unit.files - files) * MS_PER_FILE;
		return cost > unit.allowance ? cost : 0;
	};

	// Fold two groups of a cell into one whenever every load stays inside its allowance and the merged files still
	// form a DAG. Folding two files only changes what the files that reach either of them load, which becomes the
	// union of both, so a trial updates those sets instead of settling the graph again.
	const loads = settle();
	if (loads === undefined) throw new Error("chunk-merge: esbuild's chunks import each other in a cycle");
	const loadsOf = (id: number): ChunkSet => loads[id] ?? emptySet();
	const fold = (small: number, host: number): boolean => {
		const chunks = members.get(small) ?? [];
		const into = members.get(host) ?? [];
		// A third file on an import path between the two would end up importing, and imported by, the merged file.
		for (const [near, far] of [
			[small, host],
			[host, small],
		] as const) {
			for (let chunk = 0; chunk < names.length; chunk += 1) {
				if (chunk === near || chunk === far || node(chunk) !== chunk || !holds(loadsOf(near), chunk)) continue;
				if (holds(loadsOf(chunk), far)) return false;
			}
		}
		const merged = loadsOf(small).slice();
		include(merged, loadsOf(host));
		const after = (id: number): ChunkSet => {
			const before = loadsOf(id);
			if (!holds(before, small) && !holds(before, host)) return before;
			const widened = before.slice();
			include(widened, merged);
			return widened;
		};
		const nodes = units.map((unit) => [node(unit.to), unit.from === -1 ? -1 : node(unit.from)] as const);
		for (const chunk of chunks) group[chunk] = host;
		const fits = units.every((unit, at) => {
			const [to, from] = nodes[at] ?? [-1, -1];
			const loaded = after(to);
			const held = from === -1 ? undefined : after(from);
			// A load neither file is part of costs what it did, which was inside its allowance.
			if (loaded === loadsOf(to) && (from === -1 || held === loadsOf(from))) return true;
			return excess(unit, loaded, held) === 0;
		});
		if (!fits) {
			for (const chunk of chunks) group[chunk] = small;
			return false;
		}
		for (let id = 0; id < names.length; id += 1) if (loads[id] !== undefined) loads[id] = after(id);
		loads[host] = merged;
		loads[small] = undefined;
		members.delete(small);
		members.set(host, [...into, ...chunks]);
		return true;
	};
	// The fold order is fixed on the unmerged graph, so the grouping so far never steers it. Merging two chunks costs
	// a load that needs one and not the other the bytes the other drags in that the load did not hold anyway; a
	// pair's cost is the worst such share of an allowance. Ties fall to source paths, never to output order or hashes.
	const sourceKey = names.map((name) => outputSourceKey(name, outputs[name]));
	const byKey = (a: number, b: number): number => compareText(sourceKey[a] ?? "", sourceKey[b] ?? "");
	const minus = (set: ChunkSet, other: ChunkSet): ChunkSet => set.map((word, at) => word & ~(other[at] ?? 0));
	const needs = units.map((unit) => (unit.from === -1 ? closure(unit.to) : minus(closure(unit.to), closure(unit.from))));
	const seen = units.map((unit) => {
		const held = closure(unit.to).slice();
		if (unit.from !== -1) include(held, closure(unit.from));
		return held;
	});
	const needers = names.map((_, chunk) => units.flatMap((_, at) => (holds(needs[at] ?? emptySet(), chunk) ? [at] : [])));
	const drag = (chunk: number, at: number): number => {
		const dragged = minus(closure(chunk), seen[at] ?? emptySet());
		let bytes = 0;
		for (let word = 0; word < dragged.length; word += 1) {
			for (let bits = dragged[word] ?? 0; bits !== 0; bits &= bits - 1) {
				bytes += size[word * 32 + 31 - Math.clz32(bits & -bits)] ?? 0;
			}
		}
		return megabytes(bytes) / (units[at]?.allowance ?? 1);
	};
	const pairCost = (a: number, b: number): number => {
		const forA = new Set(needers[a]);
		const forB = new Set(needers[b]);
		let cost = 0;
		for (const at of forA) if (!forB.has(at)) cost = Math.max(cost, drag(b, at));
		for (const at of forB) if (!forA.has(at)) cost = Math.max(cost, drag(a, at));
		return cost;
	};

	// Cells fold in boot order, the cells more paths share first, so a cell's grouping depends only on the cells
	// folded before it. Inside a cell every pair a load could afford is tried cheapest first until none folds.
	const cells = new Map<string, number[]>();
	for (const id of members.keys()) {
		const cell = cellOf[id] ?? "|";
		cells.set(cell, [...(cells.get(cell) ?? []), id]);
	}
	const stageRank = (cell: string): number => {
		const at = SESSION_STAGES.findIndex(([stage]) => stage === cell.slice(0, cell.indexOf("|")));
		return at === -1 ? SESSION_STAGES.length : at;
	};
	const pathCount = (cell: string): number =>
		cell
			.slice(cell.indexOf("|") + 1)
			.split("+")
			.filter(Boolean).length;
	const cellOrder = [...cells.keys()].sort(
		(a, b) => stageRank(a) - stageRank(b) || pathCount(b) - pathCount(a) || (a < b ? -1 : a > b ? 1 : 0),
	);
	for (const cell of cellOrder) {
		const chunks = (cells.get(cell) ?? []).sort(byKey);
		const pairs: Array<readonly [cost: number, a: number, b: number]> = [];
		chunks.forEach((a, at) => {
			for (const b of chunks.slice(at + 1)) {
				const cost = pairCost(a, b);
				if (cost <= 1) pairs.push([cost, a, b]);
			}
		});
		pairs.sort((p, q) => p[0] - q[0] || byKey(p[1], q[1]) || byKey(p[2], q[2]));
		for (let folded = true; folded; ) {
			folded = false;
			for (const [, a, b] of pairs) {
				if (node(a) !== node(b) && fold(node(a), node(b))) folded = true;
			}
		}
	}

	const plan = new Map<string, string>();
	const counters = new Map<string, number>();
	const ordered = [...members.keys()].sort((a, b) => byKey(a, b) || compareText(names[a] ?? "", names[b] ?? ""));
	for (const id of ordered) {
		const cell = cellOf[id] ?? "|";
		const stage = cell.slice(0, cell.indexOf("|"));
		const prefix = stage === "" ? "shared" : `boot-${stage}`;
		const count = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, count);
		for (const chunk of members.get(id) ?? []) plan.set(names[chunk] ?? "", `${prefix}-${count}`);
	}
	return plan;
}

export interface BuiltFile {
	/** Absolute path under the build's output directory. */
	path: string;
	text: string;
}

interface MergeOptions {
	files: ReadonlyArray<BuiltFile>;
	metafile: Metafile;
	/** Absolute output directory the files and the metafile's output names live under. */
	outdir: string;
	/** Output names of the build's real entries, as the metafile spells them. */
	entries: ReadonlySet<string>;
	/** The banner esbuild put on every chunk; it is removed from each and written once per merged file. */
	banner: string;
}

/** The string src/entry/stage1-preload.ts carries where the build writes the Stage 1 file list. */
const STAGE1_FILES_MARKER = "pancode:stage1-files";
/** The stages that module loads file by file, and the ones already loaded when it runs. */
const PRELOADED_STAGES = new Set(["providers", "session", "domains", "orchestrator"]);
const LOADED_BEFORE_PRELOAD = new Set(["entry", "launch", "shell", "preload"]);
/** A module that exists only inside the merge: it imports every export of every chunk. */
const EVERY_EXPORT = "\0every-chunk-export";

/** Rollup notes that describe esbuild's output rather than a defect in the merge. */
const EXPECTED_NOTES = new Set(["THIS_IS_UNDEFINED", "EVAL"]);

/**
 * Regroup one build's chunks per {@link planChunkGroups} and return the files
 * to write with a metafile that describes them: each merged output lists the
 * source inputs of every chunk it absorbed, so byte budgets and the release
 * artifact keep reading true numbers.
 */
async function mergeChunks(options: MergeOptions): Promise<{ files: BuiltFile[]; metafile: Metafile }> {
	const { metafile, outdir, entries, banner } = options;
	const stray = options.files.find((file) => !file.path.endsWith(".js"));
	// Source maps would need composing through the merge; the build ships none.
	if (stray) throw new Error(`chunk-merge: cannot carry ${stray.path} through the merge`);
	const nameOf = new Map<string, string>();
	for (const name of Object.keys(metafile.outputs)) nameOf.set(resolve(name), name);
	const prefix = relative(process.cwd(), outdir).replaceAll("\\", "/");
	const code = new Map<string, string>();
	const hashbangs = new Map<string, string>();
	for (const file of options.files) {
		if (!nameOf.has(file.path)) throw new Error(`chunk-merge: ${file.path} is missing from the metafile`);
		let text = file.text;
		if (text.startsWith("#!")) {
			const end = text.indexOf("\n");
			hashbangs.set(file.path, text.slice(0, end));
			text = text.slice(end + 1);
		}
		if (text.startsWith(`${banner}\n`)) text = text.slice(banner.length + 1);
		code.set(file.path, text);
	}
	const plan = planChunkGroups(metafile.outputs, entries);
	// Every chunk is placed by hand, single ones under their own name: left to its own chunking rollup may fold a
	// chunk into an entry file in a subdirectory, and code that resolves paths from import.meta.url would move with it.
	const alias = (id: string): string | undefined => {
		const name = nameOf.get(id);
		if (name === undefined || entries.has(name)) return undefined;
		return plan.get(name) ?? name.slice(name.lastIndexOf("/") + 1, -".js".length);
	};
	for (const [id, name] of nameOf) {
		if (entries.has(name)) continue;
		for (const edge of metafile.outputs[name]?.imports ?? []) {
			if (edge.kind !== "dynamic-import" && entries.has(edge.path)) {
				throw new Error(`chunk-merge: ${name} statically imports the entry ${edge.path}; ${id} cannot be placed`);
			}
		}
	}

	const input: Record<string, string> = {};
	for (const entry of [...entries].sort(compareText))
		input[relative(prefix, entry).slice(0, -".js".length)] = resolve(entry);
	// A merged file exports only what another file imports, so a symbol every importer was merged with would stop
	// being reachable from outside. One more entry that imports every chunk export keeps each one exported from
	// the file it lands in, as esbuild's chunks exported them; its own output is discarded.
	const everyExport = [...nameOf]
		.filter(([, name]) => !entries.has(name))
		.sort(
			([, left], [, right]) =>
				compareText(outputSourceKey(left, metafile.outputs[left]), outputSourceKey(right, metafile.outputs[right])) ||
				compareText(left, right),
		)
		.map(([id, name], chunk) => {
			const exported = (metafile.outputs[name]?.exports ?? []).map((binding, at) => `${binding} as e${chunk}_${at}`);
			return `export{${exported.join(",")}}from${JSON.stringify(id)};`;
		});
	input["every-chunk-export"] = EVERY_EXPORT;
	const sourceOf = (source: string): string => {
		const name = Object.keys(metafile.outputs).find((output) => metafile.outputs[output]?.entryPoint === source);
		if (name === undefined) throw new Error(`chunk-merge: ${source} is no longer an entry or import() target`);
		return resolve(name);
	};
	let preloadLists = 0;
	const bundle = await rollup({
		input,
		treeshake: false,
		preserveEntrySignatures: "strict",
		plugins: [
			{
				name: "esbuild-chunks",
				resolveId(source, importer) {
					if (importer === undefined || importer === EVERY_EXPORT) return source;
					if (!source.startsWith(".")) return { id: source, external: true };
					const id = resolve(dirname(importer), source);
					if (!code.has(id)) throw new Error(`chunk-merge: ${importer} imports ${source}, which was not built`);
					return id;
				},
				load: (id) => (id === EVERY_EXPORT ? everyExport.join("\n") : (code.get(id) ?? null)),
				// File names here still carry rollup's hash placeholders, which it resolves in the code it is handed
				// back and counts into this file's own hash.
				renderChunk(text, chunk, _options, meta) {
					if (!text.includes(STAGE1_FILES_MARKER)) return null;
					preloadLists += 1;
					const fileOf = new Map<string, string>();
					for (const rendered of Object.values(meta.chunks)) {
						for (const id of rendered.moduleIds) fileOf.set(id, rendered.fileName);
					}
					const seen = new Set([chunk.fileName]);
					const order: string[] = [];
					const visit = (file: string | undefined): void => {
						const rendered = file === undefined ? undefined : meta.chunks[file];
						if (rendered === undefined || seen.has(rendered.fileName)) return;
						seen.add(rendered.fileName);
						for (const imported of rendered.imports) if (meta.chunks[imported] !== undefined) visit(imported);
						// Packages are claimed after the imported files, so a file that imports the same package is
						// never listed before it.
						const packages: string[] = [];
						for (const imported of rendered.imports) {
							if (meta.chunks[imported] === undefined && isExternalPackage(imported) && !seen.has(imported)) {
								seen.add(imported);
								packages.push(imported);
							}
						}
						// A package root that re-exports its subpaths links them all in one task: pi-ai's root alone held
						// the loop for about 150 ms, against at most 22 ms when each subpath loads first on its own turn.
						const subpath = (specifier: string): number => (specifier === packageRoot(specifier) ? 1 : 0);
						order.push(...packages.sort((left, right) => subpath(left) - subpath(right)));
						order.push(rendered.fileName);
					};
					const roots = (stages: ReadonlySet<string>): string[] =>
						SESSION_STAGES.flatMap(([stage, sources]) => (stages.has(stage) ? sources : []));
					for (const source of roots(LOADED_BEFORE_PRELOAD)) visit(fileOf.get(sourceOf(source)));
					const loaded = order.length;
					// Imports first, in statement order: the order Node evaluates the same graph in.
					for (const source of roots(PRELOADED_STAGES)) visit(fileOf.get(sourceOf(source)));
					const files = order.slice(loaded).map((file) => (meta.chunks[file] === undefined ? file : `./${file}`));
					return { code: text.replaceAll(STAGE1_FILES_MARKER, files.join(",")), map: null };
				},
			},
		],
		onLog(level, log) {
			if (level !== "warn" || (log.code !== undefined && EXPECTED_NOTES.has(log.code))) return;
			// esbuild keeps a builtin import whose only user it shook out (hub-signature's `sign` in the runtime);
			// rollup drops it. Any other unused external import still fails the build.
			if (log.code === "UNUSED_EXTERNAL_IMPORT" && log.exporter?.startsWith("node:")) return;
			throw new Error(`chunk-merge: ${log.code ?? "rollup"}: ${log.message}`);
		},
	});
	const generated = await bundle.generate({
		format: "es",
		dir: outdir,
		entryFileNames: "[name].js",
		// esbuild's own content hash comes off the name; rollup's covers the merged file and everything it imports.
		chunkFileNames: (chunk) => `${chunk.name.replace(/-[0-9A-Z]{8}$/u, "")}-[hash].js`,
		hashCharacters: "base36",
		manualChunks: alias,
		hoistTransitiveImports: false,
		minifyInternalExports: false,
		compact: true,
		generatedCode: { preset: "es2015", symbols: true },
		banner,
	});
	await bundle.close();

	if (preloadLists !== 1) {
		throw new Error(
			`chunk-merge: ${preloadLists} files carry ${STAGE1_FILES_MARKER}; src/entry/stage1-preload.ts must hold it once`,
		);
	}
	const chunks = generated.output.filter(
		(item): item is OutputChunk => item.type === "chunk" && item.facadeModuleId !== EVERY_EXPORT,
	);
	const built = new Set(chunks.map((chunk) => chunk.fileName));
	const outputs: Outputs = {};
	const files: BuiltFile[] = [];
	for (const chunk of chunks) {
		const absorbed = chunk.moduleIds.map((id) => nameOf.get(id)).filter((name) => name !== undefined);
		// An entry's file holds that entry alone; every other file holds exactly the chunks planned for its name.
		const placed = new Set(chunk.moduleIds.map(alias));
		const [only] = placed;
		if (placed.size > 1 || (only === undefined ? chunk.moduleIds.length > 1 : chunk.name !== only)) {
			throw new Error(`chunk-merge: ${chunk.fileName} does not hold the chunks planned for it`);
		}
		const hashbang = chunk.isEntry && chunk.facadeModuleId !== null ? hashbangs.get(chunk.facadeModuleId) : undefined;
		const text = hashbang === undefined ? chunk.code : `${hashbang}\n${chunk.code}`;
		files.push({ path: join(outdir, chunk.fileName), text });
		const inputs: Outputs[string]["inputs"] = {};
		for (const name of absorbed) {
			for (const [source, share] of Object.entries(metafile.outputs[name]?.inputs ?? {})) {
				inputs[source] = { bytesInOutput: (inputs[source]?.bytesInOutput ?? 0) + share.bytesInOutput };
			}
		}
		const edge = (path: string, kind: "import-statement" | "dynamic-import"): Outputs[string]["imports"][number] =>
			built.has(path) ? { path: `${prefix}/${path}`, kind } : { path, kind, external: true };
		const facade = chunk.facadeModuleId === null ? undefined : nameOf.get(chunk.facadeModuleId);
		const entryPoint = facade === undefined ? undefined : metafile.outputs[facade]?.entryPoint;
		outputs[`${prefix}/${chunk.fileName}`] = {
			bytes: Buffer.byteLength(text),
			inputs,
			imports: [
				...chunk.imports.map((path) => edge(path, "import-statement")),
				...chunk.dynamicImports.map((path) => edge(path, "dynamic-import")),
			],
			exports: chunk.exports,
			...(entryPoint === undefined ? {} : { entryPoint }),
		};
	}
	return { files, metafile: { inputs: metafile.inputs, outputs } };
}

/**
 * Runs the merge on esbuild's in-memory result, before tsup writes anything, so
 * dist/ only ever holds merged files and the metafile tsup saves describes them.
 */
export function chunkMergePlugin(banner: string): Plugin {
	return {
		name: "pancode-chunk-merge",
		setup(build) {
			build.onEnd(async (result) => {
				if (result.errors.length > 0 || !result.metafile || !result.outputFiles) return;
				const outdir = resolve(build.initialOptions.outdir ?? "dist");
				const prefix = relative(process.cwd(), outdir).replaceAll("\\", "/");
				const entries = new Set(
					Object.keys(build.initialOptions.entryPoints as Record<string, string>).map((name) => `${prefix}/${name}.js`),
				);
				const merged = await mergeChunks({
					files: result.outputFiles.map((file) => ({ path: file.path, text: file.text })),
					metafile: result.metafile,
					outdir,
					entries,
					banner,
				});
				result.metafile = merged.metafile;
				result.outputFiles = merged.files.map((file) => ({
					path: file.path,
					text: file.text,
					contents: Buffer.from(file.text),
					hash: "",
				}));
			});
		},
	};
}
