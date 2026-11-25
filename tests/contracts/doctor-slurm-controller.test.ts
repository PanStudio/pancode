// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { hpcToolchainFindings } from "../../src/cli/doctor-hpc.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

it("doctor warns for a Slurm client with no controller configuration", async () => {
	const env = await isolatePancodeEnv("doctor-slurm-controller-");
	try {
		const bin = join(env.dir, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "sbatch"),
			`#!/bin/sh\necho call >> '${join(env.dir, "calls")}'\necho "fetch_config: DNS SRV lookup failed" >&2\nexit 1\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = bin;
		const hpc = await hpcToolchainFindings({ workspaceRoot: env.dir });
		const sbatchFinding = hpc.find((row) => row.name === "toolchain sbatch");
		ok(sbatchFinding);
		strictEqual(readFileSync(join(env.dir, "calls"), "utf8").trim(), "call");
		strictEqual(sbatchFinding.level, "warn");
		match(sbatchFinding.detail, /no Slurm configuration or controller to reach/);
	} finally {
		env.restore();
	}
});
