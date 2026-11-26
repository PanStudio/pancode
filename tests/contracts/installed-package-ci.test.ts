// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

test("the pipeline builds the release once and every later job consumes that artifact", () => {
	type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
	const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
		jobs: Record<string, { needs?: string | string[]; steps: Step[] }>;
	};
	const { build, test: tests, install, "tested-run": tested, publish } = workflow.jobs;
	ok(build?.steps.some((step) => step.run?.includes("scripts/release/build.mjs") && step.run.includes("--targets all")));
	ok(build?.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "release"));
	const downloads = (job: { steps: Step[] }, runId?: string): boolean =>
		job.steps.some(
			(step) =>
				step.uses?.startsWith("actions/download-artifact@") &&
				step.with?.name === "release" &&
				step.with["run-id"] === runId,
		);
	for (const [name, job] of Object.entries({ tests, install })) {
		ok(job, name);
		ok([job.needs].flat().includes("build"), `${name} needs build`);
		ok(downloads(job), `${name} downloads the built release`);
	}
	// A release takes the artifact of the push run that built and tested its commit.
	ok(tested && downloads(tested, `\${{ steps.find.outputs.run-id }}`), "tested-run downloads the push run's release");
	ok(publish?.needs === "tested-run", "publish needs tested-run");
	ok(downloads(publish, `\${{ needs.tested-run.outputs.run-id }}`), "publish downloads the release tested-run checked");
	for (const [name, job] of Object.entries({ tests, install, tested, publish }))
		ok(!job?.steps.some((step) => /build\.mjs|npm pack|run build/u.test(step.run ?? "")), `${name} builds nothing`);
	ok(install?.steps.some((step) => step.run?.includes("scripts/release/smoke.mjs")));
	ok(tested.steps.some((step) => step.run?.includes("scripts/release/tested-run.mjs find")));
	ok(publish.steps.some((step) => step.run?.includes("scripts/release/publish.mjs")));
});

test("the package's license files are the committed bytes and LICENSE is the only one", async () => {
	const module = "../../scripts/packed-license.mjs";
	const { packedLicenseProblems } = await import(module);
	const root = process.cwd();
	const report = JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		}),
	)[0];
	const packed = report.files.map((file: { path: string }) => file.path);
	deepStrictEqual(packedLicenseProblems(root, packed, root), []);

	const scratch = mkdtempSync(join(tmpdir(), "pancode-packed-license-"));
	try {
		const files = ["LICENSE", "NOTICE", "package.json"];
		const stage = () => {
			for (const name of files) writeFileSync(join(scratch, name), readFileSync(join(root, name)));
		};
		stage();
		deepStrictEqual(packedLicenseProblems(scratch, files, root), []);

		const license = readFileSync(join(root, "LICENSE"));
		const at = license.indexOf("Licensor");
		license.writeUInt8(license.readUInt8(at) ^ 0x20, at);
		writeFileSync(join(scratch, "LICENSE"), license);
		deepStrictEqual(packedLicenseProblems(scratch, files, root), ["packed LICENSE differs from the committed LICENSE"]);

		stage();
		mkdirSync(join(scratch, "packages/sdk"), { recursive: true });
		writeFileSync(join(scratch, "packages/sdk/LICENSE"), readFileSync(join(root, "packages/sdk/LICENSE")));
		ok(
			packedLicenseProblems(scratch, [...files, "packages/sdk/LICENSE"], root).some((problem: string) =>
				problem.startsWith("packages/sdk/LICENSE is in the package"),
			),
		);

		rmSync(join(scratch, "NOTICE"));
		deepStrictEqual(packedLicenseProblems(scratch, ["LICENSE", "package.json"], root), [
			"NOTICE is missing from the package",
		]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
