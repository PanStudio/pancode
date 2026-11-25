// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scratchPancodeEnvVars } from "../harness/scratch-env.js";

// Describing the main-session sandbox names PanCode's roots read-only without
// creating them, so doctor creates no data or state root on a home that has
// only its config (DOG-001); like any run it may refresh PanCode's caches. A spawn creates an absent root before binding it: bubblewrap's
// -try binds skip a missing path, and a script could then create PanCode's cache
// root under the writable XDG cache root and plant contents PanCode later trusts.
const home = realpathSync(mkdtempSync(join(tmpdir(), "pancode-sandbox-roots-")));
const xdgCache = join(home, ".cache");
const pancodeCache = join(xdgCache, "pancode");
Object.assign(process.env, scratchPancodeEnvVars(home), {
	HOME: home,
	XDG_CACHE_HOME: xdgCache,
	PANCODE_CACHE_DIR: pancodeCache,
});
const { resetXdgCache } = await import("../../src/core/xdg.js");
resetXdgCache();
const { sandboxAvailability } = await import("../../src/core/sandbox/availability.js");
const { mainSandboxPolicy, planMainSandboxSpawn, resolveMainSandboxPolicy } = await import(
	"../../src/core/sandbox/main-session.js"
);
const { collectDoctorFindings } = await import("../../src/cli/doctor.js");
after(() => rmSync(home, { recursive: true, force: true }));

const workspace = join(home, "workspace");
mkdirSync(workspace);
mkdirSync(join(home, "config"));
// The operator's XDG cache root exists, as it does on any desktop.
mkdirSync(xdgCache);
const later = [join(home, "data"), join(home, "state"), pancodeCache];

function run(file: string, args: string[]): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
			resolve({ code, output: `${stdout}${stderr}` });
		});
	});
}

describe("main-session sandbox PanCode roots", () => {
	it("the policy names PanCode's roots read-only and creates none of them; doctor creates no data or state root", async () => {
		const policy = mainSandboxPolicy({ workspace, scratchRoots: [] });
		deepEqual(policy.pancodeDirs, [join(home, "config"), ...later]);
		for (const dir of policy.pancodeDirs) ok(policy.readOnlyPaths.includes(dir), dir);
		for (const dir of later) ok(!existsSync(dir), `${dir} is not created`);
		await collectDoctorFindings({ deep: false, workspaceRoot: workspace });
		for (const dir of later.slice(0, 2)) ok(!existsSync(dir), `${dir} is not created`);
		rmSync(pancodeCache, { recursive: true, force: true });
	});

	it("a PanCode root the spawn cannot create refuses the command", () => {
		const file = join(home, "not-a-dir");
		writeFileSync(file, "");
		const available = { available: true, backend: "bwrap" as const, executable: "/usr/bin/bwrap", reason: null };
		// Under the file and at the file itself: a regular file is no root to bind read-only over.
		for (const [dir, code] of [
			[join(file, "cache"), "ENOTDIR"],
			[file, "EEXIST"],
		] as const) {
			const policy = resolveMainSandboxPolicy({
				workspace,
				scratchRoots: [],
				pancodeDirs: [dir],
			});
			const plan = planMainSandboxSpawn(policy, { argv: ["/bin/true"] }, workspace, available);
			equal(plan.kind, "refused", dir);
			if (plan.kind === "refused") {
				match(plan.message, new RegExp(`could not create PanCode's directory .*${code}.*the command was not run`, "u"));
			}
		}
	});

	it("under bwrap a spawn creates an absent PanCode cache root and keeps it read-only", async (t) => {
		const availability = sandboxAvailability();
		if (!availability.available || availability.backend !== "bwrap") {
			t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
			return;
		}
		const policy = mainSandboxPolicy({ workspace, scratchRoots: [] });
		ok(!existsSync(pancodeCache));
		const forged = join(pancodeCache, "skill-frontmatter.json");
		const script = [
			`mkdir -p ${pancodeCache} 2>/dev/null`,
			`echo forged > ${forged} 2>/dev/null || echo pancode-cache-refused`,
			'echo ok > "$XDG_CACHE_HOME/package.txt"',
		].join("; ");
		const plan = planMainSandboxSpawn(policy, { argv: ["/bin/bash", "-c", script] }, workspace, availability);
		equal(plan.kind, "sandboxed");
		if (plan.kind !== "sandboxed") return;
		ok(existsSync(pancodeCache), "the plan creates the root it binds read-only");
		const result = await run(plan.file, plan.args);
		equal(result.code, 0, result.output);
		match(result.output, /pancode-cache-refused/u);
		ok(!existsSync(forged), "no forged cache file");
		ok(existsSync(join(pancodeCache, "sandbox-cache", "package.txt")), "the sandbox cache stays writable");
	});
});
