// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { BlockList, isIP } from "node:net";
import type { EgressPresetName } from "../types.js";

/** One exact origin: a canonical host (IPv6 without brackets) and a port. */
export interface EgressOrigin {
	readonly host: string;
	readonly port: number;
}

/**
 * Named exact host/port bundles an operator can grant by name. Exact hosts
 * only: a preset never matches a subdomain it does not list.
 */
const EGRESS_PRESETS: Readonly<Record<EgressPresetName, readonly string[]>> = {
	npm: ["registry.npmjs.org:443"],
	pypi: ["pypi.org:443", "files.pythonhosted.org:443"],
	github: [
		"github.com:443",
		"api.github.com:443",
		"codeload.github.com:443",
		"objects.githubusercontent.com:443",
		"raw.githubusercontent.com:443",
	],
	crates: ["crates.io:443", "index.crates.io:443", "static.crates.io:443"],
	go: ["proxy.golang.org:443", "sum.golang.org:443"],
};

export function originKey(origin: EgressOrigin): string {
	return `${isIP(origin.host) === 6 ? `[${origin.host}]` : origin.host}:${origin.port}`;
}

/**
 * Canonical host through the WHATWG host parser, so the forms a resolver would
 * read as an address (`2130706433`, `0x7f.1`, an uncompressed IPv6) compare as
 * the address they name, and a Unicode name compares as its punycode.
 */
function canonicalEgressHost(host: string): string | null {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare.length === 0 || /[\s/?#@\\%]/u.test(bare)) return null;
	try {
		const parsed = new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}/`).hostname;
		const unbracketed = parsed.startsWith("[") ? parsed.slice(1, -1) : parsed;
		const trimmed = unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
		return trimmed.length > 0 ? trimmed.toLowerCase() : null;
	} catch {
		return null;
	}
}

function validPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function egressOrigin(host: string, port: number): EgressOrigin | null {
	const canonical = canonicalEgressHost(host);
	return canonical !== null && validPort(port) ? { host: canonical, port } : null;
}

/** Parses one `host:port` allow entry (IPv6 in brackets). Returns a problem string when it is not one. */
export function parseEgressAllowEntry(entry: string): EgressOrigin | string {
	const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/u.exec(entry.trim());
	if (match === null) return "expected an exact host:port (IPv6 in brackets), no scheme, path or wildcard";
	const [, host = "", portText = ""] = match;
	if (host.includes("*")) return "wildcards are not allowed; list each exact host";
	const origin = egressOrigin(host, Number(portText));
	return origin ?? "not a valid host and port 1-65535";
}

/** The origins one caller may reach in a launch, fixed when the launch starts. */
export interface EgressGrants {
	readonly origins: ReadonlySet<string>;
	/** The origins among them the operator approved earlier this session, not in the settings. */
	readonly session?: ReadonlySet<string>;
}

export function egressGrants(
	allow: readonly string[],
	presets: readonly EgressPresetName[],
	extra: Iterable<string> = [],
): EgressGrants {
	const origins = new Set<string>();
	for (const entry of [...presets.flatMap((name) => EGRESS_PRESETS[name]), ...allow]) {
		const parsed = parseEgressAllowEntry(entry);
		if (typeof parsed !== "string") origins.add(originKey(parsed));
	}
	const session = new Set<string>();
	for (const key of extra) if (!origins.has(key)) session.add(key);
	for (const key of session) origins.add(key);
	return session.size > 0 ? { origins, session } : { origins };
}

// Addresses a granted name may never resolve to: loopback, private, link-local
// (cloud metadata included), shared, benchmarking, documentation, multicast and
// reserved. A literal address reaches one only through an allow entry naming it.
const DENIED = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	DENIED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 32],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) {
	DENIED.addSubnet(network, prefix, "ipv6");
}

function ipv6Groups(address: string): number[] | null {
	let text = address;
	const tail: number[] = [];
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
	if (v4?.[1] !== undefined) {
		const octets = v4[1].split(".").map(Number);
		if (octets.length !== 4 || octets.some((o) => !(o >= 0 && o <= 255))) return null;
		const [a = 0, b = 0, c = 0, d = 0] = octets;
		tail.push((a << 8) | b, (c << 8) | d);
		text = text.slice(0, -v4[1].length);
		if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string): number[] =>
		part.length === 0 ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
	const head = parse(halves[0] ?? "");
	const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const fill = 8 - head.length - rest.length - tail.length;
	if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
	const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
	return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(high: number, low: number): string {
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** The IPv4 address an IPv6 transition form carries: mapped, compatible, translated, NAT64 or 6to4. */
function embeddedIpv4(address: string): string | null {
	const g = ipv6Groups(address);
	if (g === null) return null;
	const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
	if (
		g0 === 0 &&
		g1 === 0 &&
		g2 === 0 &&
		g3 === 0 &&
		((g4 === 0 && (g5 === 0xffff || g5 === 0)) || (g4 === 0xffff && g5 === 0))
	)
		return v4FromGroups(g6, g7);
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4FromGroups(g6, g7);
	if (g0 === 0x2002) return v4FromGroups(g1, g2);
	return null;
}

/** True when a granted name must not reach this address. */
export function isDeniedEgressAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return DENIED.check(address, "ipv4") || address === "255.255.255.255";
	if (family !== 6) return true;
	if (DENIED.check(address, "ipv6")) return true;
	const embedded = embeddedIpv4(address);
	return embedded !== null && isDeniedEgressAddress(embedded);
}

/** The name check that runs before any lookup, so an ungranted name is never resolved. */
export function isGrantedEgressOrigin(grants: EgressGrants, origin: EgressOrigin): boolean {
	return grants.origins.has(originKey(origin));
}

export function isLiteralEgressHost(host: string): boolean {
	return isIP(host) !== 0;
}

export interface ResolvedAddress {
	readonly address: string;
	readonly family: number;
}

/**
 * Screens every answer of the one lookup made for a granted name. One denied
 * answer refuses the name, so a rebinding resolver cannot pair a public answer
 * with an internal one and win on a later dial.
 */
export function screenResolvedAddresses(
	answers: readonly ResolvedAddress[],
): { ok: true; address: ResolvedAddress } | { ok: false; reason: string } {
	const [first] = answers;
	if (first === undefined) return { ok: false, reason: "the name did not resolve" };
	const denied = answers.find((answer) => isDeniedEgressAddress(answer.address));
	if (denied !== undefined)
		return { ok: false, reason: `the name resolves to ${denied.address}, a local or private address` };
	return { ok: true, address: first };
}

/** Why a `safety.egress.upstreamProxy` value is not one, else null. */
export function upstreamProxyProblem(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "expected an http:// or https:// proxy URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "expected an http:// or https:// proxy URL";
	if (url.hostname.length === 0) return "the URL names no proxy host";
	if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "")
		return "a proxy URL takes no path, query or fragment";
	try {
		decodeURIComponent(url.username);
		decodeURIComponent(url.password);
	} catch {
		return "proxy URL credentials contain invalid percent-encoding";
	}
	return null;
}

/** The upstream proxy URL with any credentials replaced, for every place it is shown. */
export function redactedUpstreamProxy(value: string): string {
	try {
		const url = new URL(value);
		if (url.username === "" && url.password === "") return `${url.protocol}//${url.host}`;
		return `${url.protocol}//***@${url.host}`;
	} catch {
		return "(invalid proxy URL)";
	}
}
