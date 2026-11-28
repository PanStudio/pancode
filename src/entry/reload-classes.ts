// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readStrictLayeredSettings } from "../core/settings-layers.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import { diffSettings, settingsChangeKind } from "../domains/config/classify.js";
import type { ConfigContract } from "../domains/config/contract.js";
import type { InstalledExtension } from "../domains/extensions/types.js";
import type { InstalledPlugin, PluginSnapshot } from "../domains/plugins/types.js";
import { loadFragments } from "../domains/prompts/fragment-loader.js";
import type { ReloadClassesController, ReloadReport } from "../session-control/reload-report.js";
import { resetDocsIndex } from "../tools/context/docs-engine.js";
import type { McpCapabilitySource, McpDeclarationReload } from "../tools/gateway/mcp-capability-types.js";
import { createIdleDeferral } from "./idle-deferral.js";

type Inventory = Map<string, string>;

function leaves(value: unknown, prefix = "", result: Inventory = new Map()): Inventory {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, result);
	} else result.set(prefix, JSON.stringify(value) ?? "undefined");
	return result;
}

function packages(entries: ReadonlyArray<InstalledExtension | InstalledPlugin>): Inventory {
	return new Map(
		entries.map((entry) => [
			`${entry.scope}:${entry.id}`,
			JSON.stringify({
				digest: entry.observedContentDigest ?? entry.provenance?.contentDigest,
				root: entry.rootPath,
				enabled: entry.enabled,
				loadable: entry.loadable,
			}),
		]),
	);
}

function inventoryChanges(
	before: Inventory,
	after: Inventory,
): Record<"added" | "removed" | "modified" | "unchanged", string[]> {
	const result: ReturnType<typeof inventoryChanges> = { added: [], removed: [], modified: [], unchanged: [] };
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const kind = !before.has(key)
			? "added"
			: !after.has(key)
				? "removed"
				: before.get(key) !== after.get(key)
					? "modified"
					: "unchanged";
		result[kind].push(key);
	}
	for (const values of Object.values(result)) values.sort();
	return result;
}

function summary(label: string, before: Inventory, after: Inventory): string[] {
	const changed = inventoryChanges(before, after);
	return [
		label,
		...Object.entries(changed).map(
			([kind, ids]) => `  ${kind}: ${ids.length}${kind === "unchanged" || ids.length === 0 ? "" : ` (${ids.join(", ")})`}`,
		),
	];
}

interface ReloadClassesDeps {
	config: ConfigContract | undefined;
	bus: TelemetryHub;
	cwd(): string;
	hub(): PluginSnapshot | undefined;
	reloadHub(): PluginSnapshot;
	extensions(): ReadonlyArray<InstalledExtension>;
	mcp?: {
		/** The session's MCP source; absent when this session loaded none. */
		source(): Pick<McpCapabilitySource, "reloadDeclarations"> | null | undefined;
		/** No turn is streaming or preparing; a swap waits for it. */
		idle(): boolean;
	};
	/** Fragment root to read; tests point it at a temporary tree. Defaults to the running package's. */
	fragmentsRoot?: string;
}

function fragmentInventory(rootDir: string | undefined): Inventory {
	const table = loadFragments(rootDir === undefined ? undefined : { rootDir });
	return new Map([...table.byId].map(([id, fragment]) => [id, fragment.contentHash]));
}

function mcpSection(reload: McpDeclarationReload): { lines: string[]; failed: boolean } {
	const count = (kind: string, ids: string[]) =>
		`  ${kind}: ${ids.length}${ids.length === 0 ? "" : ` (${ids.join(", ")})`}`;
	return {
		lines: [
			"MCP servers",
			count("added", reload.added),
			count("removed", reload.removed),
			count("changed", reload.changed),
			`  unchanged: ${reload.unchanged.length}`,
			`  needs trust: ${reload.needsTrust.length === 0 ? "none" : `${reload.needsTrust.join(", ")}; trust each with pancode mcp trust <id>, then /reload mcp`}`,
			"  added and changed servers launch on their next use; removed ones are closed",
			...reload.diagnostics.map((issue) => `  issue: ${issue}`),
			...(reload.diagnostics.length === 0 ? ["  failed: none"] : []),
		],
		failed: reload.diagnostics.length > 0,
	};
}

/** Owns just one command's reporting scope; the existing reloads remain the writers. */
export function createReloadClasses(deps: ReloadClassesDeps): ReloadClassesController {
	let active = false;
	let issues: string[] = [];
	let extensionCommit: string | null = null;
	let configFailure: string | null = null;
	const bootSettings = deps.config ? structuredClone(deps.config.get()) : undefined;
	let reportedSettings = bootSettings;
	let reportedFragments: Inventory | null = null;
	try {
		reportedFragments = fragmentInventory(deps.fragmentsRoot);
	} catch {
		// The prompts domain reports a broken table at boot; the first reload compares against itself.
	}
	deps.bus.subscribe("config.reload_failed", ({ message }) => {
		configFailure = message;
	});
	// A swap that waited for a turn or a call in flight runs once the session settles, and reports as a notice.
	const mcpDeferral = createIdleDeferral(deps.bus, () => deps.mcp?.idle() ?? false);
	let mcpDeferralGen = 0;
	const cancelMcpDeferral = (): void => {
		mcpDeferralGen += 1;
		mcpDeferral.cancel();
	};
	const deferMcpSwap = (source: Pick<McpCapabilitySource, "reloadDeclarations">): void => {
		const gen = ++mcpDeferralGen;
		mcpDeferral.defer(async () => {
			try {
				const swap = await source.reloadDeclarations();
				if (gen !== mcpDeferralGen) return true;
				if (swap === null) return false;
				const section = mcpSection(swap);
				deps.bus.emit("reload.applied", {
					target: "mcp",
					text: `MCP servers swapped after the turn settled: ${section.lines
						.slice(1)
						.map((line) => line.trim())
						.join("; ")}`,
					failed: section.failed,
				});
				return true;
			} catch (error) {
				if (gen !== mcpDeferralGen) return true;
				const message = error instanceof Error ? error.message : String(error);
				if (message === "MCP capability source is closed") return true;
				deps.bus.emit("reload.applied", {
					target: "mcp",
					text: `MCP servers swap failed after the turn settled: ${message}`,
					failed: true,
				});
				return true;
			}
		});
	};
	return {
		get active() {
			return active;
		},
		captureIssue(message) {
			if (!active) return false;
			issues.push(message);
			return true;
		},
		captureExtensionCommit(line) {
			if (!active) return false;
			extensionCommit = line;
			return true;
		},
		async run(target, reloadOperators): Promise<ReloadReport> {
			if (active) return { failed: true, text: "Reload refused: another reload report is in progress." };
			active = true;
			issues = [];
			extensionCommit = null;
			const lines = [`Reload report (${target})`];
			let failed = false;
			const failure = (label: string, error: unknown): void => {
				failed = true;
				lines.push(`${label}: failed — ${error instanceof Error ? error.message : String(error)}`);
			};
			try {
				if (target === "all" || target === "settings") {
					try {
						const config = deps.config;
						if (!config?.reload) throw new Error("settings domain is not available; restart to recover it");
						// Watchers may have applied the edit already. Compare to the last report,
						// while restart-bound differences remain pending against this boot.
						const before = reportedSettings ?? structuredClone(config.get());
						// The watcher intentionally swallows invalid files. Validate before invoking it,
						// and retain its namespace rejection for the report as well.
						readStrictLayeredSettings(deps.cwd());
						configFailure = null;
						config.reload();
						if (configFailure) throw new Error(configFailure);
						const after = config.get();
						reportedSettings = structuredClone(after);
						lines.push(...summary("Settings", leaves(before), leaves(after)));
						const diff = diffSettings(before, after);
						const restart = inventoryChanges(leaves(bootSettings ?? before), leaves(after));
						const keys = [...restart.added, ...restart.removed, ...restart.modified];
						lines.push(
							`  restart required: ${keys.filter((key) => settingsChangeKind(key) === "restartRequired").join(", ") || "none"}`,
						);
						lines.push(`  next turn: ${diff.nextTurn.join(", ") || "none"}`);
						lines.push("  failed: none");
					} catch (error) {
						failure("Settings", error);
					}
				}
				if (target === "all" || target === "hub") {
					const before = packages(deps.hub()?.packages ?? []);
					try {
						const snapshot = deps.reloadHub();
						lines.push(...summary(`PanHub (generation ${snapshot.generation})`, before, packages(snapshot.packages)));
						for (const entry of snapshot.packages)
							for (const issue of entry.diagnostics) {
								if (issue.type === "error") failed = true;
								lines.push(`  ${issue.type}: ${entry.id}: ${issue.message}`);
							}
						lines.push(
							"  reloaded: skills, playbooks and prompt fragments; agent recipes only from changed packages (/reload prompts rediscovers all); session catalogs re-read on the next request",
						);
						lines.push("  restart required: none");
						if (!snapshot.packages.some((entry) => entry.diagnostics.some((issue) => issue.type === "error")))
							lines.push("  failed: none");
					} catch (error) {
						failure("PanHub", error);
					}
				}
				if (target === "all" || target === "extensions") {
					const before = packages(deps.extensions());
					try {
						const result = await reloadOperators();
						lines.push(...summary("Extensions (operator runtimes and paired hooks)", before, packages(deps.extensions())));
						lines.push(`  ${result.status}: ${result.message}`);
						if (extensionCommit) lines.push(`  ${extensionCommit}`);
						if (result.status === "rejected" || result.failures.length > 0) failed = true;
						for (const issue of new Set([...issues, ...result.failures])) lines.push(`  issue: ${issue}`);
						if (result.status !== "rejected" && result.failures.length === 0 && issues.length === 0)
							lines.push("  failed: none");
						lines.push(`  next session: ${result.nextSession.join("; ") || "none"}`);
						lines.push("  restart required: none for operator runtimes and hooks");
					} catch (error) {
						failure("Extensions", error);
					}
				}
				if (target === "all" || target === "prompts") {
					try {
						const before = reportedFragments ?? fragmentInventory(deps.fragmentsRoot);
						// Validate first: a broken fragment fails here and the domains keep their tables.
						const after = fragmentInventory(deps.fragmentsRoot);
						const recipeFailures: string[] = [];
						deps.bus.emit("prompts.reload_requested", { cwd: deps.cwd(), failures: recipeFailures });
						reportedFragments = after;
						resetDocsIndex();
						lines.push(...summary("Prompt fragments", before, after));
						if (recipeFailures.length === 0) lines.push("  recipes: rediscovered");
						else failure("  Agent recipes (plugin recipes withdrawn)", recipeFailures.join("; "));
						lines.push("  session sources (handbook, project rules, catalogs) and docs index: re-read on the next request");
						lines.push("  prompt prefix changed; the next request re-sends it uncached");
						if (recipeFailures.length === 0) lines.push("  failed: none");
					} catch (error) {
						failure("Prompt fragments (previous table kept)", error);
					}
				}
				if (target === "all" || target === "mcp") {
					try {
						const source = deps.mcp?.source();
						const idle = deps.mcp?.idle() === true;
						if (source && idle) cancelMcpDeferral();
						const swap = source && idle ? await source.reloadDeclarations() : null;
						if (!source)
							lines.push("MCP servers", "  this session loaded no MCP source; a new session reads its MCP declarations");
						else if (swap === null) {
							deferMcpSwap(source);
							lines.push(
								"MCP servers",
								"  deferred: a turn or an MCP call is running; the swap runs once it settles and reports then",
							);
						} else {
							const section = mcpSection(swap);
							lines.push(...section.lines);
							if (section.failed) failed = true;
						}
					} catch (error) {
						failure("MCP servers", error);
					}
				}
				lines.push(
					"Restart-bound classes: compiled source (everything under src/**/*.ts), core tool schemas, provider runtimes, runtime plugins, safety rule packs, config/session schemas and pane host are not reloaded by these commands.",
				);
				deps.bus.emit("session.reloaded", { target, failed });
				return { text: lines.join("\n"), failed };
			} finally {
				active = false;
			}
		},
	};
}
