// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { importShareArchive, planShareImport, writeShareArchive } from "./archive.js";
import type { ShareContract } from "./contract.js";

export function createShareBundle(_context: DomainContext): DomainBundle<ShareContract> {
	const extension: DomainExtension = {
		start() {
			return undefined;
		},
	};
	const contract: ShareContract = {
		writeArchive(outPath, options) {
			return writeShareArchive(outPath, options);
		},
		planImport(filePath, options) {
			return planShareImport(filePath, options);
		},
		importArchive(filePath, options) {
			return importShareArchive(filePath, options);
		},
	};
	return { extension, contract };
}
