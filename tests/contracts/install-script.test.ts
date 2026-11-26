// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Contracts for scripts/install.sh, the curl-able installer that unpacks one
 * verified bundle. The installs here run the real script against a file://
 * mirror holding a small bundle whose Node is this test's own, so nothing
 * reaches the network or a real home.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "install.sh");
const TARGET = "linux-x64";
/** npm's SemVer beside this Node; the installer reads the active bundle's copy to order versions. */
const NPM_SEMVER = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "node_modules", "semver");

function run(args: string[], env: Record<string, string> = {}) {
	const home = mkdtempSync(join(tmpdir(), "pancode-install-script-"));
	try {
		const result = spawnSync("sh", [SCRIPT, ...args], {
			env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C", ...env },
			input: "",
			encoding: "utf8",
		});
		return {
			code: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			created: existsSync(join(home, ".local")),
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/**
 * Writes `pancode-<version>-<TARGET>.tar.gz` into `directory`: this test's Node behind a wrapper, the real
 * lifecycle helper, and a CLI that answers the commands the installer runs. Returns the archive's path.
 */
function writeBundle(scratch: string, directory: string, version: string): string {
	const tree = join(scratch, `tree-${version}`);
	const pkg = join(tree, "lib", "node_modules", "pancode");
	mkdirSync(join(tree, "bin"), { recursive: true });
	mkdirSync(join(tree, "lib", "node_modules", "npm", "node_modules"), { recursive: true });
	mkdirSync(join(pkg, "scripts"), { recursive: true });
	mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
	writeFileSync(join(tree, "bin", "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
	chmodSync(join(tree, "bin", "node"), 0o755);
	symlinkSync(NPM_SEMVER, join(tree, "lib", "node_modules", "npm", "node_modules", "semver"));
	writeFileSync(join(tree, "bundle.json"), JSON.stringify({ version, target: TARGET, node: process.versions.node }));
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@akougkas/pancode", version }));
	copyFileSync(join(ROOT, "scripts", "native-install.cjs"), join(pkg, "scripts", "native-install.cjs"));
	writeFileSync(
		join(pkg, "dist", "cli", "index.js"),
		[
			"const args = process.argv.slice(2);",
			'if (args[0] === "--version") console.log(`PanCode $' + '{require("../../package.json").version}`);',
			'if (args[0] === "doctor") console.log(JSON.stringify({ findings: [] }));',
			'if (args[0] === "tools") console.log(JSON.stringify({ ok: true, message: "pane host" }));',
			"",
		].join("\n"),
	);
	mkdirSync(directory, { recursive: true });
	const archive = join(directory, `pancode-${version}-${TARGET}.tar.gz`);
	const packed = spawnSync("tar", ["-czf", archive, "-C", tree, "."], { encoding: "utf8" });
	strictEqual(packed.status, 0, packed.stderr);
	rmSync(tree, { recursive: true });
	return archive;
}

/** A release in `mirror`: the bundle and the SHA256SUMS that lists it, or `sum` in place of its real checksum. */
function writeRelease(scratch: string, mirror: string, version: string, sum?: string): void {
	const directory = join(mirror, `v${version}`);
	const archive = writeBundle(scratch, directory, version);
	const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
	writeFileSync(join(directory, "SHA256SUMS"), `${sum ?? actual}  pancode-${version}-${TARGET}.tar.gz\n`);
}

describe("contracts/install-script", () => {
	it("pins the same Node floor as package.json engines.node", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } };
		const floor = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(pkg.engines?.node ?? "")?.[1];
		ok(floor, "package.json engines.node must be a >=X.Y.Z range");
		match(readFileSync(SCRIPT, "utf8"), new RegExp(`^NODE_MIN="${floor.replaceAll(".", "\\.")}"$`, "mu"));
	});

	it("keeps the body inside main() so a truncated download runs nothing", () => {
		const text = readFileSync(SCRIPT, "utf8");
		match(text, /\n\{ main "\$@"; \}\n$/u, "main runs from a brace group on the last line");
		strictEqual(text.indexOf("\nmain() {"), text.lastIndexOf("\nmain() {"));
	});

	it("hands --no-gui to the post-install and drops the desktop hint, so no desktop step runs (F-C17)", () => {
		const text = readFileSync(SCRIPT, "utf8");
		match(text, /PANCODE_INSTALL_GUI="\$install_gui" "\$node_bin" "\$entry" upgrade --post-install/u);
		match(text, /\[ "\$install_gui" = 0 \] \|\| printf 'Desktop app: pancode gui\\n'/u);
		match(text, /offer_gui\(\) \{\n\t\[ "\$install_gui" != 0 \] \|\| return 0/u);
	});

	it("installs a channel's bundle, pins an exact version or a bundle file, and never moves down unless told to leave a pre-release", {
		skip: process.platform === "win32" || !existsSync(NPM_SEMVER),
	}, () => {
		const root = mkdtempSync(join(tmpdir(), "pancode-install-bundle-"));
		try {
			const mirror = join(root, "mirror");
			const home = join(root, "home");
			const installRoot = join(root, "install");
			const bin = join(root, "bin");
			mkdirSync(join(mirror, "channel"), { recursive: true });
			mkdirSync(home);
			writeFileSync(join(mirror, "channel", "latest"), "0.9.0\n");
			writeRelease(root, mirror, "0.9.0");
			writeRelease(root, mirror, "0.9.2");
			const prerelease = writeBundle(root, join(root, "downloads"), "0.9.3-rc.1");
			const install = (...args: string[]) => {
				const result = spawnSync("sh", [SCRIPT, "--no-gui", "--install-dir", installRoot, "--bin-dir", bin, ...args], {
					cwd: root,
					env: {
						HOME: home,
						PATH: "/usr/bin:/bin",
						LANG: "C",
						TMPDIR: root,
						PANCODE_RELEASE_MIRROR: `file://${mirror}`,
						PANCODE_TARGET: TARGET,
					},
					input: "",
					encoding: "utf8",
				});
				return { code: result.status, output: `${result.stdout}${result.stderr}` };
			};
			const manifest = () => JSON.parse(readFileSync(join(installRoot, "install.json"), "utf8"));
			const activeVersion = () =>
				JSON.parse(readFileSync(join(manifest().current, "lib", "node_modules", "pancode", "package.json"), "utf8"))
					.version;

			const fresh = install();
			strictEqual(fresh.code, 0, fresh.output);
			match(fresh.output, /resolved latest to 0\.9\.0/u);
			match(fresh.output, /verified pancode-0\.9\.0-linux-x64\.tar\.gz/u);
			const first = manifest();
			strictEqual(first.schema, 3);
			strictEqual(first.current, join(installRoot, "versions", "0.9.0"));
			strictEqual(first.node, join(installRoot, "versions", "0.9.0", "bin", "node"));
			strictEqual(first.nodeBuild, TARGET);
			strictEqual(first.channel, "latest");
			strictEqual(first.versionPin, "");
			strictEqual(first.autoUpdate, true);
			ok(!existsSync(join(installRoot, "runtime")), "a version carries its own Node");
			const launched = spawnSync(join(bin, "pancode"), ["--version"], {
				env: { HOME: home, PATH: "/usr/bin:/bin" },
				encoding: "utf8",
			});
			strictEqual(launched.stdout.trim(), "PanCode 0.9.0", launched.stderr);

			const exact = install("--version", "0.9.2");
			strictEqual(exact.code, 0, exact.output);
			strictEqual(manifest().versionPin, "0.9.2");
			strictEqual(manifest().pinSource, "version-flag");
			strictEqual(manifest().previous, join(installRoot, "versions", "0.9.0"));

			const older = install();
			strictEqual(older.code, 1, older.output);
			match(older.output, /latest channel resolved to 0\.9\.0, older than the active 0\.9\.2/u);
			// The flag leaves only a pre-release; a stable active install is still protected.
			match(install("--leave-prerelease").output, /older than the active 0\.9\.2/u);
			strictEqual(activeVersion(), "0.9.2");

			const fromFile = install("--bundle", prerelease);
			strictEqual(fromFile.code, 0, fromFile.output);
			strictEqual(manifest().versionPin, "0.9.3-rc.1");
			strictEqual(manifest().pinSource, "bundle-file");
			match(install().output, /older than the active 0\.9\.3-rc\.1/u);
			const leaving = install("--leave-prerelease");
			strictEqual(leaving.code, 0, leaving.output);
			match(leaving.output, /leaving the pre-release 0\.9\.3-rc\.1 for stable 0\.9\.0/u);
			strictEqual(activeVersion(), "0.9.0");
			strictEqual(manifest().versionPin, "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("installs nothing from a bundle that fails its checksum or a release with no bundle for this target", {
		skip: process.platform === "win32",
	}, () => {
		const root = mkdtempSync(join(tmpdir(), "pancode-install-refusal-"));
		try {
			const mirror = join(root, "mirror");
			const home = join(root, "home");
			const installRoot = join(root, "install");
			mkdirSync(home);
			writeRelease(root, mirror, "0.9.0", "0".repeat(64));
			mkdirSync(join(mirror, "v0.9.1"));
			writeFileSync(join(mirror, "v0.9.1", "SHA256SUMS"), `${"1".repeat(64)}  pancode-0.9.1-darwin-arm64.tar.gz\n`);
			const install = (version: string) => {
				const result = spawnSync(
					"sh",
					[SCRIPT, "--no-gui", "--install-dir", installRoot, "--bin-dir", join(root, "bin"), "--version", version],
					{
						cwd: root,
						env: {
							HOME: home,
							PATH: "/usr/bin:/bin",
							LANG: "C",
							TMPDIR: root,
							PANCODE_RELEASE_MIRROR: `file://${mirror}`,
							PANCODE_TARGET: TARGET,
						},
						input: "",
						encoding: "utf8",
					},
				);
				return { code: result.status, stderr: result.stderr };
			};
			const tampered = install("0.9.0");
			strictEqual(tampered.code, 1, tampered.stderr);
			match(tampered.stderr, /pancode-0\.9\.0-linux-x64\.tar\.gz has SHA-256 [0-9a-f]{64}, but the release lists 0{64}/u);
			const missing = install("0.9.1");
			strictEqual(missing.code, 1, missing.stderr);
			match(missing.stderr, /PanCode 0\.9\.1 ships no linux-x64 bundle.*npm install -g @akougkas\/pancode@0\.9\.1/u);
			const unpublished = install("0.9.7");
			strictEqual(unpublished.code, 1, unpublished.stderr);
			match(
				unpublished.stderr,
				/PanCode 0\.9\.7 is not published at file:\/\/\S+ \(it has no v0\.9\.7\/SHA256SUMS\); check the version, or leave out --version/u,
			);
			ok(!unpublished.stderr.includes("network"), unpublished.stderr);
			strictEqual(readdirSync(join(installRoot, "versions")).length, 0);
			ok(!existsSync(join(installRoot, "install.json")));
			ok(!existsSync(join(installRoot, ".install-lock")), "a refused install releases its lock");
			ok(!existsSync(join(root, "bin", "pancode")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects version specs that could reach a different package or a shell", () => {
		for (const spec of ["latest; id", "npm:evil@1.0.0", "../evil", ">=0.4.0", "file:/x", "0.4", "Latest", "$(id)"]) {
			const r = run(["--dry-run", "--version", spec]);
			strictEqual(r.code, 1, `spec ${JSON.stringify(spec)} must be refused:\n${r.stderr}`);
			match(r.stderr, /invalid --version/u);
		}
	});

	it("dry run names the plan and writes nothing", () => {
		const r = run(["--dry-run", "--version", "v0.9.0", "--no-auto-update", "--no-modify-path"]);
		strictEqual(r.code, 0, r.stderr);
		match(
			r.stdout,
			/bundle: +PanCode 0\.9\.0 for \S+ from https:\/\/github\.com\/akougkas\/pancode\/releases\/download$/mu,
		);
		match(r.stdout, /would unpack the bundle into .*\/versions\/<version>/u);
		match(r.stdout, /dry run complete/u);
		ok(!r.created, "a dry run creates nothing under HOME");
	});

	it("refuses an option it does not have, before any write", () => {
		const r = run(["--node-version", "24"]);
		strictEqual(r.code, 1, r.stderr);
		match(r.stderr, /unknown option: --node-version \(see --help\)/u);
		ok(!r.created);
	});

	it("rollback without an owned installation fails without creating an install", () => {
		const r = run(["--rollback"]);
		strictEqual(r.code, 1);
		match(r.stderr, /no installer manifest/u);
		ok(!r.created);
	});
});
