// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The safety rows a run receipt seals: permit, envelope, grant audit and protected-artifact summaries. */

import { sha256Hex } from "../../core/hash.js";
import type { RecordOnlyWorkerPermit, WorkerPermit } from "../safety/worker-permit.js";
import type { GrantRecord } from "./grant-broker.js";
import type { RunResultDraft } from "./types.js";
import type { WorkerMcpNetworkWithheld } from "./worker-mcp.js";
import type { WorkerSpec } from "./worker-spawn.js";

export function receiptPermitSummary(
	permit: WorkerPermit | RecordOnlyWorkerPermit,
	mcpNetworkWithheld: ReadonlyArray<WorkerMcpNetworkWithheld> = [],
): NonNullable<NonNullable<RunResultDraft["safety"]>["permit"]> {
	return {
		version: permit.version,
		digest: permit.digest,
		capabilityClass: permit.ceiling.capabilityClass,
		git: permit.allowance.git,
		asks: permit.allowance.asks,
		approvalAuthority: permit.allowance.approvalAuthority,
		...(permit.allowance.executeAutonomy !== undefined ? { executeAutonomy: permit.allowance.executeAutonomy } : {}),
		...(permit.trustedUnmediated === true ? { trustedUnmediated: true as const } : {}),
		ceiling: {
			tools: [...permit.ceiling.tools],
			readOnly: permit.ceiling.readOnly,
			writeRoots: [...permit.ceiling.writeRoots],
			enforcement: { ...permit.ceiling.enforcement },
			...(permit.ceiling.mcp !== undefined
				? {
						mcp: {
							projectRoot: permit.ceiling.mcp.projectRoot,
							tools: permit.ceiling.mcp.tools.map((entry) => ({ ...entry })),
							...(permit.ceiling.mcp.skills !== undefined
								? {
										skills: permit.ceiling.mcp.skills.map(({ serverId, displayName, uri, manifestDigest }) => ({
											serverId,
											name: displayName,
											uri,
											manifestDigest,
										})),
									}
								: {}),
							// The dispatch result names a withheld grant from the sealed receipt, not as missing.
							...(mcpNetworkWithheld.length > 0 ? { networkWithheld: mcpNetworkWithheld.map((entry) => ({ ...entry })) } : {}),
						},
					}
				: {}),
		},
		...("recordOnly" in permit ? { recordOnly: { ...permit.recordOnly } } : {}),
	};
}

export function receiptEnvelopeSummary(envelope: NonNullable<NonNullable<RunResultDraft["safety"]>["envelope"]>) {
	return {
		version: envelope.version,
		digest: envelope.digest,
		permitDigest: envelope.permitDigest,
		role: envelope.role,
		skills: { bound: [...envelope.skills.bound], discovery: envelope.skills.discovery },
		read: { roots: [...envelope.read.roots], outside: [...envelope.read.outside] },
		write: {
			mode: envelope.write.mode,
			roots: [...envelope.write.roots],
			commandsBounded: envelope.write.commandsBounded,
		},
		exec: { ...envelope.exec },
		network: { shell: envelope.network.shell, tools: [...envelope.network.tools], mcp: [...envelope.network.mcp] },
		approval: { ...envelope.approval },
		sandbox: { ...envelope.sandbox },
		withheld: envelope.withheld.map((entry) => ({ ...entry })),
		staticHead: envelope.staticHead,
	};
}

/** The receipt's grant rows for one attempt; empty object when it opened none. */
export function receiptGrantAudit(
	records: ReadonlyArray<GrantRecord>,
	runId: string,
): { grants?: NonNullable<NonNullable<RunResultDraft["safety"]>["grants"]> } {
	const rows = records
		.filter((record) => record.runId === runId)
		.map((record) => ({
			requestId: record.requestId,
			attempt: record.attempt,
			tool: record.tool,
			actionClass: record.actionClass,
			authority: record.approvalAuthority,
			...(record.issuer !== undefined ? { issuer: record.issuer } : {}),
			...(record.forwardedByMain === true ? { forwardedByMain: true as const } : {}),
			decision:
				record.state === "denied"
					? ("denied" as const)
					: record.state === "expired"
						? ("expired" as const)
						: record.state === "canceled" || record.state === "pending"
							? ("canceled" as const)
							: ("approved" as const),
			execution: record.execution === "executing" ? ("unknown" as const) : record.execution,
			...(record.reason !== undefined ? { reason: record.reason.slice(0, 500) } : {}),
		}));
	return rows.length > 0 ? { grants: rows } : {};
}

export function protectedArtifactReceiptSummary(
	state: WorkerSpec["protectedArtifactState"],
): NonNullable<RunResultDraft["safety"]>["protectedArtifacts"] | undefined {
	if (state === undefined || state.artifacts.length === 0) return undefined;
	const artifacts = [...state.artifacts]
		.map((artifact) => ({ ...artifact }))
		.sort((left, right) => left.path.localeCompare(right.path));
	return {
		version: state.version,
		count: artifacts.length,
		stateHash: sha256Hex(JSON.stringify(artifacts)),
	};
}
