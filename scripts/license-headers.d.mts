// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export declare const LICENSE_ID: string;
export declare const COPYRIGHT_TEXT: string;
export declare const ADAPTED_MIT: Map<string, string>;
export declare const EXCLUDED: Array<{ test: (path: string) => boolean; reason: string }>;
export declare function filesInScope(base?: string): string[];
export declare function expectedHeader(path: string): string;
export declare function headerOffset(text: string): number;
export declare function licenseHeaderSpan(text: string): [number, number] | undefined;
export declare function stripLicenseHeader(text: string): string;
export declare function withLicenseHeader(path: string, text: string): string;
export declare function headerProblems(base?: string): { files: string[]; problems: string[] };
export declare function packagedHeaderBytes(
	packageRoot: string,
	files: Array<{ path: string }>,
	options?: { sourcePack?: string },
): Promise<{ discounts: Map<string, number>; unpacked: number; tarball: number }>;
