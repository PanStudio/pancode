// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export declare function sourceRoots(root: string): string[];
export declare function planSourcePack(root: string): { loose: string[]; packed: string[] };
export declare function readSourcePackMembers(packFile: string): string[];
