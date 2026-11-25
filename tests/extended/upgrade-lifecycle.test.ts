// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runUpgradeCommand, type UpgradeDependencies } from "../../src/cli/upgrade.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { type Installation, inspectInstallation } from "../../src/domains/lifecycle/install-method.js";
import { getVersionInfo } from "../../src/domains/lifecycle/version.js";
import { createLifecycleHome, type LifecycleHome, runInHome } from "../harness/lifecycle-home.js";

const installation = (kind: Installation["kind"]): Installation => ({
	...inspectInstallation(),
	kind,
	prefix: kind === "npm" ? "/fixture/prefix" : null,
});

/** Upgrade caches the resolved state dir, so every run gets a fresh resolution. */
async function upgrade(
	temp: LifecycleHome,
	argv: ReadonlyArray<string>,
	dependencies: Partial<UpgradeDependencies> = {},
): Promise<{ code: number; stdout: string }> {
	resetXdgCache();
	try {
		return await runInHome(temp, () =>
			runUpgradeCommand(argv, { inspectInstallation: () => installation("source"), ...dependencies }),
		);
	} finally {
		resetXdgCache();
	}
}

/** A home whose recorded version is already up to date. */
function currentHome(): LifecycleHome {
	const temp = createLifecycleHome("pancode-test-upgrade-");
	writeFileSync(join(temp.stateDir, "home.json"), JSON.stringify({ version: getVersionInfo().pancode }), "utf8");
	return temp;
}

describe("contracts/upgrade-lifecycle", () => {
	it("reports the detected facts before doing anything", async () => {
		const temp = currentHome();
		try {
			const version = getVersionInfo().pancode;
			const { code, stdout } = await upgrade(temp, [], { lookUpAvailableVersion: async () => ({ asked: true, version }) });
			strictEqual(code, 0);
			match(stdout, /Installation method: (source checkout|npm global)/u);
			match(stdout, new RegExp(`Current version: ${version}`, "u"));
			match(stdout, new RegExp(`Available version: ${version}`, "u"));
			match(stdout, /State dir: /u);
		} finally {
			temp.cleanup();
		}
	});

	it("exits 0 with one sentence when the version is current", async () => {
		const temp = currentHome();
		try {
			const version = getVersionInfo().pancode;
			const { code, stdout } = await upgrade(temp, [], { lookUpAvailableVersion: async () => ({ asked: true, version }) });
			strictEqual(code, 0);
			match(stdout, new RegExp(`Already on ${version}\\. Nothing to do\\.`, "u"));
		} finally {
			temp.cleanup();
		}
	});

	it("does not claim to be current when the registry was asked and could not answer", async () => {
		const temp = currentHome();
		try {
			// A lookup that failed compared nothing. Treating its null as "same as
			// installed" told an offline user they were up to date and skipped the
			// install they had asked for.
			const failed = await upgrade(temp, ["--dry-run"], {
				lookUpAvailableVersion: async () => ({ asked: true, version: null }),
			});
			ok(!/Already on /u.test(failed.stdout), `an unanswered lookup is not a current version:\n${failed.stdout}`);
			match(failed.stdout, /Available version: unknown \(the registry could not be reached\)/u);

			// A lookup that was never owed is a different fact, and says so.
			const skipped = await upgrade(temp, ["--dry-run"]);
			match(skipped.stdout, /Available version: not checked/u);
		} finally {
			temp.cleanup();
		}
	});

	it("previews the refresh, changing nothing", async () => {
		const temp = createLifecycleHome("pancode-test-upgrade-dry-");
		try {
			const homeJson = join(temp.stateDir, "home.json");
			const before = existsSync(homeJson) ? readFileSync(homeJson, "utf8") : null;
			const { code, stdout } = await upgrade(temp, ["--dry-run"]);
			strictEqual(code, 0);
			match(stdout, /Would refresh state metadata/u);
			match(stdout, /Dry run: no changes made/u);
			strictEqual(existsSync(homeJson) ? readFileSync(homeJson, "utf8") : null, before, "a preview writes nothing");
		} finally {
			temp.cleanup();
		}
	});

	it("puts the dry-run plan in the JSON report, not only in the prose", async () => {
		const temp = createLifecycleHome("pancode-test-upgrade-json-");
		try {
			const { code, stdout } = await upgrade(temp, ["--dry-run", "--json"]);
			strictEqual(code, 0);

			const parsed = JSON.parse(stdout) as {
				command: string;
				method: string;
				steps: Array<{ type: string; message: string }>;
				warnings: string[];
			};
			strictEqual(parsed.command, "upgrade");
			strictEqual(typeof parsed.method, "string");
			const messages = parsed.steps.map((step) => step.message);
			ok(
				messages.some((message) => message.startsWith("Would refresh ")),
				`the refresh is missing from the JSON plan:\n${stdout}`,
			);
			ok(parsed.warnings.includes("Dry run: no changes made"));
		} finally {
			temp.cleanup();
		}
	});

	it("refreshes state metadata an older build stamped", async () => {
		const temp = createLifecycleHome("pancode-test-upgrade-run-");
		try {
			const { code, stdout } = await upgrade(temp, []);
			strictEqual(code, 0);
			match(stdout, /✓ Refreshed /u);
			strictEqual(JSON.parse(readFileSync(join(temp.stateDir, "home.json"), "utf8")).version, getVersionInfo().pancode);
		} finally {
			temp.cleanup();
		}
	});

	it("refuses overlapping ownership roots before lookup or package replacement", async () => {
		const temp = currentHome();
		let touched = 0;
		try {
			temp.env.PANCODE_DATA_DIR = temp.configDir;
			const { code } = await upgrade(temp, [], {
				lookUpAvailableVersion: async () => {
					touched += 1;
					return { asked: true, version: "999.0.0" };
				},
				runNpmInstall: async () => {
					touched += 1;
				},
			});
			strictEqual(code, 2);
			strictEqual(touched, 0);
			ok(existsSync(join(temp.stateDir, "home.json")));
		} finally {
			temp.cleanup();
		}
	});

	it("parses --channel in both spellings and rejects anything else", async () => {
		const temp = currentHome();
		try {
			for (const argv of [
				["--channel=beta", "--dry-run"],
				["--channel", "beta", "--dry-run"],
			]) {
				const { code, stdout } = await upgrade(temp, argv);
				strictEqual(code, 0, `${argv.join(" ")} must parse`);
				// Only meaningful on an npm install; a source checkout prints no
				// channel line, so assert it is never the wrong one.
				ok(!/Channel: latest/u.test(stdout), `--channel beta must not read as latest:\n${stdout}`);
			}
			for (const argv of [["--channel=unknown"], ["--channel"], ["--channel", "--dry-run"]]) {
				const { code } = await upgrade(temp, argv);
				strictEqual(code, 2, `${argv.join(" ")} must be a usage error`);
			}
			strictEqual((await upgrade(temp, ["--nope"])).code, 2);
		} finally {
			temp.cleanup();
		}
	});
});

for (const failedStep of ["npm", "post-install", "doctor"] as const) {
	it(`reports ${failedStep} failure and stops the remaining upgrade steps`, async () => {
		const temp = createLifecycleHome("pancode-upgrade-runner-failure-");
		const calls: string[] = [];
		const run = async (step: string): Promise<void> => {
			calls.push(step);
			if (step === failedStep) throw new Error(`fixture ${step} failure`);
		};
		try {
			const { code, stdout } = await upgrade(temp, failedStep === "doctor" ? ["--post-install", "--json"] : ["--json"], {
				inspectInstallation: () => installation("npm"),
				lookUpAvailableVersion: async () => ({ asked: true, version: "99.0.0" }),
				runNpmInstall: async () => run("npm"),
				runPostInstallUpgrade: async () => run("post-install"),
				runDoctorFixAfterInstall: async () => run("doctor"),
			});
			strictEqual(code, 1);
			const report = JSON.parse(stdout);
			strictEqual(report.status, "error");
			match(report.errors.join("\n"), new RegExp(`fixture ${failedStep} failure`, "u"));
			ok(
				report.advice.some((entry: { command: string }) =>
					entry.command.includes(failedStep === "doctor" ? "doctor --fix" : "upgrade --post-install"),
				),
			);
			deepStrictEqual(
				calls,
				failedStep === "npm" ? ["npm"] : failedStep === "post-install" ? ["npm", "post-install"] : ["doctor"],
			);
		} finally {
			temp.cleanup();
		}
	});
}

it("hands post-install checks to the installed binary with the selected options", async () => {
	const temp = createLifecycleHome("pancode-upgrade-handoff-");
	const calls: string[] = [];
	try {
		const { code } = await upgrade(temp, ["--channel", "beta"], {
			inspectInstallation: () => installation("npm"),
			lookUpAvailableVersion: async () => ({ asked: true, version: "99.0.0" }),
			runNpmInstall: async (_installation, invocation) => {
				calls.push(`install:${invocation.args.at(-1)}`);
			},
			runPostInstallUpgrade: async (options) => {
				calls.push(`post:${options.channel}`);
			},
			runDoctorFixAfterInstall: async () => {
				throw new Error("the old process must not run doctor");
			},
		});
		strictEqual(code, 0);
		deepStrictEqual(calls, ["install:pancode@99.0.0", "post:beta"]);
	} finally {
		temp.cleanup();
	}
});
