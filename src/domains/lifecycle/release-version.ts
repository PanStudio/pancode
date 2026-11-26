// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PACKAGE_NAME } from "../../core/package-root.js";

/** Strict SemVer at the registry boundary; metadata never becomes a shell argument. */
export function parseReleaseVersion(value: unknown): { core: number[]; pre: string[] } | null {
	if (typeof value !== "string" || value.length > 128) return null;
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
			value,
		);
	if (!match) return null;
	const core = match.slice(1, 4).map(Number);
	const pre = match[4]?.split(".") ?? [];
	if (
		core.some((n) => !Number.isSafeInteger(n)) ||
		pre.some((s) => /^\d+$/.test(s) && s.length > 1 && s.startsWith("0"))
	)
		return null;
	return { core, pre };
}

export function compareReleaseVersions(left: string, right: string): number | null {
	const a = parseReleaseVersion(left);
	const b = parseReleaseVersion(right);
	if (!a || !b) return null;
	for (let i = 0; i < 3; i++) {
		const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		const l = a.pre[i];
		const r = b.pre[i];
		if (l === r) continue;
		if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
		const ln = /^\d+$/.test(l);
		const rn = /^\d+$/.test(r);
		if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : l.length < r.length ? -1 : 1;
		if (ln !== rn) return ln ? -1 : 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

/**
 * The registry the package manager itself installs from, so the version a
 * check announces is the one `npm install` fetches on a mirror (#436).
 */
function registryBase(): string {
	const configured = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
	try {
		const url = new URL(configured ?? "");
		if (url.protocol === "https:" || url.protocol === "http:") return url.href.replace(/\/+$/u, "");
	} catch {
		// Unset or malformed: the public registry.
	}
	return "https://registry.npmjs.org";
}

/**
 * Where a channel's version is read. An installer install runs a bundle, so it
 * asks the channel file the release writes once that bundle is downloadable;
 * every other install asks the registry its package manager installs from.
 */
export type ReleaseSource = "bundle" | "registry";

/** The channel files scripts/install.sh reads, so a check announces the version the installer then fetches. */
function channelBase(): string {
	const mirror = process.env.PANCODE_RELEASE_MIRROR?.trim().replace(/\/+$/u, "");
	return mirror ? `${mirror}/channel` : "https://pancode.dev/channel";
}

/** The URL a channel's version is read from; a lookup that got no version names it. */
export function releaseVersionUrl(channel: string, source: ReleaseSource): string {
	return source === "bundle"
		? `${channelBase()}/${channel}`
		: `${registryBase()}/${PACKAGE_NAME.replace("/", "%2f")}/${channel}`;
}

/** A tag's version, null when the tag is not published (404), and undefined when no answer came. */
async function readTagVersion(
	channel: string,
	signal: AbortSignal | undefined,
	source: ReleaseSource,
): Promise<string | null | undefined> {
	if (!["latest", "beta"].includes(channel)) return null;
	try {
		const timeout = AbortSignal.timeout(2500);
		const bundle = source === "bundle";
		const response = await fetch(releaseVersionUrl(channel, source), {
			headers: { Accept: bundle ? "text/plain" : "application/json" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (response.status === 404) return null;
		if (!response.ok) return undefined;
		const version = bundle
			? (await response.text()).split("\n", 1)[0]?.trim()
			: ((await response.json()) as { version?: unknown }).version;
		return parseReleaseVersion(version) ? (version as string) : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchTagVersion(
	channel: string,
	signal?: AbortSignal,
	source: ReleaseSource = "registry",
): Promise<string | null> {
	return (await readTagVersion(channel, signal, source)) ?? null;
}

/** A channel also follows more stable channels. */
export function releaseChannelTags(channel: string): string[] {
	return channel === "latest" ? ["latest"] : channel === "beta" ? ["latest", "beta"] : [];
}

export async function fetchReleaseVersion(
	channel: string,
	signal?: AbortSignal,
	source: ReleaseSource = "registry",
): Promise<string | null> {
	const versions = await Promise.all(releaseChannelTags(channel).map((tag) => readTagVersion(tag, signal, source)));
	// A tag that did not answer may name the newest version, so the channel's version is unknown.
	if (versions.includes(undefined)) return null;
	let newest: string | null = null;
	for (const version of versions)
		if (typeof version === "string" && (newest === null || compareReleaseVersions(version, newest) === 1))
			newest = version;
	return newest;
}
