// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { packageDeclaredCheck } from "../../tools/verify/catalog.js";
import { discoverDeclaredChecksAtRoot, discoverDeclaredProjectEntriesAtRoot } from "../../tools/verify/scripts.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import { normalizeIntentExpectedOutputs, normalizeIntentVerification } from "./intent.js";

/** Operator flags use the same bounds and normalization as dispatch intent. */
export function acceptanceFromTaskFlags(
	cwd: string,
	expectedOutputs: string[],
	verify: string[],
): UserTaskAcceptance | undefined {
	if (expectedOutputs.length === 0 && verify.length === 0) return undefined;
	const discovery = discoverDeclaredChecksAtRoot(cwd, undefined);
	if (!discovery.ok) throw new Error(discovery.reason);
	const checks = new Map(
		discovery.sources.flatMap((source) => source.checks.map((check) => [check.id, check] as const)),
	);
	for (const entry of discoverDeclaredProjectEntriesAtRoot(cwd)) {
		if (entry.kind === "package-script" && !checks.has(entry.id))
			checks.set(entry.id, packageDeclaredCheck(entry.id, entry.path, ".", []));
	}
	const verification = verify.map((value) => {
		const suffix = checks.has(value) ? null : /^(.*):([0-9]+)$/.exec(value);
		const check = suffix?.[1] ?? value;
		if (!checks.has(check))
			throw new Error(
				`Unknown verification check '${check}'. Known ids: ${[...checks.keys()].sort().join(", ") || "(none)"}`,
			);
		return { check, ...(suffix ? { timeout_ms: Number(suffix[2]) } : {}) };
	});
	const outputs = normalizeIntentExpectedOutputs(expectedOutputs);
	if (!Array.isArray(outputs)) throw new Error(outputs.ok ? "invalid expected outputs" : outputs.message);
	const normalized = normalizeIntentVerification(verification, checks);
	if (!Array.isArray(normalized)) throw new Error(normalized.ok ? "invalid verification" : normalized.message);
	return { expectedOutputs: outputs, verification: normalized };
}
