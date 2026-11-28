// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { threadId } from "node:worker_threads";
import { relativePathEscapes } from "../../../../../src/core/path-containment.js";
import {
	describeResolution,
	findPinnedProgram,
	installPinnedProgram,
	installProgram,
	PINNED_PROGRAMS,
	type PinnedProgram,
	type ProgramFetcher,
	programStatus,
	programStatuses,
	programsRoot,
	removeProgram,
} from "../../../../../src/lib/programs/index.js";
import { AppProblem } from "../../services/problem.js";

/** Check the requested URL before invoking the fetcher (including injected fetchers). */
export function pinnedFetcher(pins: readonly PinnedProgram[], fetcher: ProgramFetcher): ProgramFetcher {
	const allowed = new Set(
		pins.flatMap((pin) => [
			...Object.values(pin.downloads).map((download) => download.url),
			...pin.documents.map((document) => document.url),
		]),
	);
	return async (url) => {
		if (!allowed.has(url)) throw new AppProblem("unsupported", "Download URL is outside the pinned tool registry.");
		return fetcher(url);
	};
}
export function programDownloader(network: typeof fetch): ProgramFetcher {
	return async (url: string): Promise<Buffer> => {
		// GitHub's pinned release URLs redirect to signed asset URLs. Hash verification
		// remains owned by installProgram; arbitrary entry URLs never reach this function.
		const response = await network(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
		if (!response.ok) throw new Error(`Pinned download returned HTTP ${response.status}.`);
		return Buffer.from(await response.arrayBuffer());
	};
}
function containedTool(id: string) {
	const root = resolve(programsRoot());
	const canonical = (path: string): string => {
		let parent = path;
		while (!existsSync(parent)) parent = dirname(parent);
		return resolve(realpathSync(parent), relative(parent, path));
	};
	if (relativePathEscapes(relative(canonical(root), canonical(resolve(root, id)))))
		throw new AppProblem("validation", "Program directory escapes the programs root.");
}
export function programsAdapter(options: { pins?: readonly PinnedProgram[]; fetcher?: ProgramFetcher } = {}) {
	const pins = options.pins ?? PINNED_PROGRAMS;
	const fetcher = pinnedFetcher(pins, options.fetcher ?? programDownloader(globalThis.fetch));
	const known = (id: string) => {
		const entry = pins.find((pin) => pin.id === id);
		if (!entry || !findPinnedProgram(id)) throw new AppProblem("not_found", "Unknown pinned tool.");
		containedTool(id);
		containedTool(`${id}/${entry.version}`);
		return entry;
	};
	return {
		list() {
			const statuses = options.pins ? pins.map(programStatus) : programStatuses();
			return {
				threadId,
				rows: statuses.map((status) => ({
					id: status.id,
					version: status.version,
					summary: pins.find((pin) => pin.id === status.id)?.summary ?? "",
					license: status.license,
					platform: status.platform,
					supported: status.supported,
					installed: status.installed,
					installDir: status.installDir,
					resolution: {
						source: status.resolution.source,
						binaryPath: status.resolution.binaryPath,
						version: status.resolution.version,
						vendoredPath: status.resolution.vendoredPath,
						pathCandidate: status.resolution.pathCandidate,
						description: describeResolution(status),
					},
				})),
			};
		},
		async install(id: string, force: boolean, onProgress: (message: string) => void) {
			const entry = known(id);
			const settings = { force, onProgress, fetch: fetcher };
			const result = options.pins ? await installPinnedProgram(entry, settings) : await installProgram(id, settings);
			if (!result.ok) {
				const problem = new AppProblem(
					"operation_failed",
					"Pinned tool installation failed. See the server log for details.",
				);
				console.error(`[pancode:gui] ${problem.problem.instance} ${result.message}`);
				throw problem;
			}
			return { id: result.id, message: result.message };
		},
		remove(id: string) {
			known(id);
			const result = removeProgram(id);
			if (!result.ok) throw new AppProblem("operation_failed", "Vendored tool removal failed.");
			return { id: result.id, message: result.message };
		},
	};
}
