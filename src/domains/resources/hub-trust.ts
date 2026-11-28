// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The verified remote hub index. `refreshRemoteIndex` fetches the three
 * release assets the hub-index workflow publishes, verifies the key
 * certificate against the root keys this build ships with and the index
 * statement against the certificate, and only then replaces the kept copy in
 * `<stateDir>/hub-index/` and the sequences in `<stateDir>/hub-trust.json`. A
 * refused or unreachable refresh leaves both as they were, so the last
 * verified index and its revocations keep applying.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readSettings } from "../../core/config.js";
import { sha256Hex } from "../../core/hash.js";
import { type HubRevocation, parseHubRevocations } from "../../core/hub-revocations.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { parseHubIndexRows } from "../plugins/catalog.js";
import { HUB_ROOT_PUBLIC_KEYS } from "./hub-keys.js";
import {
	type HubKeyCertificate,
	type HubRefusalReason,
	verifyIndexStatement,
	verifyKeyCertificate,
} from "./hub-signature.js";
import type { HubPackageEntry } from "./hub-types.js";

export const HUB_CERTIFICATE_ASSET = "signing.json";
export const HUB_ENVELOPE_ASSET = "index.envelope.json";
export const HUB_INDEX_ASSET = "index.yaml";
const HUB_ASSET_MAX_BYTES = 4 * 1024 * 1024;
const HUB_ASSET_TIMEOUT_MS = 20_000;
/** `hub install`, `update` and `list` refresh first when the kept index is older than this. */
const HUB_INDEX_REFRESH_AGE_MS = 6 * 60 * 60 * 1000;

export type HubTrustRefusalReason = HubRefusalReason | "sequence-reused" | "unreachable" | "bad-url" | "off";

export interface HubTrustState {
	version: 1;
	indexSequence: number;
	certificateSequence: number;
	keyId: string;
	commit: string;
	generatedAt: string;
	expires: string;
	verifiedAt: string;
	indexSha256: string;
	revoked: HubRevocation[];
}

export interface HubTrustRefusalRecord {
	at: string;
	url: string;
	reason: HubTrustRefusalReason;
	message: string;
}

export type HubAssetFetch = (url: URL, limits: { maxBytes: number; timeoutMs: number }) => Promise<Uint8Array>;

export interface HubTrustOptions {
	/** Base URL of the three assets; defaults to `integrations.hub.index`. */
	url?: string;
	rootKeys?: ReadonlyArray<string>;
	now?: () => Date;
	fetch?: HubAssetFetch;
	stateDir?: string;
}

export type HubRefreshResult =
	| { ok: true; changed: boolean; state: HubTrustState }
	| { ok: false; reason: HubTrustRefusalReason; message: string; kept: HubTrustState | undefined };

function stateDirOf(options: { stateDir?: string }): string {
	return options.stateDir ?? pancodeStateDir();
}

export function hubTrustStatePath(stateDir?: string): string {
	return path.join(stateDir ?? pancodeStateDir(), "hub-trust.json");
}

export function hubIndexDir(stateDir?: string): string {
	return path.join(stateDir ?? pancodeStateDir(), "hub-index");
}

function refusalPath(stateDir: string): string {
	return path.join(hubIndexDir(stateDir), "last-refusal.json");
}

/** The configured base URL, "" when the remote index is off. */
export function configuredHubIndexUrl(): string {
	try {
		return readSettings().integrations.hub.index;
	} catch {
		return "";
	}
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** The base URL as a directory URL, or why it cannot be used. */
function checkHubIndexUrl(value: string): URL | string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return `not a URL: ${value}`;
	}
	if (url.username || url.password) return "the URL must not carry credentials";
	if (url.protocol === "http:" && !LOOPBACK.has(url.hostname))
		return "http:// is accepted only for 127.0.0.1, [::1] or localhost";
	if (!["https:", "http:", "file:"].includes(url.protocol)) return `unsupported scheme ${url.protocol}`;
	if (url.search || url.hash) return "the URL must not carry a query or fragment";
	if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
	return url;
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, name: string): Promise<Buffer> {
	if (body === null) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	let total = 0;
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`${name} is larger than ${maxBytes} bytes`);
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}

/** The default reader: a capped HTTPS (or loopback HTTP) GET, or a capped local file read. */
const defaultHubAssetFetch: HubAssetFetch = async (url, limits) => {
	if (url.protocol === "file:") {
		const file = fileURLToPath(url);
		if (statSync(file).size > limits.maxBytes) throw new Error(`${url.href} is larger than ${limits.maxBytes} bytes`);
		return readFileSync(file);
	}
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(limits.timeoutMs) });
	const final = new URL(response.url || url.href);
	if (final.protocol !== "https:" && !(final.protocol === "http:" && LOOPBACK.has(final.hostname)))
		throw new Error(`${url.href} redirected to ${final.protocol}//${final.host}`);
	if (!response.ok) throw new Error(`${url.href} answered HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > limits.maxBytes) throw new Error(`${url.href} is larger than ${limits.maxBytes} bytes`);
	return readCapped(response.body, limits.maxBytes, url.href);
};

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function isTrustState(value: unknown): value is HubTrustState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	return (
		state.version === 1 &&
		Number.isSafeInteger(state.indexSequence) &&
		Number.isSafeInteger(state.certificateSequence) &&
		typeof state.keyId === "string" &&
		typeof state.commit === "string" &&
		COMMIT.test(state.commit) &&
		typeof state.generatedAt === "string" &&
		typeof state.expires === "string" &&
		typeof state.verifiedAt === "string" &&
		typeof state.indexSha256 === "string" &&
		SHA256.test(state.indexSha256) &&
		Array.isArray(state.revoked)
	);
}

/** The kept verification, or undefined when none was ever accepted (or the file is damaged). */
export function readHubTrustState(stateDir?: string): HubTrustState | undefined {
	const file = hubTrustStatePath(stateDir);
	try {
		if (!existsSync(file)) return undefined;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isTrustState(parsed)) return undefined;
		return { ...parsed, revoked: parseHubRevocations(parsed.revoked) };
	} catch {
		return undefined;
	}
}

export function readHubTrustRefusal(stateDir?: string): HubTrustRefusalRecord | undefined {
	try {
		const file = refusalPath(stateDir ?? pancodeStateDir());
		if (!existsSync(file)) return undefined;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as HubTrustRefusalRecord;
		return typeof parsed.reason === "string" && typeof parsed.at === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The certified key that signed the statement, as `verifyIndexStatement` picked it. */
function signingKeyId(envelope: Uint8Array, certificate: HubKeyCertificate, now: Date): string {
	try {
		const parsed = JSON.parse(Buffer.from(envelope).toString("utf8")) as { signatures?: { keyId?: unknown }[] };
		const revoked = new Set(certificate.revoked);
		for (const signature of parsed.signatures ?? []) {
			const key = certificate.keys.find((item) => item.keyId === signature.keyId);
			if (!key || revoked.has(key.keyId)) continue;
			const at = now.getTime();
			if (at >= Date.parse(key.notBefore) && at < Date.parse(key.notAfter)) return key.keyId;
		}
	} catch {
		// Unreachable after verification; the caller still has a valid statement.
	}
	return "unknown";
}

function refuse(
	stateDir: string,
	url: string,
	reason: HubTrustRefusalReason,
	message: string,
	now: Date,
): HubRefreshResult {
	const record: HubTrustRefusalRecord = { at: now.toISOString(), url, reason, message };
	try {
		safeResourceWrite(refusalPath(stateDir), `${JSON.stringify(record, null, 2)}\n`);
	} catch {
		// Status loses the note; the kept index is untouched either way.
	}
	return { ok: false, reason, message, kept: readHubTrustState(stateDir) };
}

/** Fetch, verify and keep the remote index. Never touches the kept copy unless every check passes. */
export async function refreshRemoteIndex(options: HubTrustOptions = {}): Promise<HubRefreshResult> {
	const stateDir = stateDirOf(options);
	const now = (options.now ?? (() => new Date()))();
	const base = options.url ?? configuredHubIndexUrl();
	if (base === "")
		return refuse(stateDir, base, "off", "integrations.hub.index is blank, so the remote index is off", now);
	const url = checkHubIndexUrl(base);
	if (typeof url === "string") return refuse(stateDir, base, "bad-url", `integrations.hub.index ${url}`, now);
	const rootKeys = options.rootKeys ?? HUB_ROOT_PUBLIC_KEYS;
	if (rootKeys.length === 0)
		return refuse(stateDir, url.href, "no-root-key", "this build has no hub root key, so no index verifies", now);
	const fetchAsset = options.fetch ?? defaultHubAssetFetch;
	const limits = { maxBytes: HUB_ASSET_MAX_BYTES, timeoutMs: HUB_ASSET_TIMEOUT_MS };
	const assets: Uint8Array[] = [];
	for (const name of [HUB_CERTIFICATE_ASSET, HUB_ENVELOPE_ASSET, HUB_INDEX_ASSET]) {
		try {
			const bytes = await fetchAsset(new URL(name, url), limits);
			if (bytes.byteLength > HUB_ASSET_MAX_BYTES) throw new Error(`${name} is larger than ${HUB_ASSET_MAX_BYTES} bytes`);
			assets.push(bytes);
		} catch (err) {
			return refuse(
				stateDir,
				url.href,
				"unreachable",
				`could not read ${name}: ${err instanceof Error ? err.message : String(err)}`,
				now,
			);
		}
	}
	const [certificateBytes, envelopeBytes, indexBytes] = assets as [Uint8Array, Uint8Array, Uint8Array];
	const kept = readHubTrustState(stateDir);
	const certificate = verifyKeyCertificate({
		envelope: certificateBytes,
		rootKeys,
		minSequence: kept?.certificateSequence ?? 0,
	});
	if (!certificate.ok) return refuse(stateDir, url.href, certificate.reason, certificate.message, now);
	const statement = verifyIndexStatement({
		envelope: envelopeBytes,
		indexBytes,
		certificate: certificate.value,
		now,
		minSequence: kept?.indexSequence ?? 0,
	});
	if (!statement.ok) return refuse(stateDir, url.href, statement.reason, statement.message, now);
	if (kept && statement.value.sequence === kept.indexSequence && statement.value.indexSha256 !== kept.indexSha256)
		return refuse(
			stateDir,
			url.href,
			"sequence-reused",
			`index sequence ${kept.indexSequence} is already kept with sha256 ${kept.indexSha256}; ${statement.value.indexSha256} reuses it`,
			now,
		);
	let revoked: HubRevocation[];
	try {
		const parsed = parseYaml(Buffer.from(indexBytes).toString("utf8")) as unknown;
		const diagnostics: string[] = [];
		parseHubIndexRows(parsed, HUB_INDEX_ASSET, diagnostics, { mode: "remote" });
		revoked = parseHubRevocations((parsed as { revoked?: unknown }).revoked);
	} catch (err) {
		return refuse(
			stateDir,
			url.href,
			"malformed",
			`index.yaml is not a hub index: ${err instanceof Error ? err.message : String(err)}`,
			now,
		);
	}
	const state: HubTrustState = {
		version: 1,
		indexSequence: statement.value.sequence,
		certificateSequence: certificate.value.sequence,
		keyId: signingKeyId(envelopeBytes, certificate.value, now),
		commit: statement.value.commit,
		generatedAt: statement.value.generatedAt,
		expires: statement.value.expires,
		verifiedAt: now.toISOString(),
		indexSha256: statement.value.indexSha256,
		revoked,
	};
	const changed = kept?.indexSha256 !== state.indexSha256 || kept.certificateSequence !== state.certificateSequence;
	const dir = hubIndexDir(stateDir);
	// The kept index is written before the state that names its digest; a reader checks the digest, so a crash
	// between the two offers no remote rows rather than unverified ones.
	safeResourceWrite(path.join(dir, HUB_CERTIFICATE_ASSET), certificateBytes);
	safeResourceWrite(path.join(dir, HUB_ENVELOPE_ASSET), envelopeBytes);
	safeResourceWrite(path.join(dir, HUB_INDEX_ASSET), indexBytes);
	safeResourceWrite(hubTrustStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
	return { ok: true, changed, state };
}

/** Whether `hub install`, `update` or `list` should refresh first. A refusal also counts as a recent attempt. */
function hubIndexNeedsRefresh(options: { now?: () => Date; stateDir?: string } = {}): boolean {
	const now = (options.now ?? (() => new Date()))().getTime();
	const stateDir = stateDirOf(options);
	const last = Math.max(
		Date.parse(readHubTrustState(stateDir)?.verifiedAt ?? "") || 0,
		Date.parse(readHubTrustRefusal(stateDir)?.at ?? "") || 0,
	);
	return now - last >= HUB_INDEX_REFRESH_AGE_MS;
}

/** One line naming the reason and the kept sequence. */
export function describeRefusal(result: Extract<HubRefreshResult, { ok: false }>): string {
	const kept = result.kept ? `keeping sequence ${result.kept.indexSequence}` : "no verified index kept";
	return `The hub index not refreshed (${result.reason}): ${result.message}; ${kept}`;
}

/**
 * Refresh when the kept index is stale. Returns the line to print on refusal; the command continues either way. A
 * build with no root key cannot verify a remote index, so it never tries: the bundled index is its expected state,
 * which `hub status` reports and `hub refresh` explains.
 */
export async function autoRefreshRemoteIndex(options: HubTrustOptions = {}): Promise<string | undefined> {
	const url = options.url ?? configuredHubIndexUrl();
	if (url === "" || (options.rootKeys ?? HUB_ROOT_PUBLIC_KEYS).length === 0 || !hubIndexNeedsRefresh(options))
		return undefined;
	const result = await refreshRemoteIndex({ ...options, url });
	return result.ok ? undefined : describeRefusal(result);
}

export type RemoteIndexStatus = "off" | "none" | "expired" | "damaged" | "current";

/**
 * The rows of the kept remote index, offered only while the index is on, verified, intact and unexpired.
 * Relative first-party rows resolve against `packsRoot` (the installed package's `hub/`).
 */
export function remoteIndexRows(
	diagnostics: string[],
	options: { now?: () => Date; stateDir?: string; packsRoot: string; url?: string },
): { rows: HubPackageEntry[]; status: RemoteIndexStatus; state?: HubTrustState } {
	if ((options.url ?? configuredHubIndexUrl()) === "") return { rows: [], status: "off" };
	const stateDir = stateDirOf(options);
	const state = readHubTrustState(stateDir);
	if (!state) return { rows: [], status: "none" };
	const now = (options.now ?? (() => new Date()))().getTime();
	if (!(now < Date.parse(state.expires))) {
		diagnostics.push(
			`The hub remote index expired at ${state.expires}; run pancode hub refresh. Installed packs keep loading.`,
		);
		return { rows: [], status: "expired", state };
	}
	const file = path.join(hubIndexDir(stateDir), HUB_INDEX_ASSET);
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		return { rows: [], status: "damaged", state };
	}
	if (sha256Hex(bytes) !== state.indexSha256) {
		diagnostics.push(`The hub remote index ${file} does not match its verified digest; run pancode hub refresh`);
		return { rows: [], status: "damaged", state };
	}
	try {
		const rows = parseHubIndexRows(parseYaml(bytes.toString("utf8")), file, diagnostics, {
			mode: "remote",
			packsRoot: options.packsRoot,
		});
		return { rows, status: "current", state };
	} catch (err) {
		diagnostics.push(`The hub remote index unreadable: ${err instanceof Error ? err.message : String(err)}`);
		return { rows: [], status: "damaged", state };
	}
}
