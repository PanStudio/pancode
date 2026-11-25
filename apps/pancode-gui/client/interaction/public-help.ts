// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import catalog from "../../../../site/public-docs.json" with { type: "json" };

/** Never turn an arbitrary local path into a public URL. */
export const PUBLIC_HELP = "https://pancode.dev/docs.html";

const GUIDE_PATH_RE = /^guide\/([a-z0-9-]+)\.md$/u;

/**
 * The guides the website publishes, read from site/public-docs.json, the list
 * site/build.mjs renders, so a guide added there is linkable here without a
 * second edit. Its `README.md` entry is the docs index, PUBLIC_HELP itself.
 */
export const PUBLIC_GUIDES: readonly string[] = catalog.flatMap(({ path }) => GUIDE_PATH_RE.exec(path)?.[1] ?? []);

/** The published page for guide `name`, or the docs index when the website does not publish it. */
export function publicGuideUrl(name: string): string {
	return PUBLIC_GUIDES.includes(name) ? `https://pancode.dev/docs/guide/${name}.html` : PUBLIC_HELP;
}
