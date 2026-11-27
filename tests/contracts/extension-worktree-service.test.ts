// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createExtensionRequestScope } from "../../src/domains/extensions/services/scope.js";
import {
	createExtensionWorktreeService,
	type ExtensionWorktreeError,
} from "../../src/domains/extensions/services/worktrees.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function project() {
	const root = mkdtempSync(join(tmpdir(), "worktree-service-"));
	const repo = join(root, "repo");
	mkdirSync(join(repo, "app"), { recursive: true });
	git(root, "init", "--quiet", repo);
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	writeFileSync(join(repo, "app", "a.txt"), "one\n");
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	const service = createExtensionWorktreeService({
		extensionId: "research",
		workspace: join(repo, "app"),
	});
	return { root, repo, service, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const code = (expected: string) => (error: ExtensionWorktreeError) => error.code === expected;

describe("extension worktree service", () => {
	it("creates a worktree mapped to the workspace, copies files in and commits with the host identity", async () => {
		const p = project();
		writeFileSync(join(p.repo, "app", "input.txt"), "uncommitted\n");
		const tree = await p.service.create({ copy: ["input.txt"], keep: true });
		assert.ok(tree.path.startsWith(join(p.repo, ".pancode", "worktrees", "ext-research")));
		assert.doesNotMatch(git(p.repo, "status", "--porcelain"), /\.pancode/u);
		assert.equal(tree.cwd, join(tree.path, "app"));
		assert.equal(readFileSync(join(tree.cwd, "input.txt"), "utf8"), "uncommitted\n");
		writeFileSync(join(tree.cwd, "a.txt"), "two\n");
		mkdirSync(join(tree.cwd, "cache"));
		writeFileSync(join(tree.cwd, "cache", "x"), "");
		const { head, leftOut } = await p.service.commit(tree.id, "change", { leaveOut: ["app/cache/"] });
		assert.notEqual(head, tree.head);
		assert.deepEqual(leftOut, ["app/cache/x"]);
		const changed = await p.service.git({ worktree: tree.id }, ["diff", "--name-only", tree.head, head]);
		assert.deepEqual(changed.stdout.trim().split("\n").sort(), ["app/a.txt", "app/input.txt"]);
		await p.service.clean(tree.id);
		assert.equal(existsSync(join(tree.cwd, "cache")), false);
		await p.service.checkout(tree.id, tree.head);
		assert.equal(readFileSync(join(tree.cwd, "a.txt"), "utf8"), "one\n");
		assert.deepEqual(
			(await p.service.list()).map((entry) => entry.id),
			[tree.id],
		);
		await p.service.remove(tree.id);
		assert.equal(existsSync(tree.path), false);
		p.cleanup();
	});

	it("removes a worktree the request did not keep when the request ends", async () => {
		const p = project();
		const scope = createExtensionRequestScope();
		const tree = await p.service.create({}, scope);
		assert.equal(tree.kept, false);
		await scope.end();
		assert.equal(existsSync(tree.path), false);
		assert.deepEqual(await p.service.list(), []);
		p.cleanup();
	});

	it("moves only the extension's own refs, by compare-and-swap", async () => {
		const p = project();
		const base = git(p.repo, "rev-parse", "HEAD");
		await p.service.refs.create("c1", base);
		assert.equal(git(p.repo, "rev-parse", "refs/heads/pancode/research/c1"), base);
		const tree = await p.service.create({ keep: true });
		writeFileSync(join(tree.cwd, "b.txt"), "b\n");
		const { head } = await p.service.commit(tree.id, "b");
		assert.equal(await p.service.refs.swap("c1", head, head, "stale"), false);
		assert.equal(await p.service.refs.swap("c1", head, base, "advance"), true);
		assert.equal(await p.service.refs.get("c1"), head);
		await assert.rejects(p.service.refs.create("../main", base), code("invalid"));
		await p.service.remove(tree.id);
		p.cleanup();
	});

	it("runs only reads that cannot write or reach outside the repository", async () => {
		const p = project();
		const outside = join(p.root, "outside.txt");
		writeFileSync(outside, "top-secret\n");
		symlinkSync(p.root, join(p.repo, "app", "escape-dir"));
		await assert.rejects(p.service.git("workspace", ["commit", "-m", "x"]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["diff", "--output=/tmp/x"]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["diff", "--no-index", "/etc/hosts", "a.txt"]), code("refused"));
		// Implicit `--no-index` (absolute, `..`, `--`, or symlinked directory) and external exclude files are refused too.
		await assert.rejects(p.service.git("workspace", ["diff", outside, "/dev/null"]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["diff", "--", outside, "/dev/null"]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["diff", "../../outside.txt", "/dev/null"]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["diff", "escape-dir/outside.txt", "/dev/null"]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["ls-files", "-X", outside]), code("refused"));
		await assert.rejects(p.service.git("workspace", ["rev-parse", "--resolve-git-dir", outside]), code("refused"));
		await assert.rejects(p.service.create({ copy: ["../secret"] }), code("invalid"));
		await assert.rejects(p.service.create({ copy: ["escape-dir/outside.txt"] }), code("refused"));
		const tree = await p.service.create({ keep: true });
		symlinkSync(p.root, join(tree.cwd, "escape-sub"));
		await assert.rejects(p.service.resolvePlace({ worktree: tree.id, sub: "escape-sub" }), code("refused"));
		await p.service.remove(tree.id);
		await assert.rejects(p.service.checkout("k-0000000000000000", "HEAD"), code("unknown_worktree"));
		const log = await p.service.git("workspace", ["log", "--format=%s"]);
		assert.equal(log.stdout.trim(), "base");
		p.cleanup();
	});

	it("refuses mutating worktree operations in a read-only session while keeping reads", async () => {
		const p = project();
		const ro = createExtensionWorktreeService({
			extensionId: "research",
			workspace: join(p.repo, "app"),
			readOnly: () => true,
		});
		await assert.rejects(ro.create(), code("refused"));
		await assert.rejects(ro.refs.create("c1", "HEAD"), code("refused"));
		assert.equal((await ro.git("workspace", ["log", "--format=%s"])).stdout.trim(), "base");
		p.cleanup();
	});
});
