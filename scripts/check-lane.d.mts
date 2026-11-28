// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export declare function directImports(file: string, text: string): string[];
export declare function selectLaneTests(input: {
	changed: string[];
	added: string[];
	importsOf: Map<string, string[]>;
	lists: { coreTests: string[]; guiTests: string[]; packageTests: string[] };
}): { affected: string[]; unlisted: string[] };
export declare function formatOpenapi(text: string): { status: number | null; stdout: string; stderr: string };
