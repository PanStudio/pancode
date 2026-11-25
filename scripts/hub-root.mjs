#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * PanHub root key tool, run by the maintainer on an offline machine.
 *
 *   keygen  --out <dir>
 *           write a root private key (PKCS#8 PEM, mode 0600) as <dir>/hub-root.key.pem and print the base64
 *           public key and the line for src/domains/resources/hub-keys.ts
 *   certify --root-key <file> [--root-key <file>] --sequence <n>
 *           --key <base64 public key>:<notBefore>:<notAfter> [--key ...] [--revoke <keyId> ...] --out <file>
 *           write a key certificate (hub/keys/signing.json) signed by each root key; refuses a sequence that is
 *           not higher than the one in an existing --out file. Dates are ISO instants or YYYY-MM-DD (UTC)
 *   verify  --certificate <file> [--root-pub <base64> ...]
 *           print the certified keys or the refusal; without --root-pub, the keys compiled into PanCode
 *
 * Fails closed: any problem prints one line and exits 1. A private key is never printed.
 */
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HUB_ROOT_PUBLIC_KEYS } from "../src/domains/resources/hub-keys.ts";
import {
	HUB_KEYS_PAYLOAD_TYPE,
	hubKeyId,
	hubPublicKeyBase64,
	signHubEnvelope,
	verifyKeyCertificate,
} from "../src/domains/resources/hub-signature.ts";

const TOOL = "hub-root";
const DATE = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?`;
const KEY_SPEC = new RegExp(`^([A-Za-z0-9+/]+={0,2}):(${DATE}):(${DATE})$`, "u");

function fail(message) {
	throw new Error(message);
}

function option(values, name) {
	const value = values[name];
	if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
	return value;
}

function positiveInteger(text, name) {
	if (!/^[1-9]\d*$/u.test(text) || !Number.isSafeInteger(Number(text))) fail(`--${name} must be a positive integer`);
	return Number(text);
}

function readEd25519PrivateKey(file) {
	const key = createPrivateKey(readFileSync(file));
	if (key.asymmetricKeyType !== "ed25519") fail(`${file} is not an Ed25519 private key`);
	return key;
}

function keygen(values) {
	const dir = resolve(option(values, "out"));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, "hub-root.key.pem");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
	const pub = hubPublicKeyBase64(publicKey);
	console.log(`root private key: ${file} (keep offline)`);
	console.log(`root public key: ${pub} (key id ${hubKeyId(pub)})`);
	console.log("src/domains/resources/hub-keys.ts:");
	console.log(`export const HUB_ROOT_PUBLIC_KEYS: ReadonlyArray<string> = [${JSON.stringify(pub)}];`);
}

function isoDate(text, spec) {
	const time = Date.parse(/T/u.test(text) ? text : `${text}T00:00:00Z`);
	if (!Number.isFinite(time)) fail(`--key ${spec}: ${text} is not a date`);
	return new Date(time).toISOString();
}

function certify(values) {
	const roots = (values["root-key"] ?? []).map(readEd25519PrivateKey);
	if (roots.length === 0) fail("--root-key is required");
	const rootPubs = roots.map(hubPublicKeyBase64);
	const sequence = positiveInteger(option(values, "sequence"), "sequence");
	const out = resolve(option(values, "out"));
	const keys = (values.key ?? []).map((spec) => {
		const match = KEY_SPEC.exec(spec);
		if (!match) fail(`--key ${spec} is not <base64 public key>:<notBefore>:<notAfter>`);
		const [, publicKey, from, until] = match;
		const keyId = hubKeyId(publicKey);
		if (keyId === undefined) fail(`--key ${spec}: not a base64 raw Ed25519 public key`);
		const notBefore = isoDate(from, spec);
		const notAfter = isoDate(until, spec);
		if (notBefore >= notAfter) fail(`--key ${spec}: notBefore is not before notAfter`);
		return { keyId, publicKey, notBefore, notAfter };
	});
	const revoked = values.revoke ?? [];
	for (const id of revoked) if (!/^[0-9a-f]{16}$/u.test(id)) fail(`--revoke ${id} is not a 16-hex key id`);
	const ids = keys.map((key) => key.keyId);
	if (new Set(ids).size !== ids.length) fail("a key is listed twice");
	const both = ids.find((id) => revoked.includes(id));
	if (both) fail(`key ${both} is both certified and revoked`);
	if (rootPubs.some((pub) => ids.includes(hubKeyId(pub)))) fail("a root key cannot certify itself as a signing key");
	if (existsSync(out)) {
		const existing = verifyKeyCertificate({ envelope: readFileSync(out), rootKeys: rootPubs, minSequence: 0 });
		if (!existing.ok) fail(`existing ${out} does not verify under the given root key: ${existing.message}`);
		if (sequence <= existing.value.sequence)
			fail(`--sequence ${sequence} is not higher than ${existing.value.sequence} in ${out}`);
	}
	const envelope = signHubEnvelope(HUB_KEYS_PAYLOAD_TYPE, { sequence, keys, revoked }, roots);
	const text = `${JSON.stringify(envelope, null, "\t")}\n`;
	const check = verifyKeyCertificate({ envelope: text, rootKeys: rootPubs, minSequence: sequence });
	if (!check.ok) fail(`the new certificate does not verify: ${check.message}`);
	mkdirSync(dirname(out), { recursive: true });
	const staging = `${out}.${process.pid}.tmp`;
	writeFileSync(staging, text, { flag: "wx" });
	renameSync(staging, out);
	console.log(`certified ${keys.length} key(s), revoked ${revoked.length}, sequence ${sequence}: ${out}`);
}

function verifyCommand(values) {
	const file = option(values, "certificate");
	const rootKeys = values["root-pub"] ?? HUB_ROOT_PUBLIC_KEYS;
	const result = verifyKeyCertificate({ envelope: readFileSync(file), rootKeys, minSequence: 0 });
	if (!result.ok) {
		console.error(`${TOOL}: refused (${result.reason}): ${result.message}`);
		return 1;
	}
	const { sequence, keys, revoked } = result.value;
	console.log(`certificate sequence ${sequence}: ${keys.length} key(s), revoked [${revoked.join(", ")}]`);
	for (const key of keys) console.log(`  ${key.keyId} ${key.publicKey} ${key.notBefore} .. ${key.notAfter}`);
	return 0;
}

const COMMANDS = {
	keygen: { options: { out: { type: "string" } }, run: keygen },
	certify: {
		options: {
			"root-key": { type: "string", multiple: true },
			sequence: { type: "string" },
			key: { type: "string", multiple: true },
			revoke: { type: "string", multiple: true },
			out: { type: "string" },
		},
		run: certify,
	},
	verify: {
		options: { certificate: { type: "string" }, "root-pub": { type: "string", multiple: true } },
		run: verifyCommand,
	},
};

try {
	const [name, ...rest] = process.argv.slice(2);
	const command = Object.hasOwn(COMMANDS, name ?? "") ? COMMANDS[name] : undefined;
	if (!command) fail(`usage: ${TOOL}.mjs keygen|certify|verify [options]`);
	const { values } = parseArgs({ args: rest, options: command.options, strict: true, allowPositionals: false });
	process.exitCode = command.run(values) ?? 0;
} catch (err) {
	console.error(`${TOOL}: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
}
