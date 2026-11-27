// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * HTTP for the catalog server, through Node's built-in `fetch`. Every URL a
 * request goes to, the first and each redirect hop, passes the host rule of
 * its source: `https` (or `http` when the source sets `allowHttp`), and the
 * source's own host or one in its `resourceHosts`. Redirects are followed by
 * hand, at most five. No credential is read or sent, and no proxy is used.
 */
import type { CkanSource } from "./parse.js";

export const MAX_REDIRECTS = 5;
const USER_AGENT = "pankit-catalog/0.1.0";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why `target` may not be fetched for `source`, or null when it may. Names the host and where to allow it. */
export function urlRefusal(target: URL, source: CkanSource, catalogFile: string): string | null {
	if (target.username !== "" || target.password !== "")
		return `${target.protocol}//${target.host} carries a user name or password, which the server never sends`;
	if (target.protocol === "http:") {
		if (!source.allowHttp)
			return `${target.host} is reached over plain http, which source ${source.id} does not allow; set allowHttp: true on source ${source.id} in ${catalogFile} only for a host you trust on plain HTTP`;
	} else if (target.protocol !== "https:") {
		return `${target.protocol} URLs are never fetched; only https (or http with allowHttp) are`;
	}
	// `host` carries a port only when it is not the scheme's default, so an entry without one allows the default port.
	if (target.host === new URL(source.url).host || source.resourceHosts.includes(target.host)) return null;
	return `host ${target.host} is not allowed for source ${source.id}; to allow it, add "${target.host}" to the resourceHosts of source ${source.id} in ${catalogFile}`;
}

export type Fetched =
	| { ok: true; response: Response; url: string; redirects: number }
	| { ok: false; error: string; refused: boolean };

/**
 * GET `url`, following at most `MAX_REDIRECTS` redirects by hand so each hop
 * passes `urlRefusal` before any request is made to it. A refused URL is never
 * requested. The caller owns the returned response's body.
 */
export async function fetchChecked(
	url: string,
	source: CkanSource,
	catalogFile: string,
	signal: AbortSignal,
	headers: Record<string, string>,
): Promise<Fetched> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { ok: false, error: `${JSON.stringify(url.slice(0, 200))} is not a URL`, refused: true };
	}
	for (let redirects = 0; ; redirects++) {
		const refusal = urlRefusal(target, source, catalogFile);
		if (refusal !== null)
			return { ok: false, error: redirects === 0 ? refusal : `a redirect was refused: ${refusal}`, refused: true };
		let response: Response;
		try {
			response = await fetch(target, {
				redirect: "manual",
				signal,
				headers: { "user-agent": USER_AGENT, ...headers },
			});
		} catch (error) {
			const cause = error instanceof Error && error.cause !== undefined ? `: ${message(error.cause)}` : "";
			return { ok: false, error: `request to ${target.host} failed: ${message(error)}${cause}`, refused: false };
		}
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || location === null)
			return { ok: true, response, url: target.href, redirects };
		await discard(response);
		if (redirects >= MAX_REDIRECTS)
			return { ok: false, error: `more than ${MAX_REDIRECTS} redirects from ${url}`, refused: false };
		try {
			target = new URL(location, target);
		} catch {
			return { ok: false, error: `a redirect from ${target.host} names no valid URL`, refused: false };
		}
	}
}

/** Drop a response body the server will not read. */
export async function discard(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The body is already closed or errored; nothing is left to release.
	}
}

/** A response body as text, refusing more than `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
	if (response.body === null) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.byteLength;
		if (total > maxBytes) {
			await discard(response);
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * An abort signal that fires `ms` after the last `touch`, for a stall timeout,
 * or once after `ms` when nothing touches it, for a request timeout. `fired`
 * tells a timeout from a cancelled call.
 */
export class Deadline {
	readonly #controller = new AbortController();
	readonly #ms: number;
	#timer: NodeJS.Timeout | undefined;
	fired = false;

	constructor(ms: number) {
		this.#ms = ms;
		this.touch();
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	touch(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.fired = true;
			this.#controller.abort(new Error(`no progress for ${this.#ms} ms`));
		}, this.#ms);
		this.#timer.unref();
	}

	clear(): void {
		clearTimeout(this.#timer);
	}
}

/** The largest CKAN action response the server reads. */
const MAX_ACTION_BYTES = 32 * 1024 * 1024;

/**
 * One CKAN action, `GET <url>/api/3/action/<action>?<params>`, bounded by
 * `timeoutMs` for the whole exchange. A failure says its HTTP status or the
 * error, never the response body.
 */
export async function ckanAction(
	source: CkanSource,
	action: string,
	params: Record<string, string>,
	options: { catalogFile: string; timeoutMs: number; signal: AbortSignal },
): Promise<{ ok: true; text: string } | { ok: false; error: string; status?: number }> {
	const deadline = new Deadline(options.timeoutMs);
	const signal = AbortSignal.any([options.signal, deadline.signal]);
	const url = `${source.url}/api/3/action/${action}?${new URLSearchParams(params).toString()}`;
	try {
		const fetched = await fetchChecked(url, source, options.catalogFile, signal, { accept: "application/json" });
		if (!fetched.ok) return { ok: false, error: timedOut(deadline, options, action) ?? fetched.error };
		const { response } = fetched;
		if (!response.ok) {
			await discard(response);
			return {
				ok: false,
				status: response.status,
				error: `${action} answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
			};
		}
		let text: string | null;
		try {
			text = await readCapped(response, MAX_ACTION_BYTES);
		} catch (error) {
			return { ok: false, error: timedOut(deadline, options, action) ?? `${action} failed: ${message(error)}` };
		}
		if (text === null) return { ok: false, error: `${action} answered with more than ${MAX_ACTION_BYTES} bytes` };
		return { ok: true, text };
	} finally {
		deadline.clear();
	}
}

function timedOut(deadline: Deadline, options: { timeoutMs: number; signal: AbortSignal }, action: string) {
	if (options.signal.aborted) return `${action} was cancelled`;
	if (deadline.fired) return `${action} timed out after ${options.timeoutMs / 1000} seconds`;
	return null;
}
