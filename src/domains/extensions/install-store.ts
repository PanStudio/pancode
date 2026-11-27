// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The install-state store extensions and plugins share. Each kind keeps its own
 * `state.json` under its own managed directory and its own record validator;
 * this module owns how those files are located, read, written and recovered.
 *
 * A state file stays readable when one of its records is invalid: the reader
 * leaves that record out, keeps its bytes for the next write, and
 * `pancode doctor --fix` drops it. No older record shape is read into the
 * current one.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { isRecord } from "../../core/type-guards.js";
import { pancodeConfigDir, pancodeConfigPath } from "../../core/xdg.js";
import { extensionContentDigest } from "./integrity.js";

export type InstallScope = "user" | "project";

export interface InstallState<R> {
	version: 1;
	disabled: string[];
	installed: Record<string, R>;
}

/** Where one package kind keeps its install state and how its records are read. */
export interface InstallStateLayout<R> {
	/** The package kind as messages name it. */
	noun: "extension" | "plugin";
	/** The managed directory under the config root and under the project's `.pancode/`. */
	dir: "extensions" | "plugins";
	baseDir(scope: InstallScope, cwd: string): string;
	/** Throws the reason one stored record is refused. */
	readRecord(id: string, raw: unknown): R;
	/** The `<kind>:<id>` reference `pancode hub install` takes to reinstall a refused record. */
	packRef(id: string, raw: unknown): string;
	/** When set, every `disabled` entry must be an id this kind can install. */
	isId?(id: string): boolean;
}

export interface InvalidInstallRecord {
	id: string;
	/** The `<kind>:<id>` reference `pancode hub install` takes to reinstall the package. */
	pack: string;
	/** Why the record is refused, relative to `installed.<id>`. */
	reason: string;
	/** The stored value, written back unchanged until a repair or reinstall replaces it. */
	raw: unknown;
}

/** One `installed.<id>` record a doctor repair dropped. */
export interface DroppedInstallRecord {
	id: string;
	pack: string;
	reason: string;
	/** The package directory removed with the record, because its bytes were the record's. */
	removed?: string;
	/** Where the package directory was moved, because its bytes could not be matched to the record. */
	preserved?: string;
	/** A package path left in place, because it is a link. */
	kept?: string;
}

/** What a doctor read or repair found in one state file. */
export interface InstallRecordReport {
	path: string;
	/** Records the reader accepts. */
	valid: number;
	invalid: ReadonlyArray<Omit<InvalidInstallRecord, "raw">>;
	/** Set only by a repair. */
	dropped?: ReadonlyArray<DroppedInstallRecord>;
}

/**
 * `bytes` is what a later write compares against before it replaces the file:
 * absent when no file exists, else the exact text read.
 */
export type InstallStateRead<R> =
	| { status: "absent"; state: InstallState<R>; invalid: InvalidInstallRecord[]; bytes?: undefined }
	| { status: "valid"; state: InstallState<R>; invalid: InvalidInstallRecord[]; bytes: string }
	| { status: "corrupt"; state: InstallState<R>; message: string; bytes?: string };

export function installStatePath<R>(layout: InstallStateLayout<R>, scope: InstallScope, cwd: string): string {
	return path.join(layout.baseDir(scope, cwd), "state.json");
}

/**
 * Reject redirects beneath the operator-selected config or project root: a
 * project link into user scope, or any link below the boundary, would carry
 * package bytes and install state to another trust domain.
 */
export function assertManagedBase<R>(layout: InstallStateLayout<R>, scope: InstallScope, cwd: string): void {
	const boundary =
		scope === "user" ? path.resolve(pancodeConfigPath()) : pancodeProjectRoot(cwd, path.join(layout.dir, "state.json"));
	const base = layout.baseDir(scope, cwd);
	let cursor = boundary;
	for (const part of path.relative(boundary, base).split(path.sep)) {
		cursor = path.join(cursor, part);
		try {
			const stat = lstatSync(cursor);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw new Error(`${layout.noun} managed path must be a directory without symbolic links: ${cursor}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

/** A hidden sibling of `target` no other operation can collide with. */
export function uniqueSibling(target: string, purpose: string): string {
	return path.join(
		path.dirname(target),
		`.${path.basename(target)}.${purpose}-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
}

export function emptyInstallState<R>(): InstallState<R> {
	return { version: 1, disabled: [], installed: {} };
}

/** The file's text, or undefined when nothing is at the path. Throws for anything but a plain file. */
function stateBytes<R>(layout: InstallStateLayout<R>, file: string): string | undefined {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new Error(`${layout.noun} state must be a regular unlinked file: ${file}`);
	return readFileSync(file, "utf8");
}

/** A file that cannot be read is corrupt; an invalid record is left out and named in `invalid`. */
export function readInstallState<R>(
	layout: InstallStateLayout<R>,
	scope: InstallScope,
	cwd: string,
): InstallStateRead<R> {
	const file = installStatePath(layout, scope, cwd);
	let bytes: string | undefined;
	try {
		assertManagedBase(layout, scope, cwd);
		bytes = stateBytes(layout, file);
		if (bytes === undefined) return { status: "absent", state: emptyInstallState(), invalid: [] };
		const parsed = JSON.parse(bytes) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1) throw new Error(`${layout.noun} state must be a version 1 object`);
		const disabled = parsed.disabled;
		if (!Array.isArray(disabled) || !disabled.every((id) => typeof id === "string" && (layout.isId?.(id) ?? true)))
			throw new Error(
				`${layout.noun} state.disabled must be an array of ${layout.isId ? `${layout.noun} ids` : "strings"}`,
			);
		if (!isRecord(parsed.installed)) throw new Error(`${layout.noun} state.installed must be an object`);
		const installed: Record<string, R> = {};
		const invalid: InvalidInstallRecord[] = [];
		for (const [id, raw] of Object.entries(parsed.installed)) {
			try {
				installed[id] = layout.readRecord(id, raw);
			} catch (error) {
				invalid.push({
					id,
					pack: layout.packRef(id, raw),
					reason: error instanceof Error ? error.message : String(error),
					raw,
				});
			}
		}
		warnInvalidInstallRecords(file, invalid);
		return { status: "valid", state: { version: 1, disabled: [...(disabled as string[])], installed }, invalid, bytes };
	} catch (error) {
		return {
			status: "corrupt",
			state: emptyInstallState(),
			message: error instanceof Error ? error.message : String(error),
			...(bytes !== undefined ? { bytes } : {}),
		};
	}
}

/** Throws unless the managed base is unredirected and the state file still holds `expected`, the bytes the caller read. */
export function assertUnchangedInstallState<R>(
	layout: InstallStateLayout<R>,
	scope: InstallScope,
	cwd: string,
	expected: string | undefined,
): void {
	assertManagedBase(layout, scope, cwd);
	if (stateBytes(layout, installStatePath(layout, scope, cwd)) !== expected)
		throw new Error(`${layout.noun} install state changed during the operation; retry after reviewing concurrent edits`);
}

/**
 * Replace the state file only while it still holds `expected`, the bytes the
 * caller read, so a concurrent edit is refused instead of overwritten.
 * Records named in `invalid` keep their stored bytes unless `state` replaced them.
 */
export function writeInstallState<R>(
	layout: InstallStateLayout<R>,
	scope: InstallScope,
	cwd: string,
	state: InstallState<R>,
	expected: string | undefined,
	invalid: ReadonlyArray<InvalidInstallRecord>,
): void {
	assertUnchangedInstallState(layout, scope, cwd, expected);
	// A writer creates the user config root as PanCode owns it (mode 0700) before its first write beneath it.
	if (scope === "user") pancodeConfigDir();
	const kept = invalid
		.filter((entry) => !Object.hasOwn(state.installed, entry.id))
		.map((entry) => [entry.id, entry.raw]);
	const written = { ...state, installed: { ...Object.fromEntries(kept), ...state.installed } };
	safeResourceWrite(installStatePath(layout, scope, cwd), `${JSON.stringify(written, null, 2)}\n`, {
		mode: 0o600,
		beforeRename: () => assertUnchangedInstallState(layout, scope, cwd, expected),
	});
}

/** Doctor's read of one scope's install records, or null when that scope has no state file. Throws when the file is unreadable. */
export function auditInstallRecords<R>(
	layout: InstallStateLayout<R>,
	scope: InstallScope,
	cwd: string,
): InstallRecordReport | null {
	const result = readInstallState(layout, scope, cwd);
	if (result.status === "absent") return null;
	if (result.status === "corrupt") throw new Error(result.message);
	return {
		path: installStatePath(layout, scope, cwd),
		valid: Object.keys(result.state.installed).length,
		invalid: result.invalid.map(({ id, pack, reason }) => ({ id, pack, reason })),
	};
}

/**
 * Whether a held package copy must stay as a recovery copy. It is removed only
 * when its bytes still match what was recorded, so edits made while it was held survive.
 */
export function retainRecovery(backup: string, recordedDigest: string | undefined): boolean {
	try {
		if (!recordedDigest || extensionContentDigest(backup) !== recordedDigest) return true;
		rmSync(backup, { recursive: true, force: true });
		return false;
	} catch {
		// Cleanup failure does not undo a committed lifecycle operation, and unreadable bytes are kept.
		return true;
	}
}

const warned = new Set<string>();
let reportedAsRows = false;

/** Doctor names each invalid record in its own row, so its process prints no warning line for them. */
export function reportInvalidInstallRecordsAsRows(): void {
	reportedAsRows = true;
}

/** Names a state file's invalid records once per process; every later read of the same file stays quiet. */
function warnInvalidInstallRecords(file: string, invalid: ReadonlyArray<InvalidInstallRecord>): void {
	if (invalid.length === 0 || reportedAsRows || warned.has(file)) return;
	warned.add(file);
	const ids = invalid.map((entry) => entry.id);
	const named = ids.length > 3 ? `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more` : ids.join(", ");
	writeDiagnostic(
		`warning: ${file} holds ${ids.length} install ${ids.length === 1 ? "record" : "records"} this build does not accept (${named}), so ${ids.length === 1 ? "that package is" : "those packages are"} not loaded; run \`pancode doctor\` for each reason and reinstall command, then \`pancode doctor --fix\` to drop them`,
	);
}
