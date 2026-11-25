// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Install records this build does not accept. A plugin or extension state file
 * stays readable when one of its records is invalid: the reader leaves that
 * record out, keeps its bytes for the next write, and `pancode doctor --fix`
 * drops it. No older record shape is read into the current one.
 */
import { writeDiagnostic } from "../../core/diagnostics.js";

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

/** The `installed` object to write: invalid records keep their bytes unless the write replaced or removed them. */
export function withKeptInvalidRecords<T>(
	installed: Readonly<Record<string, T>>,
	invalid: ReadonlyArray<InvalidInstallRecord>,
): Record<string, unknown> {
	const kept = invalid.filter((entry) => !Object.hasOwn(installed, entry.id)).map((entry) => [entry.id, entry.raw]);
	return { ...Object.fromEntries(kept), ...installed };
}

const warned = new Set<string>();
let reportedAsRows = false;

/** Doctor names each invalid record in its own row, so its process prints no warning line for them. */
export function reportInvalidInstallRecordsAsRows(): void {
	reportedAsRows = true;
}

/** Names a state file's invalid records once per process; every later read of the same file stays quiet. */
export function warnInvalidInstallRecords(file: string, invalid: ReadonlyArray<InvalidInstallRecord>): void {
	if (invalid.length === 0 || reportedAsRows || warned.has(file)) return;
	warned.add(file);
	const ids = invalid.map((entry) => entry.id);
	const named = ids.length > 3 ? `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more` : ids.join(", ");
	writeDiagnostic(
		`warning: ${file} holds ${ids.length} install ${ids.length === 1 ? "record" : "records"} this build does not accept (${named}), so ${ids.length === 1 ? "that package is" : "those packages are"} not loaded; run \`pancode doctor\` for each reason and reinstall command, then \`pancode doctor --fix\` to drop them`,
	);
}
