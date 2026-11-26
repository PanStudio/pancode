// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotThrow, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const buildModule = "../../scripts/release/build.mjs";
const bundleModule = "../../scripts/release/bundle.mjs";
const publishModule = "../../scripts/release/publish.mjs";
const gateEnvModule = "../../scripts/gate-env.mjs";

describe("release decisions", () => {
	it("publishes a stable version to latest, an rc to beta, and a development version nowhere", async () => {
		const { releaseChannel } = await import(buildModule);
		strictEqual(releaseChannel("0.9.0"), "latest");
		strictEqual(releaseChannel("0.9.1-rc.2"), "beta");
		for (const version of ["0.9.1-dev", "0.9.1-dev.3", "0.9.1-beta.1", "0.9", "v0.9.0"])
			strictEqual(releaseChannel(version), null, version);
	});

	it("pins one Node archive by SHA-256 for every bundle target", async () => {
		const { runtime, TARGETS, bundleName } = await import(bundleModule);
		deepStrictEqual(TARGETS, [
			"linux-x64",
			"linux-arm64",
			"linux-x64-glibc-217",
			"linux-x64-musl",
			"linux-arm64-musl",
			"darwin-x64",
			"darwin-arm64",
			"win-x64",
			"win-arm64",
		]);
		for (const target of TARGETS) {
			const pin = runtime.targets[target];
			strictEqual(pin.url.includes(`/v${runtime.version}/node-v${runtime.version}-`), true, target);
			strictEqual(/^[a-f0-9]{64}$/u.test(pin.sha256), true, target);
		}
		strictEqual(bundleName("0.9.0", "linux-x64"), "pancode-0.9.0-linux-x64.tar.gz");
	});

	it("refuses to publish a development version, a dirty build or an asset that differs from SHA256SUMS", async () => {
		const { readRelease } = await import(publishModule);
		const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
		const scratch = mkdtempSync(join(tmpdir(), "pancode-release-"));
		try {
			mkdirSync(join(scratch, "assets"));
			const tarball = Buffer.from("tarball bytes");
			const write = (release: Record<string, unknown>, served = tarball) => {
				writeFileSync(join(scratch, "assets", "package.tgz"), served);
				writeFileSync(
					join(scratch, "assets", "SHA256SUMS"),
					`${createHash("sha256").update(tarball).digest("hex")}  package.tgz\n`,
				);
				writeFileSync(
					join(scratch, "release.json"),
					JSON.stringify({
						name: "@akougkas/pancode",
						version,
						commit: "0".repeat(40),
						dirty: false,
						channel: "latest",
						tarball: "package.tgz",
						integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
						assets: ["package.tgz", "SHA256SUMS"],
						...release,
					}),
				);
			};
			write({});
			doesNotThrow(() => readRelease(scratch));
			doesNotThrow(() => readRelease(scratch, "0".repeat(40)));
			throws(() => readRelease(scratch, "1".repeat(40)), /not this run's commit 1{40}/u);
			write({ channel: null });
			throws(() => readRelease(scratch), /development version/u);
			write({ dirty: true });
			throws(() => readRelease(scratch), /uncommitted changes/u);
			write({}, Buffer.from("other bytes"));
			throws(() => readRelease(scratch), /does not match SHA256SUMS/u);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("gate environment", () => {
	it("gives every gate process one zone and locale, with a named override for sweeps", async () => {
		const { pinGateEnv } = await import(gateEnvModule);
		deepStrictEqual(
			pinGateEnv({ TZ: "America/Chicago", LANG: "de_DE.UTF-8", LANGUAGE: "de", LC_TIME: "de_DE" }, "linux"),
			{
				TZ: "UTC",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
			},
		);
		strictEqual(pinGateEnv({ PANCODE_TEST_TZ: "Pacific/Kiritimati" }, "linux").TZ, "Pacific/Kiritimati");
		deepStrictEqual(pinGateEnv({ LANG: "de_DE.UTF-8" }, "win32"), { TZ: "UTC", LANG: "de_DE.UTF-8" });
	});
});
