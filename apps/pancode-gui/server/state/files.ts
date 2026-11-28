// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ownerIdentity, ownerState, relativePathEscapes } from "../pancode/http-shims.js";
import { AppProblem } from "../services/problem.js";

/** A bakery claim. `host`, `pidNs` and `bootId` are absent on claims from before they were recorded. */
type Owner = {
	id: string;
	pid: number;
	birth: string | null;
	choosing: boolean;
	ticket: number;
	host?: string;
	pidNs?: string | null;
	bootId?: string | null;
};
function owner(value: unknown): value is Owner {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.choosing === "boolean" &&
		Number.isSafeInteger(row.ticket) &&
		typeof row.ticket === "number" &&
		row.ticket >= 0 &&
		Number.isInteger(row.pid) &&
		typeof row.pid === "number" &&
		row.pid > 0 &&
		(typeof row.birth === "string" || row.birth === null) &&
		(row.host === undefined || typeof row.host === "string") &&
		(row.pidNs === undefined || row.pidNs === null || typeof row.pidNs === "string") &&
		(row.bootId === undefined || row.bootId === null || typeof row.bootId === "string")
	);
}
/**
 * Whether a recorded owner has provably exited, by the engine's rule: another host or a pid namespace not visible here
 * is never judged by a local pid, so a peer sharing the state root from a container keeps its claim.
 */
export function ownerDead(owner: {
	pid: number;
	birth: string | null;
	host?: string;
	pidNs?: string | null;
	bootId?: string | null;
}) {
	return ownerState({ ...owner, host: owner.host ?? null, birthToken: owner.birth }) === "gone";
}
export class AppFiles {
	constructor(private readonly state: string) {}
	/** The state directory itself: no project claims it, so user-level reads run here when no workspace is open. */
	async neutral() {
		await mkdir(this.state, { recursive: true });
		return realpath(this.state);
	}
	private async directory() {
		await mkdir(this.state, { recursive: true });
		const state = await realpath(this.state),
			path = join(state, "gui");
		await mkdir(path, { recursive: true });
		const root = await realpath(path),
			part = relative(state, root);
		if (relativePathEscapes(part))
			throw new AppProblem("validation", "Application state directory escapes its configured root.");
		return root;
	}
	async read(name: "workspaces" | "children"): Promise<unknown> {
		const root = await this.directory();
		try {
			const file = await realpath(join(root, `${name}.json`)),
				part = relative(root, file);
			if (relativePathEscapes(part)) throw new AppProblem("validation", "Web state file escapes its directory.");
			return JSON.parse(await readFile(file, "utf8")) as unknown;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			if (error instanceof AppProblem) throw error;
			throw new AppProblem("unavailable", "Web state file cannot be read.");
		}
	}
	async update<T>(
		name: "workspaces" | "children",
		change: (current: unknown) => { value: unknown; result: T },
	): Promise<T> {
		const root = await this.directory(),
			lockDirectory = join(root, `${name}.locks`);
		await mkdir(lockDirectory, { recursive: true });
		if ((await realpath(lockDirectory)) !== lockDirectory)
			throw new AppProblem("validation", "Web lock directory must not be a symlink.");
		const { host, birthToken, pidNs, bootId } = ownerIdentity();
		const token: Owner = {
			id: randomUUID(),
			pid: process.pid,
			birth: birthToken,
			choosing: true,
			ticket: 0,
			host,
			pidNs,
			bootId,
		};
		const candidate = join(lockDirectory, `${token.id}.json`),
			staging = join(lockDirectory, `.${token.id}.tmp`);
		const publish = async () => {
			await writeFile(staging, JSON.stringify(token), { mode: 0o600 });
			await rename(staging, candidate);
		};
		const peers = async () => {
			const result: Owner[] = [];
			for (const file of await readdir(lockDirectory)) {
				if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
				let value: unknown;
				try {
					value = JSON.parse(await readFile(join(lockDirectory, file), "utf8"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw new AppProblem("unavailable", "Web state lock cannot be read.");
				}
				if (!owner(value)) throw new AppProblem("unavailable", "Web state lock is invalid.");
				// Each contender has a unique filename, never reused. Dead-owner cleanup
				// cannot unlink a new owner's claim (unlike replacing one shared lock file).
				if (ownerDead(value)) {
					await unlink(join(lockDirectory, file)).catch(() => undefined);
					continue;
				}
				result.push(value);
			}
			return result;
		};
		try {
			// Lamport bakery admission: publish choosing before reading tickets, then
			// wait for every earlier (ticket,id). Atomic renames expose whole records.
			await publish();
			token.ticket = Math.max(0, ...(await peers()).map((row) => row.ticket)) + 1;
			if (!Number.isSafeInteger(token.ticket)) throw new AppProblem("unavailable", "Web state ticket limit reached.");
			token.choosing = false;
			await publish();
			const deadline = Date.now() + 5000;
			while (
				(await peers()).some(
					(row) =>
						row.id !== token.id &&
						(row.choosing || row.ticket < token.ticket || (row.ticket === token.ticket && row.id < token.id)),
				)
			) {
				if (Date.now() >= deadline) throw new AppProblem("unavailable", "Web state is busy; retry shortly.");
				await setTimeout(10);
			}
			const changed = change(await this.read(name)),
				temporary = join(root, `.${token.id}.json`);
			try {
				await writeFile(temporary, JSON.stringify(changed.value), { mode: 0o600, flag: "wx" });
				await rename(temporary, join(root, `${name}.json`));
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
			return changed.result;
		} finally {
			await unlink(candidate).catch(() => undefined);
			await unlink(staging).catch(() => undefined);
		}
	}
}
