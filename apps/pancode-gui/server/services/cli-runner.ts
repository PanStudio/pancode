// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type CliCommand, commandPlan } from "../cli-commands.js";
import { runPancodeCommand, stopPancodeCommand } from "../process-policy.js";
import { AppProblem } from "./problem.js";

/** Closed-set classifier for `pancode arena|research` exit 2 when its pack is absent, disabled, or failed to load. */
export function packProblem(pack: "arena" | "research", stderr: string): AppProblem | null {
	const named = `The ${pack} extension (extension:${pack})`;
	if (stderr.includes(`pancode ${pack}: extension:${pack} is not installed;`))
		return new AppProblem(
			"unsupported",
			`${named} is not installed. Run pancode hub install extension:${pack} to install it.`,
		);
	if (stderr.includes(`pancode ${pack}: extension:${pack} is disabled;`))
		return new AppProblem("unsupported", `${named} is disabled. Run pancode extensions enable ${pack} to enable it.`);
	if (stderr.includes(`pancode ${pack}: extension:${pack} is installed but does not load;`))
		return new AppProblem(
			"unsupported",
			`${named} is installed but did not load. Run pancode extensions list to see why.`,
		);
	return null;
}

export class CliCanceled extends Error {}
export class CliRunner {
	private jobs = new Map<AbortController, Promise<unknown>>();
	private closed = false;
	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly timeoutMs = 60_000,
	) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
			throw new TypeError("CLI timeout must be 1–60000 ms.");
	}
	get activeCount() {
		return this.jobs.size;
	}
	run(command: CliCommand, cwd: string, signal?: AbortSignal): Promise<unknown> {
		const plan = commandPlan(command, cwd);
		if (this.closed || this.jobs.size >= 4)
			return Promise.reject(
				new AppProblem("unavailable", "PanCode is running too many commands or is stopping. Retry shortly."),
			);
		if (signal?.aborted) return Promise.reject(new CliCanceled());
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const job = this.execute(command, cwd, plan.output, controller.signal).finally(() => {
			signal?.removeEventListener("abort", abort);
			this.jobs.delete(controller);
		});
		this.jobs.set(controller, job);
		return job;
	}
	private async execute(
		command: CliCommand,
		cwd: string,
		output: "json" | "exit",
		signal: AbortSignal,
	): Promise<unknown> {
		const { child, birthToken } = await runPancodeCommand(command, cwd, this.env);
		return new Promise((resolve, reject) => {
			let failure: Error | undefined;
			let stdoutBytes = 0,
				stderrBytes = 0;
			const chunks: Buffer[] = [];
			// Retained only for closed-set classification (never echoed raw to callers).
			let stderrHead = "";
			let kill: NodeJS.Timeout | undefined;
			const stop = (error: Error) => {
				failure ??= error;
				if (child.pid && child.exitCode === null && child.signalCode === null)
					stopPancodeCommand(child, birthToken, "SIGTERM");
				kill ??= setTimeout(() => {
					if (child.pid && child.exitCode === null && child.signalCode === null)
						stopPancodeCommand(child, birthToken, "SIGKILL");
				}, 1000);
			};
			const abort = () => stop(new CliCanceled());
			const timer = setTimeout(
				() => stop(new AppProblem("operation_failed", "The pancode command exceeded its time limit.")),
				this.timeoutMs,
			);
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > 8 * 1024 * 1024)
					stop(new AppProblem("operation_failed", "The pancode command printed more than 8 MiB."));
				else if (!failure && output !== "exit") chunks.push(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrHead.length < 4096) stderrHead += chunk.toString("utf8").slice(0, 4096 - stderrHead.length);
				if (stderrBytes > 256 * 1024)
					stop(new AppProblem("operation_failed", "The pancode command printed more than 256 KiB of errors."));
			});
			child.on("error", () => {
				failure ??= new AppProblem("operation_failed", "The pancode command could not start.");
			});
			child.on("close", (code, termination) => {
				clearTimeout(timer);
				if (kill) clearTimeout(kill);
				signal.removeEventListener("abort", abort);
				if (failure) {
					reject(failure);
					return;
				}
				// A completed fleet preflight exits 1 for negative evidence and still emits its JSON record; so does a
				// research report whose recomputed grades disagree with the journal.
				const recordOnOne = command.kind === "nodes.check" || command.kind === "research.report";
				if (code !== 0 && !(recordOnOne && code === 1)) {
					const verb = command.kind.split(".")[0];
					if (code === 2 && (verb === "arena" || verb === "research")) {
						const pack = packProblem(verb, stderrHead);
						if (pack) {
							reject(pack);
							return;
						}
					}
					reject(
						new AppProblem(
							"operation_failed",
							`The pancode command exited with ${code === null ? `signal ${termination ?? "unknown"}` : `exit code ${code}`}.`,
						),
					);
					return;
				}
				if (output === "exit") {
					resolve({ exitCode: 0 });
					return;
				}
				try {
					const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
					resolve(JSON.parse(decoded));
				} catch {
					reject(new AppProblem("operation_failed", "The pancode command returned invalid UTF-8 or JSON."));
				}
			});
			if (signal.aborted) abort();
		});
	}
	async close() {
		this.closed = true;
		for (const controller of this.jobs.keys()) controller.abort();
		await Promise.allSettled(this.jobs.values());
	}
}
