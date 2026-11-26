#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * Writes scripts/release/node-runtime.json: the one Node.js release every bundle carries, with the URL and
 * SHA-256 of its archive for each target. Run by hand when the bundled Node moves:
 *
 *   node scripts/release/pin-node.mjs 24.22.3
 *
 * The official checksum file is verified against the Node.js release keys, which the project publishes
 * outside nodejs.org. The unofficial builds (musl, glibc 2.17) are unsigned; their hashes are pinned as
 * served and reviewed in the diff.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL = "https://nodejs.org/dist";
const UNOFFICIAL = "https://unofficial-builds.nodejs.org/download/release";
const KEYRING = "https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx";

/** Target name to the archive that provides its Node. */
const TARGETS = {
	"linux-x64": [OFFICIAL, "linux-x64.tar.gz"],
	"linux-arm64": [OFFICIAL, "linux-arm64.tar.gz"],
	"linux-x64-glibc-217": [UNOFFICIAL, "linux-x64-glibc-217.tar.gz"],
	"linux-x64-musl": [UNOFFICIAL, "linux-x64-musl.tar.gz"],
	"linux-arm64-musl": [UNOFFICIAL, "linux-arm64-musl.tar.gz"],
	"darwin-x64": [OFFICIAL, "darwin-x64.tar.gz"],
	"darwin-arm64": [OFFICIAL, "darwin-arm64.tar.gz"],
	"win-x64": [OFFICIAL, "win-x64.zip"],
	"win-arm64": [OFFICIAL, "win-arm64.zip"],
};

async function fetchBytes(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/u.test(version ?? "")) {
	console.error("usage: pin-node.mjs <node version, such as 24.22.3>");
	process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "pancode-pin-node-"));
try {
	const sums = {};
	for (const base of [OFFICIAL, UNOFFICIAL]) {
		const text = await fetchBytes(`${base}/v${version}/SHASUMS256.txt`);
		if (base === OFFICIAL) {
			writeFileSync(join(scratch, "SHASUMS256.txt"), text);
			writeFileSync(join(scratch, "SHASUMS256.txt.sig"), await fetchBytes(`${base}/v${version}/SHASUMS256.txt.sig`));
			writeFileSync(join(scratch, "pubring.kbx"), await fetchBytes(KEYRING));
			execFileSync(
				"gpgv",
				["--keyring", join(scratch, "pubring.kbx"), join(scratch, "SHASUMS256.txt.sig"), join(scratch, "SHASUMS256.txt")],
				{ stdio: ["ignore", "ignore", "inherit"] },
			);
		}
		sums[base] = new Map(
			text
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => line.trim().split(/\s+/u).reverse()),
		);
	}
	const targets = {};
	for (const [target, [base, suffix]] of Object.entries(TARGETS)) {
		const file = `node-v${version}-${suffix}`;
		const sha256 = sums[base].get(file);
		if (!/^[a-f0-9]{64}$/u.test(sha256 ?? "")) throw new Error(`${base} lists no checksum for ${file}`);
		targets[target] = { url: `${base}/v${version}/${file}`, sha256 };
	}
	writeFileSync(
		fileURLToPath(new URL("node-runtime.json", import.meta.url)),
		`${JSON.stringify({ version, targets }, null, "\t")}\n`,
	);
	console.log(
		`Pinned Node ${version} for ${Object.keys(targets).length} targets; official checksums signature-verified.`,
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
