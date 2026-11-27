// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The pack digests PanHub has revoked: the union of `revoked` in the bundled
 * `hub/index.yaml` and in the last verified remote index, kept in
 * `<stateDir>/hub-trust.json`. Both loaders read this on every listing, so it
 * imports only core modules and re-parses a file only when its bytes change.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "./package-root.js";
import { pancodeStateDir } from "./xdg.js";

export interface HubRevocation {
	sha256: string;
	reason: string;
	date: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

/** Keep only well-formed entries; a malformed one never revokes and never hides the rest. */
export function parseHubRevocations(value: unknown): HubRevocation[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): HubRevocation[] => {
		if (!item || typeof item !== "object") return [];
		const entry = item as Record<string, unknown>;
		if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) return [];
		const date = entry.date instanceof Date ? entry.date.toISOString().slice(0, 10) : entry.date;
		return [
			{
				sha256: entry.sha256,
				reason: typeof entry.reason === "string" ? entry.reason : "no reason given",
				date: typeof date === "string" ? date : "unknown date",
			},
		];
	});
}

const cache = new Map<string, { stamp: string; revoked: HubRevocation[] }>();

/** Re-read only when the file's identity, size or modification time changes; loaders call this per entry. */
function cachedRead(file: string, parse: (bytes: string) => unknown): HubRevocation[] {
	let stamp: string;
	let bytes: string;
	try {
		if (!existsSync(file)) return [];
		const stat = statSync(file);
		stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		const hit = cache.get(file);
		if (hit?.stamp === stamp) return hit.revoked;
		bytes = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	let revoked: HubRevocation[] = [];
	try {
		const parsed = parse(bytes);
		revoked = parsed && typeof parsed === "object" ? parseHubRevocations((parsed as { revoked?: unknown }).revoked) : [];
	} catch {
		// An unreadable file revokes nothing it cannot name; the other source still applies.
	}
	cache.set(file, { stamp, revoked });
	return revoked;
}

function bundledRevocations(): HubRevocation[] {
	try {
		return cachedRead(path.join(resolvePackageRoot(), "hub", "index.yaml"), (bytes) => parseYaml(bytes));
	} catch {
		return [];
	}
}

function verifiedRevocations(): HubRevocation[] {
	try {
		return cachedRead(path.join(pancodeStateDir(), "hub-trust.json"), (bytes) => JSON.parse(bytes));
	} catch {
		return [];
	}
}

/** Every revoked digest, keyed by sha256. The bundled entry wins when both name one digest. */
export function revokedHubDigests(): ReadonlyMap<string, HubRevocation> {
	const out = new Map<string, HubRevocation>();
	for (const item of [...verifiedRevocations(), ...bundledRevocations()]) out.set(item.sha256, item);
	return out;
}

/** The diagnostic both loaders attach to a revoked install. */
export function packRevokedMessage(id: string, revocation: HubRevocation): string {
	return `pack_revoked: ${id} ${revocation.sha256} revoked ${revocation.date}: ${revocation.reason}`;
}
