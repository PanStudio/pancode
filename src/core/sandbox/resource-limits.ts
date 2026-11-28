// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { untrustedBwrapReason } from "./availability.js";
import {
	RESOURCE_LIMIT_KEYS,
	type ResourceLimitKey,
	type ResourceLimitSettings,
	type ResourceLimits,
} from "./types.js";

/**
 * Opt-in resource ceilings for one launch (P9, decision D13). On Linux each
 * limited command starts through `systemd-run --user --scope`, which asks the
 * user's systemd manager for a transient scope unit with the ceilings set and
 * execs the command in place, so its pid, process group and signals stay what
 * the launcher planned. The ceilings bound the whole tree the command starts.
 * PanCode moves no process between cgroups itself: it usually runs outside the
 * user manager's subtree, where that move needs the root-owned common ancestor.
 * No per-process rlimit stands in: RLIMIT_NPROC counts every process of the
 * account, and RLIMIT_AS breaks runtimes that reserve address space. Nothing
 * here is a disk quota.
 */

/** Which caller's ceilings: the main session's agent commands, or a dispatched worker's. */
export type ResourceLimitScope = "main" | "workers";

export type ResourceLimitState = { state: "enforced" } | { state: "unavailable" | "unsupported"; reason: string };

/** What this host can bound per launch, limit by limit. */
export interface ResourceCapability {
	memoryMiB: ResourceLimitState;
	tasks: ResourceLimitState;
	cpuPercent: ResourceLimitState;
	/** The trusted binaries a scope needs, when every check before the probe passed. */
	systemdRun: string | null;
	systemctl: string | null;
	/** The user-bus variables of PanCode's own environment, which `systemd-run --user` reads. */
	busEnv: Record<string, string>;
}

const PROBE_TIMEOUT_MS = 5000;
const SETTLE_TIMEOUT_MS = 5000;
const PROBE_MEMORY_MIB = 256;
const PROBE_TASKS = 64;
const CONTROLLER: Record<ResourceLimitKey, string> = { memoryMiB: "memory", tasks: "pids", cpuPercent: "cpu" };
const BUS_VARIABLES = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
/** The lines `systemd-run` writes when it cannot start the scope, before any command runs. */
const SYSTEMD_RUN_FAILURE =
	/^(Failed to (connect to bus|create bus connection|start transient scope unit|find executable|parse|set unit properties)|Unknown assignment|System has not been booted|See system logs)/u;
/** How often a scoped launch's leader is checked for having entered its scope. */
const SCOPE_ENTRY_POLL_MS = 5;

let cached: ResourceCapability | null = null;
let workerLimits: ResourceLimits | undefined;
let unitSequence = 0;
/** Scopes started and not yet settled, unit name to the systemctl that settles them. */
const liveScopes = new Map<string, { systemctl: string; env: NodeJS.ProcessEnv }>();

/** The ceilings a settings block sets, or undefined when it sets none. */
export function resourceLimitsFromSettings(settings: ResourceLimitSettings | undefined): ResourceLimits | undefined {
	if (settings === undefined) return undefined;
	const limits: ResourceLimits = {};
	for (const key of RESOURCE_LIMIT_KEYS) {
		const value = settings[key];
		if (value !== null) limits[key] = value;
	}
	return hasResourceLimits(limits) ? limits : undefined;
}

function hasResourceLimits(limits: ResourceLimits | undefined): limits is ResourceLimits {
	return limits !== undefined && RESOURCE_LIMIT_KEYS.some((key) => limits[key] !== undefined);
}

function everyLimit(state: ResourceLimitState): Pick<ResourceCapability, ResourceLimitKey> {
	return { memoryMiB: state, tasks: state, cpuPercent: state };
}

function unavailableCapability(reason: string, busEnv: Record<string, string> = {}): ResourceCapability {
	return {
		...everyLimit({ state: "unavailable", reason }),
		systemdRun: null,
		systemctl: null,
		busEnv,
	};
}

/** Pure: each limit's state from the probe scope's own cgroup files, read inside it. */
export function capabilityFromProbe(
	probe: { status: number | null; stdout: string; stderr: string; timedOut: boolean },
	swapActive: boolean,
): Pick<ResourceCapability, ResourceLimitKey> {
	if (probe.timedOut)
		return everyLimit({
			state: "unavailable",
			reason: `the systemd user manager did not start a scope within ${PROBE_TIMEOUT_MS / 1000} s`,
		});
	if (probe.status !== 0) {
		const said = probe.stderr
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim();
		return everyLimit({
			state: "unavailable",
			reason: `systemd-run --user --scope failed: ${said ?? `exit ${probe.status ?? "by signal"}`}`,
		});
	}
	const files = new Map<string, string>();
	for (const line of probe.stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) files.set(line.slice(0, eq), line.slice(eq + 1).trim());
	}
	const undelegated = (key: ResourceLimitKey, file: string): ResourceLimitState => ({
		state: "unavailable",
		reason: `the systemd user manager does not delegate the ${CONTROLLER[key]} controller (${file} reads ${files.get(file) ?? "nothing"})`,
	});
	let memoryMiB: ResourceLimitState =
		files.get("memory.max") === String(PROBE_MEMORY_MIB * 1024 * 1024)
			? { state: "enforced" }
			: undelegated("memoryMiB", "memory.max");
	if (memoryMiB.state === "enforced" && files.get("memory.swap.max") !== "0") {
		// Without swap accounting a memory ceiling pages out instead of holding; with no swap there is nowhere to go.
		if (swapActive)
			memoryMiB = {
				state: "unavailable",
				reason: `swap is on and not accounted to cgroups here (memory.swap.max reads ${files.get("memory.swap.max") ?? "nothing"}), so a memory ceiling would spill into swap`,
			};
	}
	const tasks: ResourceLimitState =
		files.get("pids.max") === String(PROBE_TASKS) ? { state: "enforced" } : undelegated("tasks", "pids.max");
	const cpuPercent: ResourceLimitState = /^100000 \d+$/u.test(files.get("cpu.max") ?? "")
		? { state: "enforced" }
		: undelegated("cpuPercent", "cpu.max");
	return { memoryMiB, tasks, cpuPercent };
}

function trustedSystemdBinary(name: string): { path: string } | { reason: string } {
	let refusal: string | null = null;
	for (const dir of ["/usr/bin", "/bin"]) {
		const candidate = `${dir}/${name}`;
		try {
			accessSync(candidate, constants.X_OK);
		} catch {
			continue;
		}
		const untrusted = untrustedBwrapReason(candidate);
		if (untrusted === null) return { path: candidate };
		refusal ??= untrusted;
	}
	return { reason: refusal ?? `${name} is not installed in /usr/bin or /bin` };
}

function swapIsActive(): boolean {
	try {
		return readFileSync("/proc/swaps", "utf8").trim().split("\n").length > 1;
	} catch {
		return true;
	}
}

/**
 * The script the probe scope runs: each controller file of its own cgroup, as `name=value` lines. A controller the
 * user manager accepted a property for but does not delegate has no file there.
 */
const PROBE_SCRIPT = [
	"d=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)",
	"for f in memory.max memory.swap.max pids.max cpu.max; do",
	'v=$(cat "$d/$f" 2>/dev/null) || v=missing',
	`printf '%s=%s\\n' "$f" "$v"`,
	"done",
].join("\n");

/** Impure: probe this host once; a timeout is not cached, so a later launch probes again. */
function detectResourceCapability(): { capability: ResourceCapability; transient: boolean } {
	const platform = process.platform;
	if (platform !== "linux") {
		const host = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform;
		return {
			capability: {
				...everyLimit({
					state: "unsupported",
					reason: `${host} has no per-command resource ceiling PanCode can enforce; resource limits need Linux with a systemd user manager`,
				}),
				systemdRun: null,
				systemctl: null,
				busEnv: {},
			},
			transient: false,
		};
	}
	if (!existsSync("/sys/fs/cgroup/cgroup.controllers"))
		return {
			capability: unavailableCapability("cgroup v2 is not mounted at /sys/fs/cgroup"),
			transient: false,
		};
	const systemdRun = trustedSystemdBinary("systemd-run");
	if ("reason" in systemdRun) return { capability: unavailableCapability(systemdRun.reason), transient: false };
	const systemctl = trustedSystemdBinary("systemctl");
	if ("reason" in systemctl) return { capability: unavailableCapability(systemctl.reason), transient: false };
	const busEnv: Record<string, string> = {};
	for (const name of BUS_VARIABLES) {
		const value = process.env[name];
		if (value !== undefined && value.length > 0) busEnv[name] = value;
	}
	if (
		busEnv.DBUS_SESSION_BUS_ADDRESS === undefined &&
		(busEnv.XDG_RUNTIME_DIR === undefined || !existsSync(`${busEnv.XDG_RUNTIME_DIR}/bus`))
	)
		return {
			capability: unavailableCapability(
				"no systemd user manager bus: $XDG_RUNTIME_DIR/bus does not exist and DBUS_SESSION_BUS_ADDRESS is unset",
			),
			transient: false,
		};
	const probe = spawnSync(
		systemdRun.path,
		[
			...scopeArgs({ memoryMiB: PROBE_MEMORY_MIB, tasks: PROBE_TASKS, cpuPercent: 100 }, nextUnitName("probe")),
			"/bin/sh",
			"-c",
			PROBE_SCRIPT,
		],
		{ encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
	);
	const timedOut = (probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	const states = capabilityFromProbe(
		{
			status: probe.error !== undefined && !timedOut ? -1 : probe.status,
			stdout: probe.stdout ?? "",
			stderr: probe.error !== undefined && !timedOut ? probe.error.message : (probe.stderr ?? ""),
			timedOut,
		},
		swapIsActive(),
	);
	return {
		capability: { ...states, systemdRun: systemdRun.path, systemctl: systemctl.path, busEnv },
		transient: timedOut,
	};
}

/** Impure: this host's capability, probed once per process (about 0.1 s) and only when asked. */
function resourceCapability(): ResourceCapability {
	if (cached !== null) return cached;
	const { capability, transient } = detectResourceCapability();
	if (!transient) cached = capability;
	return capability;
}

function nextUnitName(kind: "cmd" | "probe"): string {
	unitSequence += 1;
	return `pancode-${kind}-${process.pid}-${unitSequence}-${randomBytes(3).toString("hex")}.scope`;
}

/**
 * Pure: the `systemd-run` arguments before the command. No `--collect`, so a scope the memory ceiling ended stays
 * as a failed unit with `Result=oom-kill` until PanCode reads and resets it; OOMPolicy=stop ends the whole command
 * there, not one process of it. Swap is held at zero so the memory ceiling holds.
 */
export function scopeArgs(limits: ResourceLimits, unit: string): string[] {
	const args = ["--user", "--scope", "--quiet", `--unit=${unit}`, "-p", "OOMPolicy=stop"];
	if (limits.memoryMiB !== undefined) args.push("-p", `MemoryMax=${limits.memoryMiB}M`, "-p", "MemorySwapMax=0");
	if (limits.tasks !== undefined) args.push("-p", `TasksMax=${limits.tasks}`);
	if (limits.cpuPercent !== undefined) args.push("-p", `CPUQuota=${limits.cpuPercent}%`);
	args.push("--");
	return args;
}

/**
 * Pure: why a launch with these ceilings may not start here, else null (D13: a set limit the host cannot enforce
 * refuses before launch). Names the first set limit that is not enforced.
 */
export function resourceLimitRefusal(
	limits: ResourceLimits,
	scope: ResourceLimitScope,
	capability: Pick<ResourceCapability, ResourceLimitKey>,
): string | null {
	for (const key of RESOURCE_LIMIT_KEYS) {
		if (limits[key] === undefined) continue;
		const state = capability[key];
		if (state.state === "enforced") continue;
		return `safety.resources.${scope}.${key} is set but this host cannot enforce it (${state.reason}); the command was not run. Unset the limit or run where a systemd user manager delegates the ${CONTROLLER[key]} controller.`;
	}
	return null;
}

/**
 * The ceilings a launch through an exec seam runs under: the caller's own (the main session's agent commands pass
 * theirs), else a dispatched worker's from its sealed spec.
 */
export function launchResourceLimits(
	own: ResourceLimits | undefined,
): { limits: ResourceLimits; scope: ResourceLimitScope } | undefined {
	if (hasResourceLimits(own)) return { limits: own, scope: "main" };
	return workerLimits === undefined ? undefined : { limits: workerLimits, scope: "workers" };
}

/** Impure: the refusal for a launch's ceilings on this host, before anything is planned for it; null runs it. */
export function launchResourceRefusal(
	launch: { limits: ResourceLimits; scope: ResourceLimitScope } | undefined,
): string | null {
	return launch === undefined ? null : resourceLimitRefusal(launch.limits, launch.scope, resourceCapability());
}

/** One limited launch: what to spawn, and what settles its scope afterwards. */
export interface ResourceScope {
	unit: string;
	scope: ResourceLimitScope;
	limits: ResourceLimits;
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	systemctl: string;
}

export type ResourceScopePlan =
	| { kind: "none" }
	| { kind: "refused"; message: string }
	| { kind: "scoped"; scope: ResourceScope };

/**
 * Impure: wrap one planned spawn (the sandbox launcher or the direct command) in a scope with these ceilings, or
 * refuse it. No ceiling set is no scope. `systemd-run` needs the user bus variables; one the command's own
 * environment lacks is given to `systemd-run` alone and unset again before the command starts.
 */
export function planResourceScope(
	launch: { limits: ResourceLimits; scope: ResourceLimitScope } | undefined,
	command: { file: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv },
): ResourceScopePlan {
	if (launch === undefined) return { kind: "none" };
	const { limits, scope } = launch;
	const capability = resourceCapability();
	const refusal = resourceLimitRefusal(limits, scope, capability);
	if (refusal !== null) return { kind: "refused", message: refusal };
	if (capability.systemdRun === null || capability.systemctl === null)
		return {
			kind: "refused",
			message: `safety.resources.${scope} is set but no systemd-run was found; the command was not run.`,
		};
	const added = Object.entries(capability.busEnv).filter(([name]) => command.env[name] === undefined);
	const payload =
		added.length === 0
			? [command.file, ...command.args]
			: ["/usr/bin/env", ...added.flatMap(([name]) => ["-u", name]), command.file, ...command.args];
	const unit = nextUnitName("cmd");
	const env = { ...command.env, ...Object.fromEntries(added) };
	liveScopes.set(unit, { systemctl: capability.systemctl, env });
	return {
		kind: "scoped",
		scope: {
			unit,
			scope,
			limits,
			file: capability.systemdRun,
			args: [...scopeArgs(limits, unit), ...payload],
			env,
			systemctl: capability.systemctl,
		},
	};
}

export interface ResourceScopeSettlement {
	/** The memory ceiling was reached and the kernel ended the command. */
	memoryExceeded: boolean;
	/**
	 * No unit was left to read and the leader was never seen inside it: a command that finished within moments, or
	 * a scope `systemd-run` never started. {@link scopeLaunchFailure} tells them apart from the command's output.
	 */
	launchUnconfirmed: boolean;
}

const leaderWatches = new WeakMap<ResourceScope, { entered: boolean; stop(): void }>();

/**
 * Impure: watch a scoped launch's leader until it is seen in its scope, which proves `systemd-run` started the
 * command. A leader that exits first leaves the launch unconfirmed for {@link settleResourceScope}.
 */
export function watchResourceScopeLeader(scope: ResourceScope, pid: number | undefined): void {
	if (pid === undefined) return;
	const marker = `/${scope.unit}\n`;
	const watch = { entered: false, stop: (): void => clearInterval(timer) };
	const check = (): void => {
		try {
			if (`${readFileSync(`/proc/${pid}/cgroup`, "utf8")}\n`.includes(marker)) {
				watch.entered = true;
				watch.stop();
			}
		} catch {
			watch.stop();
		}
	};
	const timer = setInterval(check, SCOPE_ENTRY_POLL_MS);
	timer.unref();
	leaderWatches.set(scope, watch);
	check();
}

function systemctl(scope: ResourceScope, args: ReadonlyArray<string>): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			scope.systemctl,
			["--user", ...args],
			{ env: scope.env, timeout: SETTLE_TIMEOUT_MS, encoding: "utf8" },
			(_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
		);
	});
}

function unitProperties(text: string): Map<string, string> {
	const props = new Map<string, string>();
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
	}
	return props;
}

function oomKills(controlGroup: string | undefined): number {
	if (controlGroup === undefined || controlGroup.length === 0) return 0;
	try {
		const match = /^oom_kill (\d+)$/mu.exec(readFileSync(`/sys/fs/cgroup${controlGroup}/memory.events`, "utf8"));
		return match === null ? 0 : Number(match[1]);
	} catch {
		return 0;
	}
}

/**
 * Pure: whether a launch that left no unit behind failed inside `systemd-run` before the command started: exit 1,
 * no stdout, and every stderr line one `systemd-run` writes when it cannot start a scope.
 */
export function scopeLaunchFailure(observed: {
	exitCode: number | null;
	stdoutBytes: number;
	stderr: string;
}): string | null {
	if (observed.exitCode !== 1 || observed.stdoutBytes > 0) return null;
	const lines = observed.stderr.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0 || !lines.every((line) => SYSTEMD_RUN_FAILURE.test(line.trim()))) return null;
	return lines.map((line) => line.trim()).join("; ");
}

const ACTIVE_STATES = new Set(["active", "activating", "deactivating", "reloading"]);

/**
 * Impure: after the command's leader exits, end what is left of its scope and read how it ended. A process the
 * command left running is ended with it, as a sandbox's own process namespace does. A failed unit is reset, so no
 * unit of the launch outlives it.
 */
export async function settleResourceScope(scope: ResourceScope): Promise<ResourceScopeSettlement> {
	const watch = leaderWatches.get(scope);
	watch?.stop();
	const show = ["show", scope.unit, "-p", "LoadState", "-p", "ActiveState", "-p", "Result", "-p", "ControlGroup"];
	let props = unitProperties(await systemctl(scope, show));
	let memoryExceeded = false;
	if (props.get("LoadState") === "not-found") {
		liveScopes.delete(scope.unit);
		return { memoryExceeded: false, launchUnconfirmed: watch?.entered !== true };
	}
	if (ACTIVE_STATES.has(props.get("ActiveState") ?? "")) {
		memoryExceeded = oomKills(props.get("ControlGroup")) > 0;
		await systemctl(scope, ["kill", "--signal=SIGKILL", scope.unit]);
		await systemctl(scope, ["stop", scope.unit]);
		props = unitProperties(await systemctl(scope, show));
	}
	if (props.get("Result") === "oom-kill") memoryExceeded = true;
	if (props.get("ActiveState") === "failed") await systemctl(scope, ["reset-failed", scope.unit]);
	liveScopes.delete(scope.unit);
	return { memoryExceeded, launchUnconfirmed: false };
}

/** A planned scope whose launch never spawned: nothing of it runs, so there is nothing to settle. */
export function forgetResourceScope(scope: ResourceScope): void {
	liveScopes.delete(scope.unit);
}

/** The line a command's result carries when its memory ceiling ended it. */
export function resourceLimitNote(scope: ResourceScope, settlement: ResourceScopeSettlement): string | null {
	if (!settlement.memoryExceeded) return null;
	return `[resource limits] memory ceiling ${scope.limits.memoryMiB ?? "?"} MiB (safety.resources.${scope.scope}.memoryMiB) reached; the kernel ended the command`;
}

/** The not-run message for a scope `systemd-run` could not start. */
export function scopeLaunchFailureMessage(scope: ResourceScope, failure: string): string {
	return `safety.resources.${scope.scope} is set but systemd-run could not start the command's scope (${failure}); the command was not run.`;
}

/**
 * Impure, synchronous: SIGKILL every scope this process started and has not settled. A cancelled worker calls it
 * beside its process-group kill, since a process the command moved to its own session is outside that group.
 */
export function killLiveResourceScopes(): void {
	if (liveScopes.size === 0) return;
	for (const [unit, { systemctl: binary, env }] of liveScopes) {
		spawnSync(binary, ["--user", "kill", "--signal=SIGKILL", unit], { env, timeout: 2000, stdio: "ignore" });
	}
	liveScopes.clear();
}

/** A dispatched worker's ceilings, from its sealed spec: every child it spawns through the exec seams gets them. */
export function configureWorkerResourceLimits(limits: ResourceLimits | undefined): void {
	workerLimits = hasResourceLimits(limits) ? limits : undefined;
}

/** What `doctor` and `version --sandbox` report: each limit's state, why one is not enforced, and no disk quota. */
export interface ResourceStatus {
	memory: ResourceLimitState["state"];
	tasks: ResourceLimitState["state"];
	cpu: ResourceLimitState["state"];
	reason: string | null;
	disk: "not enforced";
	main: ResourceLimits | null;
	workers: ResourceLimits | null;
}

/** Pure: the status for a capability and the configured ceilings. */
export function resourceStatus(
	capability: Pick<ResourceCapability, ResourceLimitKey>,
	configured: { main: ResourceLimits | undefined; workers: ResourceLimits | undefined },
): ResourceStatus {
	const reasons = [
		...new Set(
			RESOURCE_LIMIT_KEYS.map((key) => capability[key]).flatMap((state) =>
				state.state === "enforced" ? [] : [state.reason],
			),
		),
	];
	return {
		memory: capability.memoryMiB.state,
		tasks: capability.tasks.state,
		cpu: capability.cpuPercent.state,
		reason: reasons.length === 0 ? null : reasons.join("; "),
		disk: "not enforced",
		main: configured.main ?? null,
		workers: configured.workers ?? null,
	};
}

function limitsWords(limits: ResourceLimits | null): string {
	if (limits === null) return "none set";
	const words: string[] = [];
	if (limits.memoryMiB !== undefined) words.push(`memory ${limits.memoryMiB} MiB`);
	if (limits.tasks !== undefined) words.push(`tasks ${limits.tasks}`);
	if (limits.cpuPercent !== undefined) words.push(`cpu ${limits.cpuPercent}%`);
	return words.join(", ");
}

/** Impure: this host's resource status for the configured `safety.resources`, as doctor and `version --sandbox` give it. */
export function hostResourceStatus(resources: {
	main: ResourceLimitSettings;
	workers: ResourceLimitSettings;
}): ResourceStatus {
	return resourceStatus(resourceCapability(), {
		main: resourceLimitsFromSettings(resources.main),
		workers: resourceLimitsFromSettings(resources.workers),
	});
}

/** Pure: whether a configured ceiling would be refused here. */
export function resourceStatusRefuses(status: ResourceStatus): boolean {
	const states: Record<ResourceLimitKey, ResourceLimitState["state"]> = {
		memoryMiB: status.memory,
		tasks: status.tasks,
		cpuPercent: status.cpu,
	};
	return [status.main, status.workers].some(
		(limits) =>
			limits !== null && RESOURCE_LIMIT_KEYS.some((key) => limits[key] !== undefined && states[key] !== "enforced"),
	);
}

/** One line for doctor: what each ceiling does here, what is set, and what is never bounded. */
export function resourceStatusLine(status: ResourceStatus): string {
	const states = [
		["memory", status.memory],
		["tasks", status.tasks],
		["cpu", status.cpu],
	] as const;
	const enforced = states.filter(([, state]) => state === "enforced").map(([name]) => name);
	const parts =
		enforced.length === states.length
			? ["memory, tasks and cpu ceilings enforceable per command (systemd user scope)"]
			: [
					...(enforced.length > 0 ? [`${enforced.join(", ")} enforceable per command (systemd user scope)`] : []),
					`${states
						.filter(([, state]) => state !== "enforced")
						.map(([name, state]) => `${name} ${state}`)
						.join(", ")} (${status.reason ?? "no reason given"})`,
				];
	parts.push(`main: ${limitsWords(status.main)}`, `workers: ${limitsWords(status.workers)}`);
	if (resourceStatusRefuses(status)) parts.push("a set limit this host cannot enforce refuses its commands");
	parts.push("disk quota not enforced", "per-process limits not offered");
	return parts.join("; ");
}
