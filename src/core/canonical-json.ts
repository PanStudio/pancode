// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Deterministic JSON with keys sorted by UTF-16 code unit and no whitespace, for digests and
 * byte-for-byte comparison. A value and its JSON wire copy must digest alike, so as in
 * `JSON.stringify` an `undefined` object field is dropped and an `undefined` or missing array entry
 * or a non-finite number becomes `null`; any other non-JSON value also becomes `null`. Code-unit
 * order, not `localeCompare`, because a digest must not depend on the host's locale. It never
 * throws on an acyclic value.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value, false);
}

/**
 * The same bytes as `canonicalJson`, but a non-finite number, a bigint, a symbol, a function or a
 * root `undefined` throws instead of becoming `null`, for a digest that must refuse what JSON would
 * silently rewrite (#434).
 */
export function canonicalJsonStrict(value: unknown): string {
	return serialize(value, true);
}

function serialize(value: unknown, strict: boolean): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (Number.isFinite(value)) return JSON.stringify(value);
		if (strict) throw new Error(`canonicalJson: non-finite number ${String(value)} is not representable`);
		return "null";
	}
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) parts.push(value[i] === undefined ? "null" : serialize(value[i], strict));
		return `[${parts.join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const child = record[key];
			if (child === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${serialize(child, strict)}`);
		}
		return `{${parts.join(",")}}`;
	}
	if (strict && value === undefined) throw new Error("canonicalJson: undefined is not representable at root");
	if (strict) throw new Error(`canonicalJson: ${typeof value} is not representable`);
	return "null";
}
