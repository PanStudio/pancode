// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	importShareArchive,
	type PancodeShareArchive,
	planShareImport,
	type ShareExportOptions,
	type ShareImportOptions,
	type ShareImportPlan,
	writeShareArchive,
} from "./archive.js";

/** The archive operations every host wires into `/archive`; share has no lifecycle of its own. */
export interface ShareArchiver {
	writeArchive(outPath: string, options?: ShareExportOptions): PancodeShareArchive;
	planImport(filePath: string, options?: ShareImportOptions): ShareImportPlan;
	importArchive(filePath: string, options?: ShareImportOptions): ShareImportPlan;
}

export const shareArchiver: ShareArchiver = {
	writeArchive: (outPath, options) => writeShareArchive(outPath, options),
	planImport: (filePath, options) => planShareImport(filePath, options),
	importArchive: (filePath, options) => importShareArchive(filePath, options),
};
