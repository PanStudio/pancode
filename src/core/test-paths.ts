// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Path recognition shared by the merge gate and the finish contract. */

const TEST_DIR = /(?:^|\/)(?:[Tt]ests?|__tests__|specs?)\//u;
const DOCS_DIR = /(?:^|\/)docs?\//u;
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|swift|scala|exs?|php|c|cc|cpp|sh|bats)$/u;
const DOC_EXTENSION = /\.(?:md|mdx|markdown|rst|adoc|txt)$/iu;
const PROSE_EXTENSION = /\.(?:md|markdown|rst|adoc|mmd|txt)$/iu;
// A build or deploy tool reads these .txt files, so writing one is a change to check, not prose.
const BUILD_INPUT_TEXT =
	/(?:^|\/)(?:[^/]*(?:requirements|constraints)[^/]*\.txt|CMakeLists\.txt|runtime\.txt|requirements\/.*)$/iu;
const TEST_FILE_NAME =
	/\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs|rb|exs?)$|(?:^|\/)test_[^/]*\.py$|(?:Test|Tests|Spec)\.(?:java|kt|cs|swift|scala)$/u;

export function isTestFilePath(path: string): boolean {
	return TEST_FILE_NAME.test(path) || (TEST_DIR.test(path) && CODE_EXTENSION.test(path));
}

/**
 * True when removing `path` cannot break an import or the build: a test file,
 * anything under or naming a test directory, or documentation that is not code.
 * A bare `rm -r test` names the directory itself, so the path is judged with a
 * trailing slash.
 */
export function isNonSourcePath(path: string): boolean {
	const trimmed = path.replace(/\/+$/u, "");
	if (trimmed.length === 0) return false;
	if (isTestFilePath(trimmed) || TEST_DIR.test(`${trimmed}/`)) return true;
	if (CODE_EXTENSION.test(trimmed)) return false;
	return DOC_EXTENSION.test(trimmed) || DOCS_DIR.test(`${trimmed}/`);
}

/**
 * True when writing `path` leaves nothing to build or run: Markdown,
 * reStructuredText, AsciiDoc, Mermaid or plain-text source, robots.txt and
 * LICENSE.txt included. MDX stays out because it compiles, and so do the
 * `.txt` build inputs in {@link BUILD_INPUT_TEXT}.
 */
export function isProsePath(path: string): boolean {
	return PROSE_EXTENSION.test(path) && !BUILD_INPUT_TEXT.test(path);
}
