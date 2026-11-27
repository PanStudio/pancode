// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { performance } from "node:perf_hooks";
import { prepareBoundedImage } from "../../core/file-references.js";
import { neutralizeFraming } from "../../core/reminder-framing.js";
import type {
	McpContentBlock,
	McpProgressUpdate,
	McpToolCallResult,
	McpToolDescriptor,
	McpTrustActionClass,
} from "../../domains/gateway/mcp/index.js";
import {
	DEFAULT_RESULT_TEXT_BYTES,
	JSON_RPC_INVALID_PARAMS,
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_RESOURCE_NOT_FOUND,
	McpError,
	renderMcpContent,
} from "../../domains/gateway/mcp/index.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import { mcpServerPolicyRefusal } from "../../domains/safety/denial.js";
import type { ImageContent } from "../../engine/types.js";
import {
	commitObservationReservation,
	finalizeObservation,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import { readMaxBytes } from "../read.js";
import type { ToolInvokeOptions } from "../registry-contract.js";
import { nestedBlockedResult } from "../registry-nested-calls.js";
import { imageOmissionNotice, offloadPointer, writeToolOffload } from "../result-shaping.js";
import type { ToolResult } from "../tool-spec.js";
import { byteLength } from "../truncate-utf8.js";
import type { GatewayMcpServer, ServerState } from "./mcp-capability-types.js";
import { catalogRemedy } from "./mcp-catalog-change.js";

/** Model-visible bytes of one MCP result before the rest is offloaded. */
export const MCP_RESULT_CONTEXT_BYTES = 16 * 1024;

/** Shortest gap between two progress redraws of one call, however often its server reports. */
const MCP_PROGRESS_INTERVAL_MS = 250;

/** Base64 of one audio or binary resource block written whole to the offload directory; a larger one is only described. */
const MCP_BINARY_OFFLOAD_BYTES = 10 * 1024 * 1024;

/** The server's own read-only or destructive annotation, which PanCode reports but never enforces. */
export function serverHintOf(
	tool: Partial<Pick<McpToolDescriptor, "annotations">>,
): "read-only" | "destructive" | undefined {
	if (tool.annotations?.readOnlyHint === true) return "read-only";
	if (tool.annotations?.destructiveHint === true) return "destructive";
	return undefined;
}

/**
 * A call the server refused under its own policy, settled as a refusal rather
 * than a tool error: the server answered with a structured non-retryable
 * denial, so the identical call cannot succeed, and no PanCode trust record or
 * approval reaches the server's policy. The registry refuses an identical
 * repeat in the same turn without calling the server again.
 */
export function serverPolicyRefusalResult(
	state: ServerState,
	tool: McpToolDescriptor,
	name: string,
	trustClass: McpTrustActionClass,
	result: McpToolCallResult,
): ToolResult | null {
	const refusal = mcpServerPolicyRefusal(result.structuredContent ?? jsonObjectText(result.text));
	if (refusal === null) return null;
	const { id } = state.declaration;
	state.refused.set(tool.name, refusal.code);
	const reason = `${name} refused by MCP server ${id}: ${neutralizeFraming(refusal.message)}`;
	const decision: SafetyDecision = {
		kind: "block",
		classification: { actionClass: trustClass, reasons: [refusal.message] },
		rejection: {
			short: reason,
			detail: `The server's own policy refused ${tool.name} (${refusal.code}). PanCode admitted the call; approving it again in PanCode does not change the server's answer.`,
			hints: ["Report the refusal and what would allow it; do not substitute another tool or target for the refused one."],
		},
	};
	const hint = serverHintOf(tool);
	return nestedBlockedResult({
		kind: "blocked",
		reason,
		decision,
		denial: {
			layer: "mcp_server_policy",
			actionClass: trustClass,
			retryable: false,
			allowedBy: `the MCP server ${id} must be configured to permit ${tool.name}${refusal.profile !== undefined ? `; its ${refusal.profile} profile excludes it` : ""}.`,
			code: refusal.code,
			server: id,
			...(hint !== undefined ? { serverHint: hint } : {}),
		},
	});
}

/** A text block that is one JSON object, for a server that reports structure only as text. */
function jsonObjectText(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || trimmed.length > 16_384) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		// Prose that merely starts with a brace is not a structured refusal.
		return undefined;
	}
}

function progressLine(name: string, update: McpProgressUpdate): string {
	const { progress, total } = update;
	const amount =
		total !== undefined && total > 0
			? `${progress}/${total} (${Math.min(100, Math.round((progress / total) * 100))}%)`
			: `${progress}`;
	return `${name}: progress ${amount}${update.message !== undefined ? `: ${update.message}` : ""}`;
}

/**
 * A call's progress notifications as display-only partial results. The
 * latest update wins and redraws come at most every MCP_PROGRESS_INTERVAL_MS,
 * so a server reporting every byte cannot flood the operator's card. Nothing
 * here touches the call's own timeout.
 */
export function mcpProgressReporter(
	name: string,
	onUpdate: (partial: ToolResult) => void,
): { onProgress(update: McpProgressUpdate): void; stop(): void } {
	let lastAt = Number.NEGATIVE_INFINITY;
	let latest: McpProgressUpdate | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	const emit = (): void => {
		timer = null;
		if (stopped || latest === null) return;
		const update = latest;
		latest = null;
		lastAt = performance.now();
		try {
			onUpdate({ kind: "ok", output: progressLine(name, update) });
		} catch {
			// A display failure never fails the call.
		}
	};
	return {
		onProgress(update) {
			if (stopped) return;
			latest = update;
			if (timer !== null) return;
			const wait = lastAt + MCP_PROGRESS_INTERVAL_MS - performance.now();
			if (wait <= 0) emit();
			else timer = setTimeout(emit, wait);
		},
		stop() {
			stopped = true;
			if (timer !== null) clearTimeout(timer);
			timer = null;
		},
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A failed call as its cause and the next step, for the model's tool result
 * and the operator's card. The cause is the client's message, which carries a
 * server's own explanation of an error answer and a crashed server's last
 * stderr lines; `stopped` says whether PanCode ended the server over it.
 */
export function mcpCallFailureText(declaration: GatewayMcpServer, error: unknown, stopped: boolean): string {
	if (!(error instanceof McpError)) return errorMessage(error);
	const { id } = declaration;
	const restart = stopped ? "; PanCode stopped the server and the next call starts it again" : "";
	switch (error.code) {
		case "server": {
			const answer = error.data as { code?: unknown; message?: unknown } | undefined;
			const rpc = answer?.code;
			// Not-found is -32002 in the legacy revisions and -32602 naming the tool in 2026-07-28 (server/tools).
			const notFound =
				rpc === JSON_RPC_METHOD_NOT_FOUND ||
				rpc === MCP_RESOURCE_NOT_FOUND ||
				(rpc === JSON_RPC_INVALID_PARAMS &&
					typeof answer?.message === "string" &&
					/unknown tool|not found/iu.test(answer.message));
			const next = notFound
				? `it does not serve this; list its tools again with ${catalogRemedy(id)}`
				: rpc === MCP_MISSING_REQUIRED_CLIENT_CAPABILITY
					? "the same call needs the same capability, so report it rather than retrying"
					: rpc === JSON_RPC_INVALID_PARAMS
						? "correct the arguments it names (describe the capability for its schema) before calling again"
						: "the same call gets the same answer, so change it or report the answer";
			return `mcp server ${id} refused ${error.message}; ${next}`;
		}
		case "timeout": {
			const raise =
				declaration.scope === "user" || declaration.scope === "project" || declaration.scope === "plugin"
					? `, or the operator raises timeoutMs for ${id} in ${declaration.path}`
					: "";
			return `mcp server ${id} did not answer in time: ${error.message}${restart}. Narrow the request${raise}`;
		}
		case "protocol":
			return `mcp server ${id} broke the MCP protocol: ${error.message}${restart}. The same call fails the same way; report it rather than retrying`;
		case "closed":
			return `${error.message}; the next call starts it again`;
		case "spawn":
		case "overload":
			return `${error.message}${restart}`;
		case "aborted":
			return error.message;
	}
}

/**
 * The result text with every audio block and binary resource offloaded: the
 * base64 is written to the session's offload directory and the block's line
 * names its type, size and that file; with `linkLine`, each resource link
 * names how to read it. Null when neither applies, so the client's own
 * rendering stands.
 */
export function offloadedBinaryText(
	result: McpToolCallResult,
	context: ToolInvokeOptions | undefined,
	linkLine?: (block: Extract<McpContentBlock, { type: "resource_link" }>) => string,
): { text: string; truncated: boolean } | null {
	const pointers = new Map<McpContentBlock, string>();
	for (const block of result.content) {
		const base64 = block.type === "audio" ? block.data : block.type === "resource" ? block.blob : undefined;
		if (base64 === undefined || byteLength(base64) > MCP_BINARY_OFFLOAD_BYTES) continue;
		const written = writeToolOffload(base64, context, MCP_BINARY_OFFLOAD_BYTES);
		if (written !== null) pointers.set(block, offloadPointer(written));
	}
	const links = linkLine !== undefined && result.content.some((block) => block.type === "resource_link");
	if (pointers.size === 0 && !links) return null;
	return renderMcpContent(
		result.content,
		DEFAULT_RESULT_TEXT_BYTES,
		(block) => pointers.get(block) ?? null,
		links ? linkLine : undefined,
	);
}

export function imageBlocks(result: McpToolCallResult): ImageContent[] {
	const images: ImageContent[] = [];
	for (const block of result.content) {
		if (block.type !== "image") continue;
		const { data, mimeType } = block as { data?: unknown; mimeType?: unknown };
		if (typeof data === "string" && typeof mimeType === "string" && mimeType.startsWith("image/")) {
			images.push({ type: "image", data, mimeType });
		}
	}
	return images;
}

/**
 * An MCP image (a browser screenshot) gets the image budget and pool charge `read` gives an image file: each one is
 * encoded through prepareBoundedImage into what remains of that budget, and one that still cannot fit is omitted
 * with the shaping notice. Shaping settles the charge to what the model receives.
 */
export async function boundedImageResult(
	tool: string,
	output: string,
	details: Record<string, unknown>,
	images: ImageContent[],
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	const reservation = reserveObservation(readMaxBytes(), options);
	commitObservationReservation(reservation);
	try {
		let budget =
			Math.min(reservation.callCapBytes, options?.toolResultMaxBytes ?? readMaxBytes()) -
			Math.min(byteLength(output), MCP_RESULT_CONTEXT_BYTES) -
			512;
		const bounded: ImageContent[] = [];
		for (const image of images) {
			const encoded = budget > 0 ? await prepareBoundedImage(Buffer.from(image.data, "base64"), budget) : null;
			if (encoded === null) continue;
			bounded.push(encoded);
			budget -= byteLength(encoded.data);
		}
		return finalizeObservation({
			tool,
			unit: "results",
			output: imageOmissionNotice(images.length - bounded.length) + output,
			images: bounded,
			shownCount: 1,
			totalCount: 1,
			truncated: false,
			details,
			reservation,
			...(options ? { options } : {}),
		});
	} finally {
		releaseObservation(reservation);
	}
}
