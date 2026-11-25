// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { borrowHeadlessRoute } from "../../src/cli/run.js";
import { settingsPath } from "../../src/core/config.js";
import { initializePancodeHome } from "../../src/core/init.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

test("a run refused because the only target is reserved for memory stops at that refusal", async (t) => {
	const home = await isolatePancodeEnv("pancode-run-memory-refusal-");
	t.after(() => home.restore());
	initializePancodeHome();
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	for (const runtime of registry.list()) if (runtime.credentialsEnvVar) delete process.env[runtime.credentialsEnvVar];
	process.env.RUNMEM_LITELLM_KEY = "fake-key";
	t.after(() => {
		delete process.env.RUNMEM_LITELLM_KEY;
	});
	writeFileSync(
		settingsPath(),
		'version: 2\ntargets:\n  - { id: litellm, runtime: litellm, url: "http://127.0.0.1:9", defaultModel: m1, auth: { apiKeyEnvVar: RUNMEM_LITELLM_KEY } }\ncontext:\n  memory: { target: litellm, model: m1 }\n',
	);
	// A null result would boot the run, which then prints the generic no-target line after the memory refusal.
	assert.equal(await borrowHeadlessRoute(undefined, undefined), 2);
});
