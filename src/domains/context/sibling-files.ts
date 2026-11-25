// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export interface SiblingContextFile {
	source: string;
	path: string;
	content: string;
}

export interface LoadSiblingContextFilesOptions {
	homeDir?: string;
	includeGlobal?: boolean;
}
