// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export interface ReleaseVersionInput {
	version: unknown;
	changelog: unknown;
	releaseContext: boolean;
}

export declare function releaseVersionErrors(input: ReleaseVersionInput): string[];

export declare function readmeInstallVersion(input: { version: string; changelog: string }): string | null;
