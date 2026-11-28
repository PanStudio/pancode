// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The environment a headless PanCode run inherits, by allowlist.
 *
 * A headless child (`pancode run` or `verifiers dry-run`) needs the homes and
 * credentials its target reads, but nothing else the operator's shell holds:
 * another target's key, a cloud login, an agent socket or a terminal
 * multiplexer's pane identity would otherwise reach a model run in yolo or in
 * a worktree it may write freely. Passed on top of the safe-exec allowlist
 * (PATH, HOME, USER, LANG, TMPDIR, the XDG base dirs and the Windows system
 * variables): PanCode's own `PANCODE_*`, locale, terminal, proxy and CA
 * variables, the operator's `safety.sandboxPassEnv`, and for the run's target
 * only its declared key variable, its runtime's default, the engine's known
 * key names for its provider and the runtime's pass list below.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLAUDE_AUTH_ENV } from "../../../core/claude-environment.js";
import { findEngineEnvKeys } from "../../../engine/env-api-keys.js";
import { findBuiltinRuntimeBootMetadata } from "../../providers/runtimes/boot-manifest.js";
import { referencedOpenCodeCredentials } from "../../providers/runtimes/external-cli-policy.js";

export interface RunEnvPolicy {
	targets: ReadonlyArray<{
		id: string;
		runtime: string;
		auth?: { apiKeyEnvVar?: string; apiKeyRef?: string; oauthProfile?: string };
	}>;
	/** The operator's `safety.sandboxPassEnv`: names their own runs already hand to commands. */
	passEnv: ReadonlyArray<string>;
	/** The target a run that names none resolves to (`chat.connection`), whose credentials it then needs. */
	defaultTarget?: string | null;
}

const BASE_NAMES = [
	"TERM",
	"COLORTERM",
	"SHELL",
	"TZ",
	"LANGUAGE",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"NODE_OPTIONS",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
];

const BASE_PREFIXES = ["PANCODE_", "LC_"];

interface RuntimePass {
	names?: ReadonlyArray<string>;
	prefixes?: ReadonlyArray<string>;
	/** Names the runtime finds in its own configuration. */
	referenced?: (source: NodeJS.ProcessEnv) => ReadonlyArray<string>;
}

/**
 * What each runtime reads beyond its key. The subprocess runtimes forward the same names to their CLI; the SDK
 * runtimes hand their CLI the whole environment, so their families pass by prefix.
 */
const RUNTIME_PASS_ENV: Readonly<Record<string, RuntimePass>> = {
	"claude-code": { names: CLAUDE_AUTH_ENV },
	"claude-sdk": { names: CLAUDE_AUTH_ENV, prefixes: ["ANTHROPIC_", "CLAUDE_CODE_"] },
	"codex-cli": { names: ["CODEX_HOME"] },
	"opencode-cli": {
		names: ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"],
		referenced: (source) => Object.keys(referencedOpenCodeCredentials(source)),
	},
	"pi-cli": { names: ["PI_CODING_AGENT_DIR"] },
	"copilot-sdk": { names: ["GH_HOST", "GH_CONFIG_DIR", "DBUS_SESSION_BUS_ADDRESS"], prefixes: ["COPILOT_"] },
	google: {
		names: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"],
	},
	ollama: { names: ["OLLAMA_API_KEY"] },
};

/** Never passed: a contender is its own pane-less process, and a forwarded pane id would report as the operator's. */
const NEVER_PREFIXES = ["HERDR_"];

function targetNames(
	policy: RunEnvPolicy,
	targetId: string,
	source: Readonly<Record<string, string>>,
): { names: string[]; prefixes: string[] } {
	const target = policy.targets.find((entry) => entry.id === targetId);
	if (target === undefined) return { names: [], prefixes: [] };
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	const runtimeId = runtime?.id ?? target.runtime;
	const pass = RUNTIME_PASS_ENV[runtimeId] ?? {};
	const providerId =
		target.auth?.oauthProfile?.trim() || target.auth?.apiKeyRef?.trim() || runtime?.oauthProviderId || runtimeId;
	const names = [
		target.auth?.apiKeyEnvVar?.trim() ?? "",
		runtime?.credentialsEnvVar ?? "",
		...(findEngineEnvKeys(providerId, source) ?? []),
		...(pass.names ?? []),
		...(pass.referenced?.(source) ?? []),
	].filter((name) => name.length > 0);
	return { names, prefixes: [...(pass.prefixes ?? [])] };
}

/** How to start this same PanCode: the executable, the arguments before the subcommand, and what its own start needs. */
export interface PancodeLaunch {
	file: string;
	args: ReadonlyArray<string>;
	/** Set on top of the contender's allowlisted environment, since the allowlist would drop it. */
	env?: Readonly<Record<string, string>>;
}

/**
 * This process's own launch for a child that runs in another directory. From source under tsx, `src/` reaches the
 * workspace packages (`@pancode/store`, ...) only through the checkout's tsconfig `paths`, and tsx looks for a
 * tsconfig from the child's cwd, so a child in a fixture copy outside the checkout failed at its first such import.
 * The tsconfig is the nearest one above the entry, since only a checkout runs a `.ts` entry.
 */
export function selfPancodeLaunch(entry: string, execArgv: ReadonlyArray<string> = process.execArgv): PancodeLaunch {
	const launch = { file: process.execPath, args: [...execArgv, entry] };
	if (!/\.[cm]?tsx?$/u.test(entry)) return launch;
	const tsconfig = process.env.TSX_TSCONFIG_PATH ?? nearestTsconfig(entry);
	return tsconfig === undefined ? launch : { ...launch, env: { TSX_TSCONFIG_PATH: tsconfig } };
}

function nearestTsconfig(entry: string): string | undefined {
	for (let dir = dirname(resolve(entry)); ; dir = dirname(dir)) {
		const candidate = join(dir, "tsconfig.json");
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * The variables of `source` one contender is given; the safe-exec allowlist is added when it starts. Reads only the
 * runtime's own configuration. `targetId` null is a check's `verifiers dry-run`, which needs no credentials.
 */
export function runEnv(
	source: Readonly<Record<string, string>>,
	policy: RunEnvPolicy,
	targetId: string | null,
): Record<string, string> {
	const scoped = targetId === null ? { names: [], prefixes: [] } : targetNames(policy, targetId, source);
	const names = new Set([...BASE_NAMES, ...policy.passEnv, ...scoped.names]);
	const prefixes = [...BASE_PREFIXES, ...scoped.prefixes];
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		if (names.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) env[name] = value;
	}
	return env;
}
