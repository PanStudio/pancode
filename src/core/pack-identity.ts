// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export interface PackIdentity {
	kind: string;
	id: string;
	version: string;
	digest: string;
	scope?: string;
	envelopeDigest?: string;
}

export function isPackIdentity(value: unknown): value is PackIdentity {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		["kind", "id", "version", "digest"].every((key) => typeof item[key] === "string") &&
		(item.scope === undefined || typeof item.scope === "string") &&
		(item.envelopeDigest === undefined || typeof item.envelopeDigest === "string")
	);
}
