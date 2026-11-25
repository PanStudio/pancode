// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { HUB_ROOT_PUBLIC_KEYS } from "../../src/domains/resources/hub-keys.js";
import type {
	HubEnvelope,
	HubKeyCertificate,
	HubRefusalReason,
	HubVerification,
} from "../../src/domains/resources/hub-signature.js";
import {
	HUB_INDEX_PAYLOAD_TYPE,
	HUB_KEYS_PAYLOAD_TYPE,
	hubKeyId,
	hubPublicKeyBase64,
	signHubEnvelope,
	verifyIndexStatement,
	verifyKeyCertificate,
} from "../../src/domains/resources/hub-signature.js";

const root = generateKeyPairSync("ed25519");
const signer = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const rootKeys = [hubPublicKeyBase64(root.publicKey)];
const signerPub = hubPublicKeyBase64(signer.publicKey);
const signerId = hubKeyId(signerPub) as string;
const NOW = new Date("2026-11-25T12:00:00.000Z");
const INDEX = "version: 1\npacks: []\n";

function certifiedKey(
	publicKey: string,
	notBefore = "2026-01-01T00:00:00.000Z",
	notAfter = "2027-01-01T00:00:00.000Z",
) {
	return { keyId: hubKeyId(publicKey) as string, publicKey, notBefore, notAfter };
}

function certificateEnvelope(
	sequence: number,
	options: { keys?: ReturnType<typeof certifiedKey>[]; revoked?: string[]; signers?: KeyObject[] } = {},
): string {
	const payload = { sequence, keys: options.keys ?? [certifiedKey(signerPub)], revoked: options.revoked ?? [] };
	return JSON.stringify(signHubEnvelope(HUB_KEYS_PAYLOAD_TYPE, payload, options.signers ?? [root.privateKey]));
}

function statementEnvelope(
	overrides: Record<string, unknown> = {},
	signers: KeyObject[] = [signer.privateKey],
): string {
	const payload = {
		sequence: 412,
		generatedAt: "2026-11-24T12:00:00.000Z",
		expires: "2026-12-24T12:00:00.000Z",
		commit: "a".repeat(40),
		indexPath: "hub/index.yaml",
		indexSha256: createHash("sha256").update(INDEX).digest("hex"),
		...overrides,
	};
	return JSON.stringify(signHubEnvelope(HUB_INDEX_PAYLOAD_TYPE, payload, signers));
}

function certified(envelope = certificateEnvelope(1)): HubKeyCertificate {
	const result = verifyKeyCertificate({ envelope, rootKeys, minSequence: 0 });
	if (!result.ok) throw new Error(`certificate refused: ${result.message}`);
	return result.value;
}

function verifyStatement(
	envelope: string,
	options: { index?: string; certificate?: HubKeyCertificate; now?: Date; minSequence?: number } = {},
) {
	return verifyIndexStatement({
		envelope,
		indexBytes: options.index ?? INDEX,
		certificate: options.certificate ?? certified(),
		now: options.now ?? NOW,
		minSequence: options.minSequence ?? 0,
	});
}

function refusedAs<T>(result: HubVerification<T>, reason: HubRefusalReason, label: string = reason): void {
	strictEqual(result.ok, false, `${label}: expected a refusal`);
	if (!result.ok) {
		strictEqual(result.reason, reason, `${label}: ${result.message}`);
		strictEqual(result.message.length > 0, true);
	}
}

function edited(envelope: string, change: (parsed: HubEnvelope) => void): string {
	const parsed = JSON.parse(envelope) as HubEnvelope;
	change(parsed);
	return JSON.stringify(parsed);
}

function flipByte(base64: string, at: number): string {
	const bytes = Buffer.from(base64, "base64");
	bytes[at] = (bytes[at] as number) ^ 0x01;
	return bytes.toString("base64");
}

test("a root-signed certificate and a statement by a certified key verify, beside signatures by unknown keys", () => {
	const certificate = certificateEnvelope(3, { signers: [stranger.privateKey, root.privateKey] });
	const keys = verifyKeyCertificate({ envelope: certificate, rootKeys, minSequence: 3 });
	strictEqual(keys.ok, true);
	if (keys.ok) {
		strictEqual(keys.value.sequence, 3);
		deepStrictEqual(
			keys.value.keys.map((key) => key.keyId),
			[signerId],
		);
	}
	const statement = verifyStatement(statementEnvelope({}, [stranger.privateKey, signer.privateKey]), {
		certificate: certified(certificate),
		minSequence: 412,
	});
	strictEqual(statement.ok, true);
	if (statement.ok) {
		strictEqual(statement.value.sequence, 412);
		strictEqual(statement.value.indexPath, "hub/index.yaml");
	}
});

test("one flipped byte in the index, the statement payload or the signature refuses", () => {
	const envelope = statementEnvelope();
	refusedAs(verifyStatement(envelope, { index: INDEX.replace("1", "2") }), "index-hash-mismatch");
	refusedAs(
		verifyStatement(
			edited(envelope, (parsed) => {
				parsed.payload = flipByte(parsed.payload, 20);
			}),
		),
		"bad-signature",
		"payload byte",
	);
	refusedAs(
		verifyStatement(
			edited(envelope, (parsed) => {
				const [signature] = parsed.signatures;
				if (signature) signature.sig = flipByte(signature.sig, 10);
			}),
		),
		"bad-signature",
		"signature byte",
	);
});

test("an expired statement and a key outside its validity window refuse", () => {
	refusedAs(
		verifyStatement(statementEnvelope({ generatedAt: "2026-10-01T00:00:00.000Z", expires: "2026-10-31T00:00:00.000Z" })),
		"expired",
	);
	const lapsed = certified(
		certificateEnvelope(1, { keys: [certifiedKey(signerPub, "2026-01-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z")] }),
	);
	refusedAs(verifyStatement(statementEnvelope(), { certificate: lapsed }), "key-not-valid-now", "lapsed key");
	const early = certified(
		certificateEnvelope(1, { keys: [certifiedKey(signerPub, "2026-12-01T00:00:00.000Z", "2027-12-01T00:00:00.000Z")] }),
	);
	refusedAs(verifyStatement(statementEnvelope(), { certificate: early }), "key-not-valid-now", "future key");
});

test("a statement or certificate below the accepted sequence is a rollback", () => {
	refusedAs(verifyStatement(statementEnvelope({ sequence: 411 }), { minSequence: 412 }), "index-rollback");
	refusedAs(
		verifyKeyCertificate({ envelope: certificateEnvelope(2), rootKeys, minSequence: 3 }),
		"certificate-rollback",
	);
});

test("a key revoked by a newer certificate refuses although its signature is valid", () => {
	const statement = statementEnvelope();
	strictEqual(verifyStatement(statement, { certificate: certified(certificateEnvelope(1)) }).ok, true);
	const successor = certifiedKey(hubPublicKeyBase64(stranger.publicKey));
	const newer = certified(certificateEnvelope(2, { keys: [successor], revoked: [signerId] }));
	refusedAs(verifyStatement(statement, { certificate: newer }), "revoked-key");
});

test("a certificate signed by a key that is not a root key refuses", () => {
	refusedAs(
		verifyKeyCertificate({
			envelope: certificateEnvelope(1, { signers: [signer.privateKey] }),
			rootKeys,
			minSequence: 0,
		}),
		"bad-root-signature",
	);
});

test("with no root key, every certificate refuses", () => {
	for (const keys of [[], HUB_ROOT_PUBLIC_KEYS])
		refusedAs(verifyKeyCertificate({ envelope: certificateEnvelope(1), rootKeys: keys, minSequence: 0 }), "no-root-key");
});

test("malformed input refuses as malformed and never throws", () => {
	const certificate = certificateEnvelope(1);
	const statement = statementEnvelope();
	const certificateCases: Record<string, string | Uint8Array> = {
		"not JSON": "{not json",
		"not an object": "[]",
		"wrong payloadType": edited(certificate, (parsed) => {
			parsed.payloadType = HUB_INDEX_PAYLOAD_TYPE;
		}),
		"bad payload base64": edited(certificate, (parsed) => {
			parsed.payload = "%%%";
		}),
		"bad signature base64": edited(certificate, (parsed) => {
			parsed.signatures = [{ keyId: hubKeyId(rootKeys[0] as string) as string, sig: "not base64!" }];
		}),
		"no signatures": edited(certificate, (parsed) => {
			parsed.signatures = [];
		}),
		"missing keys": JSON.stringify(
			signHubEnvelope(HUB_KEYS_PAYLOAD_TYPE, { sequence: 1, revoked: [] }, [root.privateKey]),
		),
		"invalid UTF-8": new Uint8Array([0xff, 0xfe, 0x00]),
	};
	for (const [label, envelope] of Object.entries(certificateCases))
		refusedAs(verifyKeyCertificate({ envelope, rootKeys, minSequence: 0 }), "malformed", label);
	const statementCases: Record<string, string> = {
		"not JSON": "",
		"wrong payloadType": edited(statement, (parsed) => {
			parsed.payloadType = HUB_KEYS_PAYLOAD_TYPE;
		}),
		"bad payload base64": edited(statement, (parsed) => {
			parsed.payload = `${parsed.payload.slice(1)}`;
		}),
		"missing commit": statementEnvelope({ commit: undefined }),
		"missing expires": statementEnvelope({ expires: undefined }),
	};
	for (const [label, envelope] of Object.entries(statementCases))
		refusedAs(verifyStatement(envelope), "malformed", label);
	refusedAs(verifyStatement(statement, { now: new Date(Number.NaN) }), "malformed", "invalid clock");
});
