// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadProjectPancodeMd } from "../../src/domains/context/pancode-md.js";

const root = mkdtempSync(join(tmpdir(), "pancode-handbook-discovery-"));
after(() => rmSync(root, { recursive: true, force: true }));

function handbook(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "PANCODE.md");
	writeFileSync(path, `# ${name}\n\n${name} guidance.\n`);
	return path;
}

describe("handbook discovery", () => {
	it("stops at the repository root, so a handbook for the directory holding many repos stays out of each", () => {
		handbook(root, "Container");
		const repo = join(root, "repo");
		const repoHandbook = handbook(repo, "Repo");
		mkdirSync(join(repo, ".git"));
		const nested = handbook(join(repo, "packages", "app"), "Package");
		deepStrictEqual(
			loadProjectPancodeMd(join(repo, "packages", "app")).files.map((file) => file.path),
			[repoHandbook, nested],
		);
	});

	it("treats a .git file as a root too, as in a worktree or submodule", () => {
		const worktree = join(root, "worktree");
		const own = handbook(worktree, "Worktree");
		writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
		deepStrictEqual(
			loadProjectPancodeMd(worktree).files.map((file) => file.path),
			[own],
		);
	});

	it("outside any repository loads only the directory's own handbook", () => {
		handbook(join(root, "plain"), "Plain");
		const child = handbook(join(root, "plain", "child"), "Child");
		deepStrictEqual(
			loadProjectPancodeMd(join(root, "plain", "child")).files.map((file) => file.path),
			[child],
		);
	});

	it("loads PANCODE-DEV.md ahead of PANCODE.md only at the root of PanCode's own checkout", () => {
		const checkout = (dir: string, packageName: string): string => {
			handbook(dir, "Generated");
			for (const marker of [
				"src/entry/orchestrator.ts",
				"src/worker/entry.ts",
				"src/domains/prompts/fragments/identity/pancode.md",
			]) {
				mkdirSync(join(dir, marker, ".."), { recursive: true });
				writeFileSync(join(dir, marker), "");
			}
			mkdirSync(join(dir, ".git"));
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: packageName, repository: "https://github.com/akougkas/pancode" }),
			);
			const own = join(dir, "PANCODE-DEV.md");
			writeFileSync(own, "# Hand-written\n\nHand-written guidance.\n");
			return own;
		};
		const own = checkout(join(root, "pancode-checkout"), "@akougkas/pancode");
		deepStrictEqual(
			loadProjectPancodeMd(join(root, "pancode-checkout")).files.map((file) => file.path),
			[own],
		);
		checkout(join(root, "other-checkout"), "@example/other");
		deepStrictEqual(
			loadProjectPancodeMd(join(root, "other-checkout")).files.map((file) => file.path),
			[join(root, "other-checkout", "PANCODE.md")],
		);
	});
});
