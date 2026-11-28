// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { delimiter, join } from "node:path";
import { programVersionDir, statOrNull, vendoredBinaryCandidates } from "./paths.js";
import { currentProgramPlatform, findPinnedProgram, findPinnedProgramByBinary, PINNED_PROGRAMS } from "./registry.js";
import { installedProgramVersions } from "./remove.js";
import type { PinnedProgram, ProgramPathCandidate, ProgramResolution, ProgramStatus } from "./types.js";
import { probeBinaryVersion, satisfiesMinimum } from "./version.js";

/**
 * The shared resolution ladder: PATH, then the vendored pin, then nothing.
 *
 * PATH comes first because a tool the operator installed themselves is the one
 * they maintain, and PanCode downloading a second copy of a program already on the
 * machine is a surprise. It only wins when its version clears the registry's
 * floor, because the alternative is PanCode driving a surface that release does not
 * have and reporting the resulting failure as a bug in the feature.
 *
 * Nothing here downloads, spawns a server, or writes to disk. It is safe on the
 * interactive startup path and inside doctor, both of which promise to create
 * nothing.
 */

/** First executable named `name` on PATH, or null. */
export function findExecutableOnPath(name: string): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const full = join(dir, candidate);
			const stat = statOrNull(full);
			if (stat?.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) return full;
		}
	}
	return null;
}

/**
 * Resolve one executable name through the ladder.
 *
 * A name that is not in the registry gets a plain PATH lookup: there is no pin
 * to compare against and nothing vendored to fall back to, so the answer is
 * whatever PATH says.
 */
export function resolveProgramBinary(name: string): ProgramResolution {
	const entry = findPinnedProgramByBinary(name) ?? findPinnedProgram(name);
	if (entry === null) {
		const found = findExecutableOnPath(name);
		return {
			source: found === null ? "none" : "path",
			binaryPath: found,
			version: null,
			entry: null,
			pathCandidate: found === null ? null : { path: found, version: null, satisfiesMinimum: true },
			vendoredPath: null,
		};
	}
	// An entry asked for by tool id resolves its primary binary; asked for by
	// binary name it resolves that binary, so `ya` does not silently become `yazi`.
	const binary = entry.binaries.includes(name) ? name : entry.primaryBinary;
	return resolveEntryBinary(entry, binary);
}

/** The first vendored copy of `binary` at this pin, this process's own before the operator's; null when none is. */
function findVendoredBinary(id: string, version: string, binary: string): string | null {
	return vendoredBinaryCandidates(id, version, binary).find((path) => statOrNull(path)?.isFile() === true) ?? null;
}

/** The ladder for a known registry row and one of its binaries. */
function resolveEntryBinary(entry: PinnedProgram, binary: string): ProgramResolution {
	const pathCandidate = probePathCandidate(entry, binary);
	const vendoredPath = findVendoredBinary(entry.id, entry.version, binary);

	if (pathCandidate?.satisfiesMinimum) {
		return {
			source: "path",
			binaryPath: pathCandidate.path,
			version: pathCandidate.version,
			entry,
			pathCandidate,
			vendoredPath,
		};
	}
	if (vendoredPath !== null) {
		return {
			source: "vendored",
			binaryPath: vendoredPath,
			version: entry.version,
			entry,
			pathCandidate,
			vendoredPath,
		};
	}
	return { source: "none", binaryPath: null, version: null, entry, pathCandidate, vendoredPath: null };
}

/**
 * The vendored pin of a registry tool and nothing else: no PATH lookup, no
 * version probe. This is what PanCode runs when the tool is part of PanCode itself
 * rather than something it borrows from the operator, which is the case for
 * herdr hosting PanCode's own private panes: an operator's herdr is their
 * program, at their version, with their config, and hosting on it would break
 * the isolation the private host exists for. Null when the pin is not installed.
 */
export function resolveVendoredBinary(id: string): { binaryPath: string; version: string } | null {
	const entry = findPinnedProgram(id);
	if (entry === null) return null;
	const path = findVendoredBinary(entry.id, entry.version, entry.primaryBinary);
	return path !== null ? { binaryPath: path, version: entry.version } : null;
}

/**
 * One binary of a row at its pin and nothing else: no PATH lookup, no version probe. A program an extension
 * declares resolves only here, so a same-named program on PATH never runs in place of the bytes the operator approved.
 */
export function resolvePinnedEntryBinary(entry: PinnedProgram, binary: string): ProgramResolution {
	const vendoredPath = findVendoredBinary(entry.id, entry.version, binary);
	return {
		source: vendoredPath === null ? "none" : "vendored",
		binaryPath: vendoredPath,
		version: vendoredPath === null ? null : entry.version,
		entry,
		pathCandidate: null,
		vendoredPath,
	};
}

/** Whether this platform has a pinned build of `id` that this home has not installed, the gap its install command closes. */
export function pinnedProgramMissing(id: string): boolean {
	const entry = findPinnedProgram(id);
	const platform = currentProgramPlatform();
	if (entry === null || platform === null || entry.downloads[platform] === undefined) return false;
	return resolveVendoredBinary(id) === null;
}

/** Per-entry state for the CLI and doctor. */
export function programStatus(entry: PinnedProgram): ProgramStatus {
	const platform = currentProgramPlatform();
	const supported = platform !== null && entry.downloads[platform] !== undefined;
	const resolution = resolveEntryBinary(entry, entry.primaryBinary);
	return {
		id: entry.id,
		version: entry.version,
		license: entry.license,
		platform,
		supported,
		installed: resolution.vendoredPath !== null,
		installDir: programVersionDir(entry.id, entry.version),
		resolution,
	};
}

/** Per-entry state for every row, in registry order. */
export function programStatuses(): ProgramStatus[] {
	return PINNED_PROGRAMS.map((entry) => programStatus(entry));
}

/** The one command that fixes a tool PanCode cannot resolve. */
export function installRemedy(id: string): string {
	return `pancode programs install ${id}`;
}

/**
 * What a rejected PATH copy was, and which floor it failed. Null when there is
 * no PATH copy or when the one there was accepted.
 *
 * The floors are deliberately conservative: they sit at the pin for herdr and
 * yazi because PanCode drives socket and plugin surfaces verified against only
 * that release. That is a defensible choice and a costly one, since it rejects
 * binaries an operator installed themselves and that mostly work. The cost is
 * only payable if the rejection is legible, so every renderer of a rejection
 * names the path, the version found, and the floor it missed, and never reports
 * a rejected copy as an absent one.
 */
export function describeFloorRejection(status: ProgramStatus): string | null {
	const candidate = status.resolution.pathCandidate;
	if (candidate === null || candidate.satisfiesMinimum) return null;
	const floor = status.resolution.entry?.minimumVersion ?? status.version;
	const found = candidate.version === null ? "an unreadable version" : candidate.version;
	return `PATH copy ${candidate.path} is ${found}, below the ${floor} floor`;
}

/**
 * One sentence describing where a tool resolved and how its version compares to
 * the pin. Shared by `pancode programs status` and the doctor rows so the two
 * cannot drift into describing the same machine differently.
 */
export function describeResolution(status: ProgramStatus): string {
	const { resolution } = status;
	const rejection = describeFloorRejection(status);
	if (resolution.source === "path") {
		const version = resolution.version ?? "unreadable version";
		return `PATH ${resolution.binaryPath} (${version}, pin ${status.version})`;
	}
	if (resolution.source === "vendored") {
		// The remedy is deliberately absent here. The rejection cost the operator
		// nothing: PanCode has a copy at the pin and is running it, and printing an
		// install command that would change nothing is its own kind of dishonesty.
		const rejected = rejection === null ? "" : `; ${rejection}, so PanCode runs the vendored copy`;
		return `vendored ${resolution.binaryPath} (${status.version})${rejected}`;
	}
	if (!status.supported) {
		const platform = status.platform ?? `${process.platform}-${process.arch}`;
		// No remedy either: there is no asset to install on this machine, so the
		// rejection is the whole story and naming a command would be a dead end.
		const rejected = rejection === null ? "" : `; ${rejection}`;
		return `not installed and no pinned asset for this platform (${platform})${rejected}`;
	}
	// A PanCode upgrade that moves a pin leaves the old vendored copy behind. That is
	// an update to run, not a tool that was never installed.
	const superseded = installedProgramVersions(status.id).filter((version) => version !== status.version);
	if (superseded.length > 0) {
		const rejected = rejection === null ? "" : `; ${rejection}`;
		return `vendored ${superseded.join(", ")} is superseded by the ${status.version} pin${rejected} (update with \`${installRemedy(status.id)}\`)`;
	}
	if (rejection !== null) {
		return `${rejection}, and nothing is vendored (install with \`${installRemedy(status.id)}\`)`;
	}
	return `not found (install with \`${installRemedy(status.id)}\`)`;
}

function probePathCandidate(entry: PinnedProgram, binary: string): ProgramPathCandidate | null {
	const found = findExecutableOnPath(binary);
	if (found === null) return null;
	// The floor is a property of the tool, and only the primary binary is asked
	// for its version, so a secondary binary inherits the primary's verdict from
	// the same install root rather than being probed with flags it may not have.
	const probeTarget = binary === entry.primaryBinary ? found : (findExecutableOnPath(entry.primaryBinary) ?? found);
	const version = probeBinaryVersion(probeTarget, entry.versionArgs);
	return { path: found, version, satisfiesMinimum: satisfiesMinimum(version, entry.minimumVersion) };
}
