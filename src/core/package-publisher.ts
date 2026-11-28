// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Publisher identity for installed packages. A package id names one package
 * per namespace, so an install from one publisher never silently replaces the
 * same id from another; the operator removes the first copy explicitly.
 */

/** Lowercase GitHub owner, `pancode` for first-party packs, or `local`. */
const PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/u;

const GITHUB_OWNER = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\//u;

/** The publisher an install writes when the caller names none: the GitHub owner of its source, else local. */
export function derivedPublisher(source: string): string {
	const owner = GITHUB_OWNER.exec(source)?.[1]?.toLowerCase();
	return owner && PUBLISHER_PATTERN.test(owner) ? owner : "local";
}

/** Validate a persisted publisher. */
export function readPublisher(value: unknown): string {
	if (typeof value !== "string" || !PUBLISHER_PATTERN.test(value))
		throw new Error("publisher must be a lowercase publisher name");
	return value;
}

/**
 * The refusal for installing `id` from `publisher` over a copy recorded with another publisher, in either scope.
 */
export function publisherCollision(
	id: string,
	publisher: string,
	installed: ReadonlyArray<{ scope: string; publisher?: string | undefined }>,
): string | undefined {
	const other = installed.find((copy) => copy.publisher !== undefined && copy.publisher !== publisher);
	if (!other) return undefined;
	return `hub_publisher_collision: ${id} is installed from ${other.publisher} (${other.scope}); remove it before installing ${id} from ${publisher}`;
}
