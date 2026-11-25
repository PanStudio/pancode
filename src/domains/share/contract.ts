// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainContract } from "../../core/domain-loader.js";
import type { PancodeShareArchive, ShareExportOptions, ShareImportOptions, ShareImportPlan } from "./archive.js";

export interface ShareContract extends DomainContract {
	writeArchive(outPath: string, options?: ShareExportOptions): PancodeShareArchive;
	planImport(filePath: string, options?: ShareImportOptions): ShareImportPlan;
	importArchive(filePath: string, options?: ShareImportOptions): ShareImportPlan;
}
