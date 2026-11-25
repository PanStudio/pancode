// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SafetyPolicyMetadata } from "../safety/policy-engine.js";
import type { RunResultReproducibility } from "./types.js";

/** The run's working directory and the safety policy it ran under. */
export function collectReproducibilityMetadata(
	cwd: string,
	safety: SafetyPolicyMetadata | null,
): RunResultReproducibility {
	return {
		cwd,
		safetyPolicy: {
			version: safety?.version ?? 1,
			rulePackHash: safety?.rulePackHash ?? null,
			rulePackVersion: safety?.rulePackVersion ?? null,
			projectPolicyPath: safety?.projectPolicyPath ?? null,
			projectPolicyHash: safety?.projectPolicyHash ?? null,
			projectPolicyValid: safety?.projectPolicyValid ?? null,
		},
	};
}
