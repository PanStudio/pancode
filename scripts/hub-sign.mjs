#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The hub index signing tool, run by CI with a certified signing key.
 *
 *   keygen --out <dir>
 *          write a signing key pair as <dir>/hub-signing.key.pem (mode 0600) and <dir>/hub-signing.pub, and
 *          print the public key and key id for the maintainer to certify
 *   sign   --key-file <file> --index <path> --commit <sha> --sequence <n> --expires-days <n> --out <dir>
 *          write <dir>/index.envelope.json, an index statement over the index bytes. The private key is read
 *          from a file (mode 0600), never from an argument or an environment variable. --index is recorded
 *          relative to the working directory, so run from the repository root
 *   verify --envelope <file> --index <path> --certificate <file> [--root-pub <base64> ...]
 *          print the statement or the refusal; without --root-pub, the keys compiled into PanCode. Uses the
 *          same verification PanCode runs
 *
 * Fails closed: any problem prints one line and exits 1. A private key is never printed.
 */
import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { HUB_ROOT_PUBLIC_KEYS } from "../src/domains/resources/hub-keys.ts";
import {
	HUB_INDEX_PAYLOAD_TYPE,
	hubKeyId,
	hubPublicKeyBase64,
	signHubEnvelope,
	verifyIndexStatement,
	verifyKeyCertificate,
} from "../src/domains/resources/hub-signature.ts";

const TOOL = "hub-sign";
const ENVELOPE = "index.envelope.json";
const DAY_MS = 24 * 60 * 60 * 1000;

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

function keygen(values) {
	const dir = resolve(option(values, "out"));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pub = hubPublicKeyBase64(publicKey);
	writeFileSync(join(dir, "hub-signing.key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
		flag: "wx",
	});
	writeFileSync(join(dir, "hub-signing.pub"), `${pub}\n`, { flag: "wx" });
	console.log(`signing private key: ${join(dir, "hub-signing.key.pem")} (store as the hub-signing environment secret)`);
	console.log(`signing public key: ${pub} (key id ${hubKeyId(pub)})`);
	console.log(`certify with: hub-root.mjs certify --key ${pub}:<notBefore>:<notAfter> ...`);
}

function readSigningKey(file) {
	// Like ssh, refuse a key other users can read; CI writes it with mode 0600.
	if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0)
		fail(`${file} is readable by other users; chmod 600 it`);
	const key = createPrivateKey(readFileSync(file));
	if (key.asymmetricKeyType !== "ed25519") fail(`${file} is not an Ed25519 private key`);
	return key;
}

function sign(values) {
	const key = readSigningKey(option(values, "key-file"));
	const index = option(values, "index");
	const indexPath = relative(process.cwd(), resolve(index));
	if (indexPath.length === 0 || indexPath.startsWith("..") || isAbsolute(indexPath))
		fail(`--index ${index} is outside the working directory`);
	const commit = option(values, "commit");
	if (!/^[0-9a-f]{40}$/u.test(commit)) fail(`--commit ${commit} is not a 40-hex commit`);
	const sequence = positiveInteger(option(values, "sequence"), "sequence");
	const days = positiveInteger(option(values, "expires-days"), "expires-days");
	if (days > 366) fail("--expires-days must be at most 366");
	const out = resolve(option(values, "out"));
	const bytes = readFileSync(index);
	const now = Date.now();
	const statement = {
		sequence,
		generatedAt: new Date(now).toISOString(),
		expires: new Date(now + days * DAY_MS).toISOString(),
		commit,
		indexPath: indexPath.split(sep).join("/"),
		indexSha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const envelope = signHubEnvelope(HUB_INDEX_PAYLOAD_TYPE, statement, [key]);
	mkdirSync(out, { recursive: true });
	const file = join(out, ENVELOPE);
	const staging = `${file}.${process.pid}.tmp`;
	writeFileSync(staging, `${JSON.stringify(envelope, null, "\t")}\n`, { flag: "wx" });
	renameSync(staging, file);
	console.log(
		`signed ${statement.indexPath} sequence ${sequence} by ${envelope.signatures[0]?.keyId}, expires ${statement.expires}: ${file}`,
	);
}

function verifyCommand(values) {
	const rootKeys = values["root-pub"] ?? HUB_ROOT_PUBLIC_KEYS;
	const certificate = verifyKeyCertificate({
		envelope: readFileSync(option(values, "certificate")),
		rootKeys,
		minSequence: 0,
	});
	if (!certificate.ok) {
		console.error(`${TOOL}: refused (${certificate.reason}): ${certificate.message}`);
		return 1;
	}
	const result = verifyIndexStatement({
		envelope: readFileSync(option(values, "envelope")),
		indexBytes: readFileSync(option(values, "index")),
		certificate: certificate.value,
		now: new Date(),
		minSequence: 0,
	});
	if (!result.ok) {
		console.error(`${TOOL}: refused (${result.reason}): ${result.message}`);
		return 1;
	}
	const { sequence, indexPath, indexSha256, commit, expires } = result.value;
	console.log(
		`verified ${indexPath} sequence ${sequence} sha256 ${indexSha256} commit ${commit} expires ${expires} (certificate sequence ${certificate.value.sequence})`,
	);
	return 0;
}

const COMMANDS = {
	keygen: { options: { out: { type: "string" } }, run: keygen },
	sign: {
		options: {
			"key-file": { type: "string" },
			index: { type: "string" },
			commit: { type: "string" },
			sequence: { type: "string" },
			"expires-days": { type: "string" },
			out: { type: "string" },
		},
		run: sign,
	},
	verify: {
		options: {
			envelope: { type: "string" },
			index: { type: "string" },
			certificate: { type: "string" },
			"root-pub": { type: "string", multiple: true },
		},
		run: verifyCommand,
	},
};

try {
	const [name, ...rest] = process.argv.slice(2);
	const command = Object.hasOwn(COMMANDS, name ?? "") ? COMMANDS[name] : undefined;
	if (!command) fail(`usage: ${TOOL}.mjs keygen|sign|verify [options]`);
	const { values } = parseArgs({ args: rest, options: command.options, strict: true, allowPositionals: false });
	process.exitCode = command.run(values) ?? 0;
} catch (err) {
	console.error(`${TOOL}: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
}
