// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { runtimeEscapeMasksUnder } from "../../src/core/sandbox/worker-process.js";

describe("worker sandbox masks root-equivalent daemon sockets", () => {
	// Masks are realpath'd, so the root must be too when TMPDIR has a symlinked component (macOS /var).
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pancode-daemon-sockets-")));
	after(() => rmSync(root, { recursive: true, force: true }));

	it("masks container and virtualization daemon sockets that exist under the root", () => {
		const files = [
			"run/docker.sock",
			"var/snap/lxd/common/lxd/unix.socket",
			"var/lib/lxd/unix.socket",
			"var/lib/incus/unix.socket",
			"var/lib/incus/unix.socket.user",
		];
		const dirs = [
			"run/podman",
			"run/containerd",
			"run/libvirt",
			"run/incus",
			"run/crio",
			"run/k3s/containerd",
			"run/buildkit",
		];
		for (const file of files) {
			mkdirSync(dirname(join(root, file)), { recursive: true });
			writeFileSync(join(root, file), "");
		}
		for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
		const masks = runtimeEscapeMasksUnder(root).map((mask) => [mask.path.slice(root.length + 1), mask.kind]);
		deepStrictEqual(
			new Set(masks.map(([path, kind]) => `${path}:${kind}`)),
			new Set([...files.map((file) => `${file}:file`), ...dirs.map((dir) => `${dir}:directory`)]),
		);
	});

	it("masks WSL2's Windows interop socket directory and WSLg only on a WSL2 kernel", () => {
		for (const dir of ["run/WSL", "mnt/wslg"]) mkdirSync(join(root, dir), { recursive: true });
		const masked = (wsl: "wsl1" | "wsl2" | null): string[] =>
			runtimeEscapeMasksUnder(root, wsl)
				.map((mask) => `${mask.path.slice(root.length + 1)}:${mask.kind}`)
				.filter((entry) => /WSL|wslg/u.test(entry));
		deepStrictEqual(masked("wsl2"), ["run/WSL:directory", "mnt/wslg:directory"]);
		deepStrictEqual(masked(null), []);
		deepStrictEqual(masked("wsl1"), []);
	});
});
