// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Signature formats and verification for the hub index.
 *
 * Two signed documents share one envelope:
 *
 *   { "payloadType": "<type>", "payload": "<base64 UTF-8 JSON>", "signatures": [{ "keyId", "sig" }] }
 *
 * A signature covers the UTF-8 of `payloadType`, one newline, then the decoded payload bytes, so it always
 * covers exact bytes and no canonical JSON is needed. A key id is the first 16 hex characters of the sha256 of
 * the raw 32-byte Ed25519 public key.
 *
 * The offline root key certifies CI signing keys (`pancode.hub.keys.v1`); a certified key signs an index
 * statement (`pancode.hub.index.v1`) that pins the index bytes, a sequence and an expiry.
 *
 * Pure: no file, network or clock access. Callers pass bytes, the trusted root keys, the current time and the
 * highest sequences already accepted. Every failure is a refusal value; nothing here throws. This module has no
 * relative imports, so the signing scripts load it directly under Node's type stripping.
 */
import type { KeyObject } from "node:crypto";
import { createPublicKey, sign, verify } from "node:crypto";
import { sha256Hex } from "../../core/hash.js";
import { isRecord } from "../../core/type-guards.js";

export const HUB_KEYS_PAYLOAD_TYPE = "pancode.hub.keys.v1";
export const HUB_INDEX_PAYLOAD_TYPE = "pancode.hub.index.v1";

export type HubRefusalReason =
	| "malformed"
	| "no-root-key"
	| "bad-root-signature"
	| "certificate-rollback"
	| "unknown-key"
	| "revoked-key"
	| "key-not-valid-now"
	| "bad-signature"
	| "index-hash-mismatch"
	| "index-rollback"
	| "expired";

export interface HubRefusal {
	ok: false;
	reason: HubRefusalReason;
	message: string;
}

export interface HubSignature {
	keyId: string;
	sig: string;
}

export interface HubEnvelope {
	payloadType: string;
	payload: string;
	signatures: HubSignature[];
}

export interface CertifiedKey {
	keyId: string;
	publicKey: string;
	notBefore: string;
	notAfter: string;
}

export interface HubKeyCertificate {
	sequence: number;
	keys: CertifiedKey[];
	revoked: string[];
}

export interface HubIndexStatement {
	sequence: number;
	generatedAt: string;
	expires: string;
	commit: string;
	indexPath: string;
	indexSha256: string;
}

export type HubVerification<T> = { ok: true; value: T } | HubRefusal;

type Bytes = Uint8Array | string;

const ED25519_RAW_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;
const KEY_ID = /^[0-9a-f]{16}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function refuse(reason: HubRefusalReason, message: string): HubRefusal {
	return { ok: false, reason, message };
}

/** Strict base64: canonical padding and alphabet, so two spellings never name the same bytes. */
function decodeBase64(text: unknown): Buffer | undefined {
	if (typeof text !== "string" || !BASE64.test(text)) return undefined;
	const bytes = Buffer.from(text, "base64");
	return bytes.toString("base64") === text ? bytes : undefined;
}

function toBuffer(bytes: Bytes): Buffer {
	return typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
}

function instant(text: unknown): number | undefined {
	if (typeof text !== "string" || !ISO_INSTANT.test(text)) return undefined;
	const time = Date.parse(text);
	return Number.isFinite(time) ? time : undefined;
}

function isSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The key id of a raw 32-byte Ed25519 public key given as base64, or undefined when it is not one. */
export function hubKeyId(publicKey: string): string | undefined {
	const raw = decodeBase64(publicKey);
	if (raw === undefined || raw.length !== ED25519_RAW_LENGTH) return undefined;
	return sha256Hex(raw).slice(0, 16);
}

function publicKeyObject(publicKey: string): KeyObject | undefined {
	const raw = decodeBase64(publicKey);
	if (raw === undefined || raw.length !== ED25519_RAW_LENGTH) return undefined;
	try {
		return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
	} catch {
		// A 32-byte string that is not a curve point is simply not a usable key.
		return undefined;
	}
}

/** The base64 raw public key of an Ed25519 key object (private or public). */
export function hubPublicKeyBase64(key: KeyObject): string {
	const jwk = (key.type === "public" ? key : createPublicKey(key)).export({ format: "jwk" });
	if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("not an Ed25519 key");
	return Buffer.from(jwk.x, "base64url").toString("base64");
}

function signedBytes(payloadType: string, payload: Uint8Array): Buffer {
	return Buffer.concat([Buffer.from(`${payloadType}\n`, "utf8"), payload]);
}

/**
 * An envelope over `payload` signed by each Ed25519 private key. Used by the signing tools and tests; the
 * verifiers below never call it.
 */
export function signHubEnvelope(payloadType: string, payload: object, privateKeys: KeyObject[]): HubEnvelope {
	const bytes = Buffer.from(JSON.stringify(payload, null, "\t"), "utf8");
	const message = signedBytes(payloadType, bytes);
	return {
		payloadType,
		payload: bytes.toString("base64"),
		signatures: privateKeys.map((key) => {
			const keyId = hubKeyId(hubPublicKeyBase64(key));
			if (keyId === undefined) throw new Error("not an Ed25519 key");
			return { keyId, sig: sign(null, message, key).toString("base64") };
		}),
	};
}

interface DecodedEnvelope {
	message: Buffer;
	payload: Buffer;
	signatures: Array<{ keyId: string; sig: Buffer }>;
}

function decodeEnvelope(input: Bytes, payloadType: string): DecodedEnvelope | HubRefusal {
	let parsed: unknown;
	try {
		parsed = JSON.parse(toBuffer(input).toString("utf8"));
	} catch {
		return refuse("malformed", "envelope is not JSON");
	}
	if (!isRecord(parsed)) return refuse("malformed", "envelope is not a JSON object");
	if (parsed.payloadType !== payloadType)
		return refuse("malformed", `envelope payloadType is ${JSON.stringify(parsed.payloadType)}, expected ${payloadType}`);
	const payload = decodeBase64(parsed.payload);
	if (payload === undefined) return refuse("malformed", "envelope payload is not base64");
	if (!Array.isArray(parsed.signatures) || parsed.signatures.length === 0)
		return refuse("malformed", "envelope carries no signatures");
	const signatures: DecodedEnvelope["signatures"] = [];
	for (const entry of parsed.signatures) {
		if (!isRecord(entry) || typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId))
			return refuse("malformed", "envelope signature has no 16-hex keyId");
		const sig = decodeBase64(entry.sig);
		if (sig === undefined || sig.length !== ED25519_SIGNATURE_LENGTH)
			return refuse("malformed", `signature by ${entry.keyId} is not a base64 Ed25519 signature`);
		signatures.push({ keyId: entry.keyId, sig });
	}
	return { message: signedBytes(payloadType, payload), payload, signatures };
}

function parsePayload(payload: Buffer): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function verifies(message: Buffer, sig: Buffer, key: KeyObject): boolean {
	try {
		return verify(null, message, key, sig);
	} catch {
		// node:crypto throws on a key or signature it cannot use; that is a failed verification.
		return false;
	}
}

function parseCertificate(payload: Buffer): HubKeyCertificate | HubRefusal {
	const body = parsePayload(payload);
	if (body === undefined) return refuse("malformed", "certificate payload is not a JSON object");
	if (!isSequence(body.sequence)) return refuse("malformed", "certificate sequence is not a non-negative integer");
	if (!Array.isArray(body.keys)) return refuse("malformed", "certificate keys is not a list");
	if (!Array.isArray(body.revoked) || !body.revoked.every((id) => typeof id === "string" && KEY_ID.test(id)))
		return refuse("malformed", "certificate revoked is not a list of key ids");
	const keys: CertifiedKey[] = [];
	for (const entry of body.keys) {
		if (!isRecord(entry)) return refuse("malformed", "certificate key entry is not an object");
		const { keyId, publicKey, notBefore, notAfter } = entry;
		if (typeof keyId !== "string" || typeof publicKey !== "string")
			return refuse("malformed", "certificate key entry lacks keyId or publicKey");
		if (hubKeyId(publicKey) !== keyId)
			return refuse("malformed", `certificate key ${keyId} does not match its public key`);
		const from = instant(notBefore);
		const until = instant(notAfter);
		if (from === undefined || until === undefined || from >= until)
			return refuse("malformed", `certificate key ${keyId} has no valid notBefore/notAfter window`);
		keys.push({ keyId, publicKey, notBefore: notBefore as string, notAfter: notAfter as string });
	}
	return { sequence: body.sequence, keys, revoked: [...(body.revoked as string[])] };
}

/**
 * The CI signing keys the root certifies, or a refusal. `rootKeys` are base64 raw Ed25519 public keys; one
 * signature by any of them suffices and signatures by other keys are ignored, so a root rotation can dual-sign.
 * `minSequence` is the highest certificate sequence already accepted; a lower one is a rollback.
 */
export function verifyKeyCertificate(input: {
	envelope: Bytes;
	rootKeys: ReadonlyArray<string>;
	minSequence: number;
}): HubVerification<HubKeyCertificate> {
	try {
		const decoded = decodeEnvelope(input.envelope, HUB_KEYS_PAYLOAD_TYPE);
		if ("ok" in decoded) return decoded;
		const roots = new Map<string, KeyObject>();
		for (const root of input.rootKeys) {
			const id = hubKeyId(root);
			const key = publicKeyObject(root);
			if (id !== undefined && key !== undefined) roots.set(id, key);
		}
		if (roots.size === 0) return refuse("no-root-key", "no trusted root key is configured, so no certificate verifies");
		const rootSigned = decoded.signatures.filter((signature) => roots.has(signature.keyId));
		if (rootSigned.length === 0)
			return refuse(
				"bad-root-signature",
				`certificate is signed by ${decoded.signatures.map((signature) => signature.keyId).join(", ")}, none a trusted root key`,
			);
		if (!rootSigned.some(({ keyId, sig }) => verifies(decoded.message, sig, roots.get(keyId) as KeyObject)))
			return refuse(
				"bad-root-signature",
				`certificate signature by root key ${rootSigned.map((signature) => signature.keyId).join(", ")} does not verify`,
			);
		const certificate = parseCertificate(decoded.payload);
		if ("ok" in certificate) return certificate;
		if (!isSequence(input.minSequence)) return refuse("malformed", "minimum certificate sequence is not an integer");
		if (certificate.sequence < input.minSequence)
			return refuse(
				"certificate-rollback",
				`certificate sequence ${certificate.sequence} is lower than the accepted ${input.minSequence}`,
			);
		return { ok: true, value: certificate };
	} catch (err) {
		return refuse("malformed", `certificate could not be read: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function parseStatement(payload: Buffer): HubIndexStatement | HubRefusal {
	const body = parsePayload(payload);
	if (body === undefined) return refuse("malformed", "index statement payload is not a JSON object");
	const { sequence, generatedAt, expires, commit, indexPath, indexSha256 } = body;
	if (!isSequence(sequence)) return refuse("malformed", "index statement sequence is not a non-negative integer");
	const generated = instant(generatedAt);
	const until = instant(expires);
	if (generated === undefined || until === undefined || generated >= until)
		return refuse("malformed", "index statement has no valid generatedAt/expires window");
	if (typeof commit !== "string" || !COMMIT.test(commit))
		return refuse("malformed", "index statement commit is not a 40-hex commit");
	if (typeof indexPath !== "string" || indexPath.length === 0)
		return refuse("malformed", "index statement has no indexPath");
	if (typeof indexSha256 !== "string" || !SHA256.test(indexSha256))
		return refuse("malformed", "index statement indexSha256 is not a sha256");
	return {
		sequence,
		generatedAt: generatedAt as string,
		expires: expires as string,
		commit,
		indexPath,
		indexSha256,
	};
}

/**
 * The index statement, or a refusal. `certificate` is the value `verifyKeyCertificate` returned; `now` is the
 * caller's clock; `minSequence` is the highest index sequence already accepted. One valid signature by a
 * certified, unrevoked key inside its validity window suffices; signatures by unknown keys are ignored.
 */
export function verifyIndexStatement(input: {
	envelope: Bytes;
	indexBytes: Bytes;
	certificate: HubKeyCertificate;
	now: Date;
	minSequence: number;
}): HubVerification<HubIndexStatement> {
	try {
		const decoded = decodeEnvelope(input.envelope, HUB_INDEX_PAYLOAD_TYPE);
		if ("ok" in decoded) return decoded;
		const now = input.now.getTime();
		if (!Number.isFinite(now)) return refuse("malformed", "current time is not a valid date");
		const revoked = new Set(input.certificate.revoked);
		const certified = new Map(input.certificate.keys.map((key) => [key.keyId, key]));
		let first: HubRefusal | undefined;
		let accepted = false;
		for (const { keyId, sig } of decoded.signatures) {
			let refusal: HubRefusal | undefined;
			const key = certified.get(keyId);
			if (revoked.has(keyId)) refusal = refuse("revoked-key", `signing key ${keyId} is revoked`);
			else if (key === undefined) continue;
			else {
				const from = instant(key.notBefore);
				const until = instant(key.notAfter);
				const object = publicKeyObject(key.publicKey);
				if (from === undefined || until === undefined || now < from || now >= until)
					refusal = refuse(
						"key-not-valid-now",
						`signing key ${keyId} is valid from ${key.notBefore} to ${key.notAfter}, not now`,
					);
				else if (object === undefined || !verifies(decoded.message, sig, object))
					refusal = refuse("bad-signature", `index statement signature by ${keyId} does not verify`);
			}
			if (refusal === undefined) {
				accepted = true;
				break;
			}
			first ??= refusal;
		}
		if (!accepted)
			return (
				first ??
				refuse(
					"unknown-key",
					`index statement is signed by ${decoded.signatures.map((signature) => signature.keyId).join(", ")}, none a certified key`,
				)
			);
		const statement = parseStatement(decoded.payload);
		if ("ok" in statement) return statement;
		const actual = sha256Hex(toBuffer(input.indexBytes));
		if (actual !== statement.indexSha256)
			return refuse(
				"index-hash-mismatch",
				`${statement.indexPath} has sha256 ${actual}, the statement pins ${statement.indexSha256}`,
			);
		if (!isSequence(input.minSequence)) return refuse("malformed", "minimum index sequence is not an integer");
		if (statement.sequence < input.minSequence)
			return refuse(
				"index-rollback",
				`index sequence ${statement.sequence} is lower than the accepted ${input.minSequence}`,
			);
		if (now >= (instant(statement.expires) as number))
			return refuse("expired", `index statement expired at ${statement.expires}`);
		return { ok: true, value: statement };
	} catch (err) {
		return refuse("malformed", `index statement could not be read: ${err instanceof Error ? err.message : String(err)}`);
	}
}
