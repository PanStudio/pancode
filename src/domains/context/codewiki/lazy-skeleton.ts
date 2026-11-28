// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * `codeSkeleton` behind a dynamic import, so a caller outside context can hold it from the context barrel without
 * loading the parser: tree-sitter and its grammars load on the first skeleton asked for, never at boot.
 */
export async function lazyCodeSkeleton(path: string, text: string): Promise<{ text: string; bodies: number } | null> {
	const { codeSkeleton } = await import("./tree-sitter.js");
	return codeSkeleton(path, text);
}
