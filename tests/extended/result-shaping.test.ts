// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { pancodeStateDir } from "../../src/core/xdg.js";
import { sweepExpiredToolOffloads, TOOL_OFFLOAD_MAX_AGE_MS } from "../../src/tools/result-shaping.js";
import { type IsolatedPancodeEnv, isolatePancodeEnv } from "../harness/scratch-env.js";

describe("contracts/result-shaping", () => {
	let scratch: IsolatedPancodeEnv;

	beforeEach(async () => {
		scratch = await isolatePancodeEnv("pancode-sweep-contract-");
	});

	afterEach(() => scratch.restore());

	it("returns zero removed and skipped when scratch directory is absent", async () => {
		const result = await sweepExpiredToolOffloads();
		deepStrictEqual(result, { removed: 0, skipped: 0 });
	});

	it("sweeps expired offload files and cleans up empty session directories", async () => {
		const scratchDir = join(pancodeStateDir(), "scratch");
		const sessionDir = join(scratchDir, "session-1");
		mkdirSync(sessionDir, { recursive: true });

		const expiredPath = join(sessionDir, "expired.txt");
		const freshPath = join(sessionDir, "fresh.txt");
		writeFileSync(expiredPath, "expired content");
		writeFileSync(freshPath, "fresh content");

		const now = Date.now();
		const oldTime = (now - TOOL_OFFLOAD_MAX_AGE_MS - 10_000) / 1000;
		utimesSync(expiredPath, oldTime, oldTime);

		// A sweep stopped at shutdown removes nothing; the next launch sweeps again.
		deepStrictEqual(await sweepExpiredToolOffloads(now, () => true), { removed: 0, skipped: 0 });
		strictEqual(existsSync(expiredPath), true);
		const result = await sweepExpiredToolOffloads(now);
		deepStrictEqual(result, { removed: 1, skipped: 0 });
		strictEqual(existsSync(freshPath), true);
	});

	it("tolerates missing files and counts permission errors into skipped figure", async () => {
		const scratchDir = join(pancodeStateDir(), "scratch");
		const unreadableDir = join(scratchDir, "unreadable-session");
		mkdirSync(unreadableDir, { recursive: true });
		chmodSync(unreadableDir, 0);

		try {
			const result = await sweepExpiredToolOffloads();
			strictEqual(result.removed, 0);
			strictEqual(result.skipped, 1);
		} finally {
			chmodSync(unreadableDir, 0o755);
		}
	});
});
