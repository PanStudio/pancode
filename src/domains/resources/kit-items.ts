// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The PanHub server packs `pankit` adds for another agent host. An added server
 * is a user-scope copy of a `server` pack written by the same plan and writer
 * as `pancode hub install server:<name> --user`, so PanCode lists, updates and
 * offers it like any other copy.
 */
import { loadPluginMcpFile } from "../gateway/mcp/config.js";
import { isPluginId, listInstalledPlugins, readPluginInstallRecord } from "../plugins/index.js";
import { discoverHub } from "./hub.js";
import { applyHubLifecycle, type HubOperation, planHubLifecycle } from "./hub-actions.js";
import { hubCopyState } from "./hub-inventory.js";
import type { HubTier } from "./hub-types.js";

export interface KitAddedServer {
	name: string;
	version: string;
	publisher: string;
	tier?: HubTier;
	loadable: boolean;
	reason?: string;
}

/** What `pankit add` prints once the copy is written. */
export interface KitAddFacts {
	name: string;
	version: string;
	publisher: string;
	tier?: HubTier;
	license?: string;
	sha256: string;
	source: string;
	commit?: string;
	launch: { command: string; args: string[] };
	destination: string;
}

export type KitChangeResult<T> = { ok: true; value: T } | { ok: false; message: string };

const refOf = (name: string): string => `server:${name}`;

function userServerCopy(name: string, cwd: string) {
	return listInstalledPlugins(cwd, { scope: "user", all: true }).find(
		(plugin) => plugin.id === name && plugin.kind === "server",
	);
}

/** The tier each PanHub server row states now; a copy whose row is gone has none. */
function serverTiers(cwd: string): Map<string, HubTier> {
	const tiers = new Map<string, HubTier>();
	for (const entry of discoverHub({ cwd }).entries)
		if (entry.kind === "server" && entry.tier) tiers.set(entry.name, entry.tier);
	return tiers;
}

export function addedKitServers(cwd: string): KitAddedServer[] {
	const copies = listInstalledPlugins(cwd, { scope: "user", all: true }).filter((plugin) => plugin.kind === "server");
	if (copies.length === 0) return [];
	const tiers = serverTiers(cwd);
	return copies
		.map((copy) => {
			const tier = tiers.get(copy.id);
			const state = hubCopyState(copy);
			const detail = copy.diagnostics.find((item) => item.type === "error")?.message;
			return {
				name: copy.id,
				version: copy.version,
				publisher: readPluginInstallRecord(copy.id, { cwd, scope: "user" })?.publisher ?? "local",
				...(tier ? { tier } : {}),
				loadable: copy.loadable,
				...(copy.loadable ? {} : { reason: detail ? `${state}: ${detail}` : state }),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** One lifecycle step on `server:<name>` in user scope; the error is the step's refusal or failure, one line. */
function runStep(operation: HubOperation, name: string, cwd: string, force: boolean) {
	const plan = planHubLifecycle({ operation, ref: refOf(name), scope: "user", cwd, force });
	const apply = applyHubLifecycle(plan, { dryRun: false });
	const step = plan.steps.find((item) => item.identity.ref === refOf(name));
	if (apply.failed === 0 && plan.applicable && step) return { ok: true as const, step };
	const failed = apply.outcomes.find((outcome) => outcome.status === "failed");
	const message = step?.refusal ?? failed?.error?.message ?? plan.diagnostics[0] ?? `${refOf(name)} was not changed`;
	return { ok: false as const, message };
}

export function addKitServer(name: string, cwd: string): KitChangeResult<KitAddFacts> {
	const missing = `no PanHub server pack is named ${name}; find one with \`pancode hub search --kind server\``;
	if (!isPluginId(name)) return { ok: false, message: missing };
	try {
		const hub = discoverHub({ cwd });
		if (!hub.entries.some((entry) => entry.kind === "server" && entry.name === name)) {
			// A revoked row is dropped from discovery with the revocation as its diagnostic.
			const revoked = hub.diagnostics.find((item) => item.startsWith(`pack_revoked: ${name} `));
			return { ok: false, message: revoked ?? missing };
		}
		// Adding again replaces the copy, so a row a PanCode upgrade moved reaches the host.
		const result = runStep("install", name, cwd, userServerCopy(name, cwd) !== undefined);
		if (!result.ok) return result;
		const { step } = result;
		const installed = userServerCopy(name, cwd);
		const loaded = loadPluginMcpFile({
			id: name,
			scope: "user",
			rootPath: step.destination,
			contentDigest: step.source?.sha256 ?? "",
		});
		const server = loaded.servers[0];
		if (!server) return { ok: false, message: loaded.diagnostics[0]?.message ?? `${refOf(name)} declares no server` };
		const license = step.source?.license ?? installed?.manifest?.license;
		return {
			ok: true,
			value: {
				name,
				version: installed?.version ?? step.versions?.to ?? "unknown",
				publisher: step.source?.publisher ?? "local",
				...(step.source?.tier ? { tier: step.source.tier } : {}),
				...(license ? { license } : {}),
				sha256: step.source?.sha256 ?? "",
				source: step.source?.sourceUrl ?? "",
				...(step.source?.commit ? { commit: step.source.commit } : {}),
				launch: { command: server.command, args: [...server.args] },
				destination: step.destination,
			},
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

export function removeKitServer(name: string, cwd: string): KitChangeResult<{ destination: string }> {
	if (userServerCopy(name, cwd) === undefined) return { ok: false, message: `${name} was not added` };
	try {
		const result = runStep("remove", name, cwd, false);
		return result.ok ? { ok: true, value: { destination: result.step.destination } } : result;
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
