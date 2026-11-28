// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Settlement rejects undeclared hashes and names how the worker loop ended (#434). */
import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveRunTerminalReason } from "../../src/domains/dispatch/outcome.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import type { RunResultDraft } from "../../src/domains/dispatch/types.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

describe("run settlement (#434)", () => {
	it("refuses to seal a hash the declaration set does not name", () => {
		const envelope = fixtureEnvelope("v21-undeclared");
		const draft = { ...fixtureReceiptDraft(envelope), novelDigest: "a".repeat(64) } as unknown as RunResultDraft;
		throws(
			() =>
				finishRunResult(draft, envelope, {
					terminal: { terminalReason: draft.terminalReason ?? "completed" },
					processExitCode: envelope.exitCode,
					frameType: null,
					usage: undefined,
				}).result,
			/undeclared hashes novelDigest/,
		);
		// Peer JSON sealed verbatim (ACP capabilities, tool-call inputs) carries the peer's keys, not PanCode's hashes.
		const peer = {
			...fixtureReceiptDraft(envelope),
			delegation: {
				agentConfigId: "peer",
				command: "peer",
				args: [],
				acpSessionId: null,
				opened: "new",
				acpProtocolVersion: 1,
				acpAgentName: null,
				acpAgentVersion: null,
				agentCapabilities: { promptHash: "p".repeat(64) },
				toolCallsRequested: 1,
				toolCallsApproved: 1,
				toolCallsDenied: 0,
				toolGovernance: "pancode-policy",
				toolCallLog: [
					{
						callId: "call-1",
						tool: "bash",
						arguments: { digest: "d".repeat(64) },
						decision: "approved",
						durationMs: 1,
						timestamp: envelope.startedAt,
					},
				],
			},
		} as unknown as RunResultDraft;
		equal(
			typeof finishRunResult(peer, envelope, {
				terminal: { terminalReason: peer.terminalReason ?? "completed" },
				processExitCode: envelope.exitCode,
				frameType: null,
				usage: undefined,
			}).result.digest,
			"string",
		);
		// A worker's structured result carries the model's keys too.
		const structured = {
			...fixtureReceiptDraft(envelope),
			output: {
				state: "final",
				text: "{}",
				bytes: 2,
				truncated: false,
				structured: { version: 1, kind: "scout-report", data: { commitHash: "c".repeat(40) } },
			},
		} as unknown as RunResultDraft;
		equal(
			typeof finishRunResult(structured, envelope, {
				terminal: { terminalReason: structured.terminalReason ?? "completed" },
				processExitCode: envelope.exitCode,
				frameType: null,
				usage: undefined,
			}).result.digest,
			"string",
		);
	});

	it("names how the worker loop ended apart from the host's verdict", () => {
		const evidence = {
			exitCode: 0,
			abortedByOperator: false,
			stallKilled: false,
			timedOut: false,
			permissionFailure: false,
			policyDenied: null,
			stopReason: null,
		};
		deepStrictEqual(resolveRunTerminalReason(evidence, "host_verification_rejected"), { terminalReason: "completed" });
		deepStrictEqual(resolveRunTerminalReason(evidence, "worker_final_output_missing"), {
			terminalReason: "final_output_missing_no_repair",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, exitCode: 1 }, "result_contract_exhausted"), {
			terminalReason: "contract_exhausted_after_repair",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, exitCode: 1 }, "worker_tool_call_cap_exhausted"), {
			terminalReason: "bound_reached",
			boundKind: "tools",
		});
		const aborted = { ...evidence, exitCode: null, abortedByOperator: true };
		deepStrictEqual(resolveRunTerminalReason({ ...aborted, abortCause: "parent" }, null), {
			terminalReason: "cancelled_by_parent",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...aborted, abortCause: "timeout" }, null), {
			terminalReason: "bound_reached",
			boundKind: "time",
		});
		deepStrictEqual(resolveRunTerminalReason(aborted, null), { terminalReason: "cancelled_by_operator" });
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, stopReason: "cancelled" }, null), {
			terminalReason: "cancelled_by_peer",
		});
		deepStrictEqual(resolveRunTerminalReason({ ...evidence, exitCode: 1, channelFailure: "steer" }, null), {
			terminalReason: "channel_failure",
		});
	});
});
