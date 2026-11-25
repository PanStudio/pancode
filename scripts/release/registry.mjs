// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The npm registry every release read and write names explicitly, so an npm config that points at a mirror never
 * receives a publish. `PANCODE_RELEASE_REGISTRY` may name a loopback registry for a local rehearsal, never in CI.
 */

/** The public npm registry. */
export const REGISTRY = "https://registry.npmjs.org/";

/**
 * The registry for this process: `REGISTRY`, or `PANCODE_RELEASE_REGISTRY` when it is `http://127.0.0.1:<port>/`
 * or `http://localhost:<port>/` and `GITHUB_ACTIONS` is not `true`. Any other value throws. An empty value is unset.
 */
export function releaseRegistry(env = process.env) {
	const override = env.PANCODE_RELEASE_REGISTRY;
	if (override === undefined || override === "") return REGISTRY;
	if (env.GITHUB_ACTIONS === "true")
		throw new Error("PANCODE_RELEASE_REGISTRY is for local rehearsals; unset it in GitHub Actions.");
	let url;
	try {
		url = new URL(override);
	} catch {
		throw new Error(`PANCODE_RELEASE_REGISTRY is not a URL: ${override}`);
	}
	const loopback =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
		/^\d+$/u.test(url.port) &&
		url.pathname === "/" &&
		!url.search &&
		!url.hash &&
		!url.username &&
		!url.password;
	if (!loopback)
		throw new Error(
			`PANCODE_RELEASE_REGISTRY must be http://127.0.0.1:<port>/ or http://localhost:<port>/, got ${override}`,
		);
	return url.href;
}

/** `["--registry", <url>]` for every `npm publish` and `npm dist-tag` the release runs. */
export function registryArgs(env = process.env) {
	return ["--registry", releaseRegistry(env)];
}
