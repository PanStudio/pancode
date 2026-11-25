// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One home for PanCode state isolation in tests. Every test that touches PanCode state
 * needs a throwaway `PANCODE_HOME` with the four per-root `PANCODE_*_DIR` vars pointing
 * inside it (per-root vars beat `PANCODE_HOME`, so they must move in lockstep), and
 * in-process tests must also reset the XDG cache so `src/` re-resolves the scratch
 * dirs. This module is the single implementation the harness and contract tests
 * delegate to, in three flavors matching the three call sites:
 *
 *   - makeScratchHome()  — child-process isolation: returns an env to hand a
 *     spawned binary (does not mutate process.env).
 *   - isolatePancodeEnv()   — in-process isolation with a full env backup/restore.
 *   - newScratchPancodeHome()/clearScratchPancodeHome() — in-process isolation that
 *     keeps the scratch dir as a plain string (minimal beforeEach/afterEach edit).
 *
 * The in-process flavors point `process.env.PANCODE_*` at a scratch dir and
 * restore it later; that window is a single process-wide critical section, not
 * a per-test one. Under `--experimental-test-isolation=none` every contract file
 * shares one process, and Node's own test-runner scheduling can interleave two
 * files' beforeEach/afterEach even when neither file's own test bodies do
 * anything concurrent (issue #84: `interop-consent.test.ts` and
 * `interop-state.test.ts`, both fully synchronous test bodies, still clobbered
 * each other's `PANCODE_HOME` at full-suite scale; the gap the runner
 * itself inserts between hook invocations was enough). Acquiring an
 * in-process lock before mutating `process.env` and releasing it on restore
 * serializes every window process-wide, so two isolated-env regions from
 * different files can never overlap in wall-clock time regardless of how the
 * runner schedules them. `makeScratchHome()` never touches `process.env`, so
 * it does not need the lock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTONOMY_CEILING_ENV } from "../../src/core/bash-exec.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { YOLO_CONFINEMENT_PIN_ENV } from "../../src/domains/safety/autonomy.js";

/**
 * The keys a PanCode session writes into its tool commands' environment. A test
 * run from that session's bash inherits them, so a scratch env drops them.
 */
export const GENERATED_TOOL_ENV_KEYS = [AUTONOMY_CEILING_ENV, YOLO_CONFINEMENT_PIN_ENV] as const;

/** Removes the generated tool env keys from `env` in place. */
export function dropGeneratedToolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	for (const key of GENERATED_TOOL_ENV_KEYS) Reflect.deleteProperty(env, key);
	return env;
}

let envLockChain: Promise<void> = Promise.resolve();

/**
 * Queues behind whatever isolated-env window is currently open and returns a
 * release function; call it exactly once when this window's env mutation is
 * fully undone. Every acquire before it must release before this one resolves.
 */
async function acquireEnvLock(): Promise<() => void> {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const previous = envLockChain;
	envLockChain = gate;
	await previous;
	return release;
}

export interface ScratchPancodeEnvOptions {
	/** Set PANCODE_REQUIRE_HOME_PREFIX=1 (child-process/binary isolation wants this; in-process tests do not). */
	requireHomePrefix?: boolean;
}

/** The PANCODE_* env vars that isolate all PanCode state under `dir`. */
export function scratchPancodeEnvVars(dir: string, options: ScratchPancodeEnvOptions = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PANCODE_HOME: dir,
		PANCODE_DATA_DIR: join(dir, "data"),
		PANCODE_CONFIG_DIR: join(dir, "config"),
		PANCODE_STATE_DIR: join(dir, "state"),
		PANCODE_CACHE_DIR: join(dir, "cache"),
		PANCODE_INTEROP_HOME: "none",
		PANCODE_VERIFICATION_SLOT_DIR: join(dir, "verification-slot"),
	};
	if (options.requireHomePrefix) env.PANCODE_REQUIRE_HOME_PREFIX = "1";
	return env;
}

export interface ScratchHome {
	dir: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

/**
 * Child-process isolation: make a fresh scratch home and return its dir, the
 * PANCODE_* env to hand a spawned binary (including PANCODE_REQUIRE_HOME_PREFIX), and a
 * cleanup. Does not touch process.env — the child reads env fresh.
 */
export function makeScratchHome(prefix = "pancode-e2e-"): ScratchHome {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return {
		dir,
		env: scratchPancodeEnvVars(dir, { requireHomePrefix: true }),
		cleanup() {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}

/** Release functions for open newScratchPancodeHome() windows, keyed by scratch dir. */
const openScratchHomeReleases = new Map<string, () => void>();

/**
 * Point process.env at a fresh scratch home and reset the XDG cache so in-process
 * `src/` code resolves the scratch dirs. Returns the dir as a plain string; pair
 * it with clearScratchPancodeHome(dir) in afterEach. Does not back up process.env.
 *
 * Async because it queues behind the process-wide env lock (see module header):
 * `beforeEach` must `await` it so a concurrently-scheduled suite's own window
 * can't open while this one is still live.
 */
export async function newScratchPancodeHome(prefix = "pancode-scratch-"): Promise<string> {
	const release = await acquireEnvLock();
	const dir = mkdtempSync(join(tmpdir(), prefix));
	openScratchHomeReleases.set(dir, release);
	Object.assign(process.env, scratchPancodeEnvVars(dir));
	resetXdgCache();
	return dir;
}

/** Remove a scratch home created by newScratchPancodeHome, reset the XDG cache, and release the env lock. */
export function clearScratchPancodeHome(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	resetXdgCache();
	const release = openScratchHomeReleases.get(dir);
	if (release) {
		openScratchHomeReleases.delete(dir);
		release();
	}
}

export interface IsolatedPancodeEnv {
	dir: string;
	restore: () => void;
}

/**
 * In-process isolation with a full process.env snapshot: mkdtemp a scratch home,
 * point the PANCODE_* vars at it, reset the XDG cache, and return restore() that
 * undoes every env change (removing keys the test added), removes the scratch,
 * and resets the cache again. Use this where a test must leave process.env
 * exactly as it found it.
 *
 * Async for the same reason as newScratchPancodeHome(): it queues behind the
 * process-wide env lock, so `beforeEach` must `await` it.
 */
export async function isolatePancodeEnv(prefix = "pancode-scratch-"): Promise<IsolatedPancodeEnv> {
	const release = await acquireEnvLock();
	const envBackup: NodeJS.ProcessEnv = { ...process.env };
	const dir = mkdtempSync(join(tmpdir(), prefix));
	Object.assign(process.env, scratchPancodeEnvVars(dir));
	dropGeneratedToolEnv(process.env);
	resetXdgCache();
	return {
		dir,
		restore() {
			for (const key of Object.keys(process.env)) {
				if (!(key in envBackup)) Reflect.deleteProperty(process.env, key);
			}
			for (const [key, value] of Object.entries(envBackup)) {
				if (value !== undefined) process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
			resetXdgCache();
			release();
		},
	};
}
