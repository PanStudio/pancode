// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { canonicalJsonStrict } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";
import { parseJsonObjectPayload } from "../../core/json-payload.js";
import type { ResultContract, ResultContractQuality, ResultContractValidation } from "./result-contract-types.js";

export function digest(value: unknown): string {
	return sha256Hex(canonicalJsonStrict(value));
}

export function resultContractSourceId(contract: ResultContract): string {
	return `agent-result-contract:${contract.kind}:${digest(contract)}`;
}

export function failure(
	contract: ResultContract,
	quality: ResultContractQuality,
	reason: string,
): ResultContractValidation {
	return {
		conformance: "fail",
		quality,
		sourceId: resultContractSourceId(contract),
		validatorDigest: digest({ contract, reason }),
		reason,
	};
}

export function success(
	contract: ResultContract,
	quality: ResultContractQuality,
	value: unknown,
	extra: Pick<ResultContractValidation, "scout" | "verifier" | "delegationPlan" | "reason"> = {},
): ResultContractValidation {
	return {
		conformance: "pass",
		quality,
		sourceId: resultContractSourceId(contract),
		validatorDigest: digest({ contract, value }),
		...extra,
	};
}

/**
 * Read the JSON object a terminal result carries. Every contract prompt asks
 * for bare JSON and a fence is the deviation local models reach for first, so
 * refusing one burns both repair rounds and fails a run whose payload was
 * correct. Widening the span that is searched does not widen what conforms: a
 * candidate still has to parse and still has to be an object, and the per-kind
 * validators still own every field.
 */
export function parseJson(
	output: string | null,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
	if (output === null || output.trim().length === 0) return { ok: false, reason: "missing final result" };
	const parsed = parseJsonObjectPayload(output);
	if (parsed.ok) return parsed;
	return {
		ok: false,
		reason: parsed.reason === "not-object" ? "result must be a JSON object" : "result must be valid JSON",
	};
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

export function unexpectedResultKeyReason(
	label: string,
	value: Record<string, unknown>,
	keys: ReadonlyArray<string>,
): string | null {
	const unexpected = Object.keys(value).find((key) => !keys.includes(key));
	return unexpected === undefined
		? null
		: `${label} has unexpected key ${JSON.stringify(unexpected)}; allowed keys: ${keys.join(", ")}`;
}

export function string(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
