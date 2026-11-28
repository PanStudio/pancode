// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import { SettingsOrigin } from "../../contracts/settings.js";
import { CliTargets, Routing, type TargetOperationResult } from "../../contracts/targets-cli.js";
import {
	ACP_TARGET_MODEL_LIMIT,
	ACP_TARGETS_LIST_METHOD,
	ACP_TARGETS_PROBE_METHOD,
	ACP_TRUNCATED_META_KEY,
	AcpTargetList,
	AcpTargetProbe,
} from "../../contracts/wire.js";
import type { AcpClient } from "../acp/client.js";
import { missingComponentRemedy } from "../acp/error-model.js";
import type { Supervisor } from "../acp/supervisor.js";
import type { CliRunner } from "./cli-runner.js";
import { fingerprint, type OperationRegistry } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { SettingsService } from "./settings.js";
import type { WorkspaceService } from "./workspaces.js";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AppProblem("operation_failed", "PanCode returned an invalid inventory.");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || value.length > 256)
		throw new AppProblem("operation_failed", "PanCode returned an invalid inventory field.");
	return value;
}
const optionalText = (value: unknown) => (value === undefined || value === null ? null : text(value));
function items(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 100_000)
		throw new AppProblem("operation_failed", "PanCode returned an invalid inventory collection.");
	return value;
}
async function readTargets(client: AcpClient): Promise<CliTargets> {
	if (!client.capabilities.targets?.list)
		throw new AppProblem("unsupported", "This PanCode build does not expose connection inventory.");
	const raw = Value.Clean(AcpTargetList, await client.request(ACP_TARGETS_LIST_METHOD, {}));
	if (!Value.Check(AcpTargetList, raw))
		throw new AppProblem("upstream_acp", "PanCode returned an invalid connection inventory.");
	const result = {
		targets: raw.targets.map((target) => ({
			id: target.id,
			runtime: target.runtime,
			url: target.url ?? null,
			builtIn: target.url === undefined,
			defaultModel: target.defaultModel ?? null,
			available: target.available ?? false,
			health: target.health ?? "unknown",
			tier: target.tier ?? "unknown",
			models: target.models,
			modelsTruncated: target.modelsTruncated ?? target.models.length >= ACP_TARGET_MODEL_LIMIT,
			contextWindow: target.contextWindow ?? null,
		})),
		truncated: raw._meta?.[ACP_TRUNCATED_META_KEY] === true,
	};
	if (!Value.Check(CliTargets, result))
		throw new AppProblem("upstream_acp", "PanCode returned an invalid connection projection.");
	return result;
}
/** What a probe that did not reach the target means, in the words the connection card uses. */
const PROBE_FAILURE: Record<NonNullable<AcpTargetProbe["reason"]>, string> = {
	"not-configured": "Connection is not reachable: PanCode has no usable credential for it.",
	unreachable: "Connection is not reachable: it did not answer the check.",
	unsupported: "This runtime offers no connection check, so reachability is unknown.",
	"probe-failed": "The connection check could not run, so reachability is unknown.",
	"component-missing": "Connection cannot run yet: its runtime needs a component that is not installed.",
};
/** The probe's sentence for the connection card; a missing component names itself and its install command. */
function probeFailure(probe: AcpTargetProbe | undefined): string {
	const remedy = probe?.reason === "component-missing" ? missingComponentRemedy(probe.component) : null;
	return remedy !== null
		? `Connection cannot run yet: ${remedy}, then check again.`
		: PROBE_FAILURE[probe?.reason ?? "probe-failed"];
}
export class TargetsService {
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
		private readonly settings: SettingsService,
		private readonly operations: OperationRegistry,
		private readonly supervisor: Supervisor,
	) {}
	/** `null` reads the user's own connections, with no project layer over them. */
	private control<T>(workspaceId: string | null, read: (client: AcpClient) => Promise<T>, signal?: AbortSignal) {
		return workspaceId === null
			? this.supervisor.installationControl(read, signal)
			: this.supervisor.workspaceControl(workspaceId, read, signal);
	}
	async list(workspaceId: string | null, signal?: AbortSignal) {
		return this.control(workspaceId, readTargets, signal);
	}
	async mutate(workspaceId: string | null, id: string, action: "probe" | "use" | "remove" | "signout", key: string) {
		const cwd = await this.workspaces.cwd(workspaceId);
		return this.operations.create({
			kind: `targets.${action}`,
			scope: workspaceId ?? "installation",
			key,
			fingerprint: fingerprint({ workspaceId, id, action }),
			cancellable: action === "probe",
			run: async (progress, signal): Promise<TargetOperationResult> => {
				progress(
					action === "probe"
						? "PanCode is probing the selected connection."
						: action === "signout"
							? "PanCode is removing the stored credential."
							: "PanCode is updating user connection settings.",
				);
				let probe: AcpTargetProbe | undefined;
				let probedTargets: CliTargets | undefined;
				try {
					if (action === "probe") {
						const result = await this.control(
							workspaceId,
							async (client) => {
								if (!client.capabilities.targets?.probe)
									throw new AppProblem("unsupported", "This PanCode build does not expose connection probes.");
								const probe = Value.Clean(
									AcpTargetProbe,
									await client.request(ACP_TARGETS_PROBE_METHOD, { targetId: id }, 60_000),
								);
								if (!Value.Check(AcpTargetProbe, probe) || probe.targetId !== id)
									throw new AppProblem("upstream_acp", "PanCode returned an invalid connection probe.");
								return { probe, targets: await readTargets(client) };
							},
							signal,
						);
						probe = result.probe;
						probedTargets = result.targets;
					} else {
						await this.runner.run({ kind: `targets.${action}`, id }, cwd, signal);
					}
				} catch (error) {
					// The runner keeps no stderr, so the two reasons `auth logout` exits non-zero are named here.
					if (action === "signout" && error instanceof AppProblem && /exit code 1\b/.test(error.message))
						throw new AppProblem(
							"operation_failed",
							`Nothing was removed for ${id}. Either PanCode has no stored credential for it, or its key comes from an environment variable, which is cleared where it is set.`,
						);
					throw error;
				}
				let targets: CliTargets;
				let settings: Awaited<ReturnType<SettingsService["settings"]>> | undefined;
				try {
					targets = probedTargets ?? (await this.list(workspaceId));
					if (action === "use") settings = await this.settings.settings(workspaceId ?? undefined);
				} catch (error) {
					if (action === "probe") throw error;
					throw new AppProblem(
						"operation_failed",
						"PanCode applied the change, but the follow-up read failed. Settings may already be changed; refresh before retrying.",
					);
				}
				return {
					kind: "targets",
					id,
					exitCode: 0,
					message:
						action === "probe"
							? probe?.healthy
								? `Connection is reachable${probe.latencyMs === null ? "" : ` · ${probe.latencyMs} ms`}.`
								: probeFailure(probe)
							: action === "signout"
								? `Signed out of ${id}. Its stored credential is removed; the connection stays configured and needs a new sign-in before it is used.`
								: "User connection settings updated.",
					targets,
					...(probe ? { probe } : {}),
					...(settings ? { settings } : {}),
				};
			},
		});
	}
	async routing(workspaceId: string | null): Promise<Routing> {
		const cwd = await this.workspaces.cwd(workspaceId);
		const [rawModels, rawProfiles, rawBindings] = await Promise.all([
			this.runner.run({ kind: "routing.models" }, cwd),
			this.runner.run({ kind: "routing.profiles" }, cwd),
			this.runner.run({ kind: "routing.bindings" }, cwd),
		]);
		// `connections profile list --json` reads `{ default, profiles }`; the fleet default is not a named profile.
		const profileList = object(rawProfiles);
		const models = items(rawModels),
			profiles = items(profileList.profiles),
			bindings = items(rawBindings);
		const result = {
			models: models.slice(0, 2000).map((value) => {
				const row = object(value);
				return {
					target: text(row.targetId),
					runtime: text(row.runtimeId),
					id: row.modelId === "(no models)" ? null : optionalText(row.modelId),
					capabilities: text(row.caps),
					context: typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : null,
					maxOutputTokens: typeof row.maxTokens === "number" && row.maxTokens > 0 ? row.maxTokens : null,
					state: text(row.state),
				};
			}),
			profiles: profiles.slice(0, 2000).map((value) => {
				const row = object(value);
				return {
					name: text(row.name),
					target: optionalText(row.target),
					runtime: optionalText(row.runtime),
					model: optionalText(row.model),
					thinkingLevel: text(row.thinkingLevel),
					...(Value.Check(SettingsOrigin, row.source) ? { source: row.source } : {}),
				};
			}),
			default:
				profileList.default == null
					? null
					: (() => {
							const row = object(profileList.default);
							return {
								target: text(row.target),
								runtime: optionalText(row.runtime),
								model: optionalText(row.model),
								thinkingLevel: text(row.thinkingLevel),
								...(Value.Check(SettingsOrigin, row.source) ? { source: row.source } : {}),
							};
						})(),
			bindings: bindings.slice(0, 2000).map((value) => {
				const row = object(value);
				return {
					agentId: text(row.agentId),
					profile: text(row.profile),
					target: optionalText(row.target),
					model: optionalText(row.model),
					resolved: row.warning === null,
				};
			}),
			truncated: models.length > 2000 || profiles.length > 2000 || bindings.length > 2000,
		};
		if (!Value.Check(Routing, result))
			throw new AppProblem("operation_failed", "PanCode returned an invalid routing projection.");
		return result;
	}
}
