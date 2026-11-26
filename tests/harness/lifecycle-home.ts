// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * An isolated PanCode home for the lifecycle command contracts.
 *
 * `reset` and `uninstall` delete whole roots, so their tests must never resolve
 * a real one. Every root is pinned with its own `PANCODE_*_DIR` variable
 * rather than by HOME alone, because `PANCODE_HOME` and the XDG variables
 * inherited from the developer's shell would otherwise still be consulted, and
 * a test that leaks one of those deletes the machine's actual PanCode state.
 *
 * The commands write their transcript with `process.stdout.write`. The capture
 * never replaces that around a call: the test runner reports to its parent over
 * the same stream, and a replacement held across an await swallowed those
 * frames, so a file reported fewer tests than it ran. One dispatcher is
 * installed when this module loads and sends a write to a capture only when it
 * comes from that command's own async context; every other write passes through.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const capture = new AsyncLocalStorage<{ stdout: string }>();
const writeThrough = process.stdout.write;
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
	const sink = capture.getStore();
	if (!sink) return writeThrough.call(process.stdout, chunk, ...(rest as []));
	sink.stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
	for (const argument of rest) if (typeof argument === "function") argument();
	return true;
}) as typeof process.stdout.write;

export interface LifecycleHome {
	root: string;
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	binDir: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

export interface LifecycleHomeOptions {
	/** Seed the roots with recognizable files. Defaults to true. */
	populate?: boolean;
}

export function createLifecycleHome(prefix: string, options: LifecycleHomeOptions = {}): LifecycleHome {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const configDir = join(root, ".config", "pancode");
	const dataDir = join(root, ".local", "share", "pancode");
	const stateDir = join(root, ".local", "state", "pancode");
	const cacheDir = join(root, ".cache", "pancode");
	const binDir = join(root, ".local", "bin");

	if (options.populate ?? true) {
		for (const dir of [configDir, dataDir, stateDir, cacheDir, binDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(configDir, "settings.yaml"), "theme: custom-theme\n", "utf8");
		writeFileSync(join(configDir, "credentials.yaml"), "key: test-secret\n", "utf8");
		writeFileSync(join(dataDir, "records.json"), '["memory"]\n', "utf8");
		writeFileSync(join(stateDir, "home.json"), '{"version":"0.4.2"}\n', "utf8");
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		writeFileSync(join(cacheDir, "derived.bin"), "0123456789", "utf8");
	}

	return {
		root,
		configDir,
		dataDir,
		stateDir,
		cacheDir,
		binDir,
		env: {
			HOME: root,
			NODE_ENV: "test",
			PANCODE_HOME: "",
			PANCODE_CONFIG_DIR: configDir,
			PANCODE_DATA_DIR: dataDir,
			PANCODE_STATE_DIR: stateDir,
			PANCODE_CACHE_DIR: cacheDir,
			PANCODE_BIN_DIR: binDir,
			XDG_CONFIG_HOME: join(root, ".config"),
			XDG_DATA_HOME: join(root, ".local", "share"),
			XDG_STATE_HOME: join(root, ".local", "state"),
			XDG_CACHE_HOME: join(root, ".cache"),
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Publish a session heartbeat under `home`, as an open session does. */
export function writeLiveSession(
	home: LifecycleHome,
	owner: { host: string; pid: number },
	id = "20261102-open-session",
): void {
	const at = new Date().toISOString();
	mkdirSync(join(home.stateDir, "live"), { recursive: true });
	writeFileSync(
		join(home.stateDir, "live", `${id}.json`),
		`${JSON.stringify({
			schema: 1,
			id,
			cwd: "/work/project",
			cwdHash: "abc123",
			host: owner.host,
			pid: owner.pid,
			birth: null,
			startedAt: at,
			at,
			surface: "tui",
			version: "0.0.0",
			user: "test",
		})}\n`,
		"utf8",
	);
}

/**
 * Run one lifecycle command against `home`, returning its exit code and stdout.
 *
 * The environment is restored key by key, never by `process.env = saved`.
 * Assigning a plain object to `process.env` detaches Node's env proxy: the
 * native environment stops tracking later writes, so `os.homedir()` freezes at
 * whatever it read last. Every test that ran after such a restore then resolved
 * the developer's real home instead of the temp one, which is how a shell-rc
 * probe under test came to read the machine's own ~/.bashrc.
 */
export async function runInHome(
	home: LifecycleHome,
	run: () => Promise<number>,
): Promise<{ code: number; stdout: string }> {
	const keys = Object.keys(home.env);
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	const savedIsTty = process.stdout.isTTY;
	const sink = { stdout: "" };

	for (const key of keys) {
		const value = home.env[key];
		if (value === undefined || value === "") delete process.env[key];
		else process.env[key] = value;
	}
	// Non-TTY, so the presenter degrades to plain text and the assertions read
	// the words rather than the rail. NO_COLOR is cleared by the tmp-root
	// harness, so this is the only thing choosing the lane.
	process.stdout.isTTY = false;

	try {
		return { code: await capture.run(sink, run), stdout: sink.stdout };
	} finally {
		process.stdout.isTTY = savedIsTty;
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
