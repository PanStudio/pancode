// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";

/** `major.minor` of a version, so a patch release keeps the same fingerprint. */
function minorVersion(version: string): string {
	const match = /^v?(\d+)\.(\d+)/u.exec(version.trim());
	return match ? `${match[1]}.${match[2]}` : "unknown";
}

/**
 * The exact-match dedup key for a machine-triggered report: `fp_` and 12 hex of SHA-256 over the trigger, the
 * cause, the minor version and, for a crash, its top frames.
 */
export function reportFingerprint(input: {
	trigger: string;
	cause: string | null;
	version: string;
	frames?: ReadonlyArray<string>;
}): string {
	const parts = [input.trigger, input.cause ?? "none", minorVersion(input.version), ...(input.frames ?? []).slice(0, 5)];
	return `fp_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12)}`;
}
