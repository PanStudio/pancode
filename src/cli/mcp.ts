// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { escapeTerminalControls } from "../core/terminal-controls.js";
import { isMcpResourceCapability, mcpToolName } from "../core/tool-names.js";
import { mcpToolActionClass } from "../domains/gateway/mcp/action-classes.js";
import type { McpClient, McpServerInfo } from "../domains/gateway/mcp/client.js";
import type {
	McpServerEntryScript,
	McpSkillApprovalStatus,
	McpSkillEntry,
	McpSurface,
	McpSurfaceStatus,
	McpToolPathArguments,
	ResolvedMcpServer,
} from "../domains/gateway/mcp/index.js";
import {
	approveMcpSkill,
	approveMcpSurface,
	boundedMcpSkillText,
	currentMcpSkillApproval,
	currentMcpSurfaceApproval,
	findMcpSkill,
	getMcpSkill,
	grantMcpBuiltinNetwork,
	judgeMcpSkillApproval,
	judgeMcpSurface,
	MCP_TRUST_ACTION_CLASSES,
	type McpTrustActionClass,
	type McpTrustOptions,
	mcpBuiltinTrustRefusal,
	mcpCatalogDigest,
	mcpCredentialRoutes,
	mcpSkillApprovalsFor,
	mcpSkillDisplayNames,
	mcpSkillRelativePath,
	mcpSkillsSettings,
	mcpSurfaceRemedy,
	mcpSurfaceRemedyFor,
	readMcpTrustState,
	resolveMcpServers,
	revokeMcpBuiltinNetwork,
	revokeMcpSkill,
	trustMcpServer,
	untrustMcpServer,
} from "../domains/gateway/mcp/index.js";
import {
	type McpResourceCount,
	mcpCatalogStale,
	mcpPromptsStale,
	readMcpServerCatalog,
} from "../domains/gateway/mcp/metadata-cache.js";
import { canonicalProjectRoot } from "../domains/gateway/mcp/trust.js";
import type { McpCapabilitySource } from "../tools/gateway/mcp-capability-types.js";
import { isMcpPromptCommandName } from "../tools/gateway/mcp-resources.js";
import type { RegistryVerdict } from "../tools/registry-contract.js";
import { mcpEditOutput, mcpLoginOutput, mcpLogoutOutput } from "./mcp-credentials.js";
import { printError } from "./shared.js";

const HELP = `pancode mcp <command>

Commands:
  pancode mcp list [--refresh] [--json]
  pancode mcp add <id> [--scope user|project] --url <url> [--header <Name>=<key>]... [--json]
  pancode mcp add <id> [--scope user|project] -- <command> [args...]
  pancode mcp remove <id> [--scope user|project] [--json]
  pancode mcp login <id> [--client-secret] [--json]
  pancode mcp logout <id> [--json]
  pancode mcp test <id> [--call <tool> [--args <json>]]... [--json]
  pancode mcp trust <id> [--action-class <class>] [--network] [--json]
  pancode mcp trust <id> --surface [--hash <sha256>] [--json]
  pancode mcp trust <id> --skill <name|uri> [--hash <manifest digest>] [--json]
  pancode mcp untrust <id> [--json]
  pancode mcp untrust <id> --skill <name|uri> [--json]

Action classes: ${MCP_TRUST_ACTION_CLASSES.join(", ")}

Remote servers:
  A declaration with url instead of command is reached over Streamable HTTP:
  https, or http on localhost. headers maps a header name to the key of a
  credential, never to its value. login stores each header's full value
  (for example "Bearer <token>") in PanCode's credential store, bound to the
  url's origin; a value is never sent to any other origin, even by a trusted
  declaration that names the same key, and a redirect to another origin is
  never followed. Typing is hidden at a terminal; otherwise login reads one
  line per header from stdin, in header-name order. trust prints each route
  as "sends credential <key> as <Header> to <origin>". A fleet worker reaches
  a remote server only with the network grant (trust --network, or
  network: true on a user declaration). logout removes the server's stored
  values for its origin. add writes the user mcp.yaml by default, or the
  project's with --scope project, and refuses a file that would not load.

OAuth sign-in:
  A remote server that declares no headers and answers 401 with a Bearer
  challenge reads as needs-auth until login signs in to it with OAuth 2.1:
  PanCode reads its protected resource metadata and authorization server
  metadata, registers itself with that server when it allows (or uses the
  client an oauth block names), and opens the sign-in in a browser with PKCE
  S256 and the server's resource indicator. The browser returns to
  http://127.0.0.1:33418/callback (oauth.redirectPort moves it); without a
  local browser login prints the URL and takes the URL the browser landed on,
  pasted at the terminal. A response from another issuer is refused before
  its code is used. The token is stored in the credential store for that
  server, issuer and resource, sent only as Authorization: Bearer within the
  resource, and renewed with its refresh token when it expires; a session or
  worker never starts a sign-in. A server that asks for more scope (403
  insufficient_scope) reads as needs-auth, and the next login asks for it too;
  scope the last login already asked for is not asked for again. An optional
  oauth block on the declaration sets issuer and clientId for a client
  registered with that authorization server (login --client-secret stores its
  secret for that issuer), scopes to request with the server's challenge, and
  redirectPort. logout removes the server's sign-in and the dynamic client
  registration it used, unless another server's sign-in still uses it.

Path arguments:
  A declaration may add toolPathArguments: per tool, a map from a top-level
  argument name to read or write. A call's value for each is resolved against
  the server's launch cwd as a builtin read or write resolves its path, and
  judged as that read or write would be: by the path policy and, in a worker,
  by the run's read scope and write roots. A declared argument the call leaves
  out passes, one that is not a string is refused, and an undeclared argument
  is never read. A write argument on a tool classed read is a declaration
  error. This judges the paths a call names; it does not confine what a server
  process running outside a sandbox then reads or writes.

JSON responses (--json):
  list: {servers: [...], diagnostics: [...], trustDiagnostics: [...]}
    Each server includes its declaration, trust {status, actionClass, reason?},
    entry (project servers: the project files its trust binds, [] when none),
    network, networkSource?, cached tools with per-tool actionClass, and
    instructions? the server wrote, from its catalog (at most 2 KiB).
    network is true when the server holds the worker network grant
    described under trust; networkSource says whether the trust file (project,
    plugin and builtin servers) or the user declaration granted it. --refresh lists
    trusted servers live and updates their catalogs; untrusted declarations
    are never launched. Each server it reached carries status {status, reason?,
    remedy?}: connected, failed, or needs-auth (a remote server that refused
    its credentials or lacks one) with the pancode mcp login command. A diagnostic with severity "warning" is advisory.
    A server with scope builtin ships with PanCode: it is trusted by
    authorship, its tools and their classes come from the policy this PanCode
    ships (catalog "shipped", builtin {version, title, environment}), and its
    surface is approved only while it serves that policy, which reinstalling or
    rebuilding restores. environment names the variables it is started with
    from PanCode's own environment; values are never shown. A user declaration with its id overrides it, with a
    warning; a project or plugin declaration with its id is shadowed. trust
    --network records its network grant and untrust removes that grant; any
    other trust refuses it.
    Each trusted server also carries surface {status, digest, approvedDigest,
    reason?, remedy?}: whether the tool surface it serves is approved (see
    trust --surface). Without --refresh no server is launched, so digest is
    null and status says only whether an approval is recorded; with it a
    changed surface reads as changed.
  test: {ok, server: {id, scope, trust, network, networkSource?}, protocolVersion, serverInfo,
    instructions?, tools: [{name, capability, actionClass, serverHint?}], dropped?, truncated, surface,
    calls: [{tool, isError, text, structuredContent?, refused?, denial?,
      serverPolicyRefusal?} | {tool, error}]}
    Launches one trusted server through the same client the gateway uses,
    lists its tools, makes each --call in order, and closes it. Each call is
    admitted as a session admits it; one that needs approval is refused,
    because no operator or safety judge reviews it here (a headless run's
    judge may allow it), and a tool the server does not list is never sent. A
    call whose request gets no answer is recorded as {tool, error} and ends
    the calls; a JSON-RPC error answer is that call's error.
    An untrusted or stale declaration is never launched. Test never records a
    surface approval, so its calls are refused until the surface is approved.
    dropped lists [{name, reason}] for each tool a remote server offered with
    an x-mcp-header PanCode cannot send; such a tool is never registered.
    A server that declares the io.modelcontextprotocol/skills extension also
    carries skills: {directoryRead, ttlMs, truncated, skills: [{name, uri,
    manifestDigest, files, bytes, approval}], refused: [{uri, name, kind,
    reason}]} or {reason} when none could be listed. approval is approved,
    unapproved or changed for this project. Listing reads no skill file and
    records the listing that dispatch admission reads.
    A server that offers the io.modelcontextprotocol/events extension also
    carries events: [{name, description, delivery, arguments}],
    eventsTruncated when the listing stopped at PanCode's cap, or
    eventsFailure when events/list failed; text prints one event line each.
    The supported seam for external integration checks; nothing outside
    PanCode needs to import its source.
  trust: {ok: true, record: {projectRoot, id, digest, actionClass, trustedAt, network?,
    entryScriptHashes?}, entry: [...], toolActionClasses, toolPathArguments}
    entry lists the project files the record binds: an absolute command,
    every argument not shaped like a flag and every value a flag carries
    after = (--require=./a.cjs) that names an existing file in the project.
    Imports, python -m modules, directories, npx or uvx bins and files named
    through env such as NODE_OPTIONS or PATH are not bound; a symlink whose
    target is outside the project is bound by path only. entryScriptHashes
    maps each bound file to its SHA-256. Bindings are checked when a session or worker takes its MCP
    snapshot, so an edit is caught from the next session or dispatch.
    --network lets the server's own sandboxed process reach the network in
    fleet workers; worker shells keep their policy. On Linux that is the host
    network namespace (internet, localhost services and abstract unix
    sockets); on macOS the seatbelt profile allows network. Credential masking
    is a denylist of known paths, so other secrets readable in the home can
    leave with the grant. A worker whose write roots contain or lie inside
    the server's launch cwd, the directory of a file it runs (a project
    server's bound entry files; every existing file argument of a user or
    plugin server), or a project server's project root starts it without
    the grant, which an in-place or worktree writer does for a server in its
    tree; a read-only worker keeps it. A module the server imports is not
    bound, so a writer's edit to one persists into a later read-only run
    that holds the grant. Re-trusting without it drops the grant.
    Trust approves the launch only. Run at a terminal without --json, it then
    launches the server, prints the tool surface it serves and records that
    surface as approved; otherwise it records none and names trust --surface.
  trust --surface: {ok, recorded, surface: {status, digest, approvedDigest,
    reason?, remedy?}, tools: [{name, sha256}], record?}
    The second approval of a trusted server: launches it, lists its tools and
    prints the surface digest, a SHA-256 over each tool's name, input schema
    and annotations (descriptions and titles are left out, so rewording one
    changes nothing). Until it is approved, and again whenever a tool is
    added, removed or changes its schema or annotations, sessions and workers
    list the server's tools but refuse every call, naming this command; launch
    trust stands meanwhile. At a terminal without --json it records the
    surface it shows. --hash records only when the served digest equals the
    one given, the non-interactive form for a reviewed surface; without it a
    non-interactive run prints the command that would record it and exits 0.
    A user-scope server's surface is recorded on its first listing in an
    attended session and reported as recorded; a headless session or worker
    never records one. The tool metadata cache is never read as approval.
    On a builtin server trust takes only --network and returns {ok: true,
    grant: {id, network, grantedAt}}. The grant is keyed by the server id, not
    by a project or a digest, so it holds in every project and survives an
    upgrade; the classes, path arguments and surface stay the shipped policy.
  trust --skill: {ok, recorded, skill: {name, uri, manifestDigest, bytes,
    files: [{path, uri, size, digest}], frontmatter}, approval: {status,
    approvedDigest, reason?}, record?}
    Approves one skill a trusted server serves: launches it, lists its skills,
    fetches the named one with skills/get, prints its manifest, files and
    frontmatter, and records that version for this project (any project for
    a user-scope server). The approval binds the manifest digest and the
    server's declaration digest; a changed file, frontmatter or declaration
    reads as changed and loads nothing until approved again. --skill takes
    the listed name (<id>:<name> or <name>) or the skill's uri. At a terminal
    without --json it records the version it shows; --hash records only when
    the served manifest digest equals the one given; otherwise it prints the
    command that would record it and exits 0. The listing it reads is
    recorded as test records it.
  untrust: {ok: true, removed: boolean}
  add: {ok: true, path, id}; remove: {ok: true, path}
  login: {ok: true, stored: [{header, key, origin}]}, or for OAuth
    {ok: true, signedIn: true, issuer, resource, scopes} or
    {ok: true, signedIn: false} when the server asks for no sign-in
  logout: {ok: true, removed: [key], origin, signedOut: boolean}
  untrust --skill: {ok: true, removed: boolean, uri}
    Removes this project's approval of one skill, matched by uri or name
    among the recorded approvals. Nothing is launched.
  errors: {ok: false, message: string}
Exit codes: 0 success; 1 operational failure; 2 invalid usage. A test also
 exits 1 when its server fails or one of its calls returns an error.
List retains its response shape on failure and exits 1 when config or trust
 diagnostics other than warnings are present. Mutation errors return the
 error shape with a one-line reason. --help prints this text even when --json
 is supplied.
`;

/**
 * The worker network grant as one per-server field. Only a trusted server
 * carries it; a stale record's grant lapses with its trust.
 */
function networkGrant(server: ResolvedMcpServer): { network: boolean; networkSource?: "trust" | "declaration" } {
	if (server.trust.status !== "trusted" || server.trust.network !== true) return { network: false };
	return { network: true, networkSource: server.scope === "user" ? "declaration" : "trust" };
}

/** The project files a project server's trust binds; null for a scope that binds none. */
function boundEntry(server: ResolvedMcpServer): string[] | null {
	return server.scope === "project" ? (server.entryScripts ?? []).map((entry) => entry.path) : null;
}

/**
 * Each binding as the trust record holds it: a symlinked entry names the real
 * path whose content is hashed, and one whose target is outside the project
 * is marked as bound by path only, so the printed list matches the record.
 */
function entryLabel(entries: ReadonlyArray<McpServerEntryScript>): string {
	if (entries.length === 0) return "entry=none";
	const spelled = entries.map((entry) => {
		if ("error" in entry || entry.realPath === undefined) return entry.path;
		return "sha256" in entry ? `${entry.path} -> ${entry.realPath}` : `${entry.path} -> ${entry.realPath} (path only)`;
	});
	return `entry=${spelled.join(", ")}`;
}

/**
 * The per-tool classes a declaration asks for, printed before trust is granted
 * so the operator sees what a project or plugin declaration will classify.
 */
const CALL_TEXT_MAX_CHARS = 2_000;

/** A call's result, cut with a marker that says so; `--json` carries all of it (dogfood F6). */
/** A server's instructions as terminal rows under a label that says who wrote them. */
function instructionsLines(instructions: string): string[] {
	return [
		"  instructions (written by the server):",
		...escapeTerminalControls(instructions)
			.split(/\r?\n/u)
			.map((line) => `    ${line}`),
	];
}

function boundedCallText(text: string): string {
	if (text.length <= CALL_TEXT_MAX_CHARS) return text;
	return `${text.slice(0, CALL_TEXT_MAX_CHARS)}… (${text.length - CALL_TEXT_MAX_CHARS} more characters; --json prints the whole result)`;
}

/**
 * The server-wide class a text listing prints. A trusted server whose own class is the `unknown` fallback for undeclared
 * tools, and whose every listed tool declares one class, reads as that class (a builtin server; dogfood F13).
 */
function serverClassLabel(
	trust: { status: string; actionClass: string },
	tools: ReadonlyArray<{ actionClass: string }>,
): string {
	const first = tools[0]?.actionClass;
	return trust.status === "trusted" &&
		trust.actionClass === "unknown" &&
		first !== undefined &&
		first !== "unknown" &&
		tools.every((tool) => tool.actionClass === first)
		? first
		: trust.actionClass;
}

function toolClassesLabel(classes: Readonly<Record<string, string>>): string {
	const names = Object.keys(classes).sort();
	return names.length === 0 ? "" : ` toolActionClasses=${names.map((name) => `${name}:${classes[name]}`).join(",")}`;
}

/** The path arguments a declaration asks PanCode to judge, printed beside its classes. */
function pathArgumentsLabel(declared: McpToolPathArguments | undefined): string {
	const pairs = Object.keys(declared ?? {})
		.sort()
		.flatMap((tool) =>
			Object.keys(declared?.[tool] ?? {})
				.sort()
				.map((argument) => `${tool}.${argument}:${declared?.[tool]?.[argument]}`),
		);
	return pairs.length === 0 ? "" : ` toolPathArguments=${pairs.join(",")}`;
}

/** Where a server runs: its launch vector, or its endpoint and the header credentials it sends by key, never by value. */
function launchLabel(server: {
	url?: string;
	headers?: Readonly<Record<string, string>>;
	command?: string;
	args?: ReadonlyArray<string>;
	cwd: string;
}): string {
	if (server.url === undefined)
		return `command=${JSON.stringify([server.command, ...(server.args ?? [])])} cwd=${JSON.stringify(server.cwd)}`;
	const headers = server.headers ?? {};
	const named = Object.keys(headers)
		.sort()
		.map((header) => `${header}:${headers[header]}`);
	return `url=${JSON.stringify(server.url)}${named.length > 0 ? ` headers=${named.join(",")}` : ""}`;
}

function networkLabel(grant: ReturnType<typeof networkGrant>): string {
	return grant.network
		? `network=true (${grant.networkSource === "trust" ? "trust record" : "user declaration"})`
		: "network=false";
}

/**
 * The first line of text `mcp test` output. It names the network grant and its
 * source the way `mcp list` does; only --json carried it before.
 */
export function mcpTestHeadline(
	id: string,
	info: McpServerInfo,
	toolCount: number,
	grant: ReturnType<typeof networkGrant>,
): string {
	return `${id}: protocol ${info.protocolVersion}, server ${info.serverInfo?.name ?? "?"} ${info.serverInfo?.version ?? "?"}, ${toolCount} tools, ${networkLabel(grant)}`;
}

type McpSurfaceReport = McpSurfaceStatus & { remedy?: string };

/**
 * A trusted server's surface approval against what it served, or against
 * nothing when it was not launched; null for a server that is not trusted.
 */
function surfaceStatusOf(server: ResolvedMcpServer, served: McpSurface | null): McpSurfaceReport | null {
	if (server.trust.status !== "trusted") return null;
	const status = judgeMcpSurface(server, server.trust.surface, served);
	return status.status === "approved" ? status : { ...status, remedy: mcpSurfaceRemedyFor(server) };
}

/**
 * The tools a server lists without launching it: a builtin server's from the
 * policy this PanCode ships, any other trusted server's from its recorded catalog.
 */
function offlineTools(
	server: ResolvedMcpServer,
	cwd: string,
): {
	tools: Array<{ name: string; annotations: Record<string, unknown> | null }>;
	catalog: "shipped" | "cached" | "missing";
	catalogStale?: true;
	instructions?: string;
	resources?: McpResourceCount | "unlisted";
	prompts?: { count: number; stale?: true };
} {
	if (server.builtin !== undefined) {
		return { tools: server.builtin.tools.map(({ name, annotations }) => ({ name, annotations })), catalog: "shipped" };
	}
	const catalog =
		server.trust.status !== "trusted"
			? null
			: readMcpServerCatalog({
					projectRoot: canonicalProjectRoot(cwd),
					scope: server.scope,
					declarationPath: server.path,
					serverId: server.id,
					digest: mcpCatalogDigest(server),
					cwd: server.cwd,
				});
	if (catalog === null) return { tools: [], catalog: "missing" };
	return {
		tools: catalog.tools.map((tool) => ({ name: tool.name, annotations: tool.annotations ?? null })),
		catalog: "cached",
		...(mcpCatalogStale(catalog) ? { catalogStale: true as const } : {}),
		...(catalog.instructions !== undefined ? { instructions: catalog.instructions } : {}),
		...(catalog.resources === true ? { resources: catalog.resourceCount ?? ("unlisted" as const) } : {}),
		...(catalog.prompts !== undefined
			? {
					prompts: {
						count: catalog.prompts.prompts.length,
						...(mcpPromptsStale(catalog) ? { stale: true as const } : {}),
					},
				}
			: {}),
	};
}

/** One bounded line of what a server offers besides tools; null when it offers neither resources nor prompts. */
function resourcesAndPromptsLine(
	resources: McpResourceCount | "unlisted" | undefined,
	prompts: { count: number; stale?: true; truncated?: true } | undefined,
): string | null {
	const parts: string[] = [];
	if (resources === "unlisted") parts.push("resources=declared (not listed yet)");
	else if (resources !== undefined)
		parts.push(
			`resources=${resources.resources}${resources.truncated ? "+" : ""} templates=${resources.templates}${resources.truncated ? "+" : ""}`,
		);
	if (prompts !== undefined)
		parts.push(`prompts=${prompts.count}${prompts.truncated ? "+" : ""}${prompts.stale ? " (stale)" : ""}`);
	return parts.length > 0 ? `  ${parts.join(" ")}` : null;
}

/** `<id>:<prompt>` for every prompt a trusted server's recorded catalog lists; no server is launched. */
export function recordedMcpPromptCommands(cwd: string): Set<string> {
	const names = new Set<string>();
	for (const server of resolveMcpServers({ cwd }).servers) {
		if (server.trust.status !== "trusted" || server.builtin !== undefined) continue;
		const catalog = readMcpServerCatalog({
			projectRoot: canonicalProjectRoot(cwd),
			scope: server.scope,
			declarationPath: server.path,
			serverId: server.id,
			digest: server.digest,
			cwd: server.cwd,
		});
		for (const prompt of catalog?.prompts?.prompts ?? []) {
			if (isMcpPromptCommandName(prompt.name)) names.add(`${server.id}:${prompt.name}`);
		}
	}
	return names;
}

function surfaceLabel(surface: McpSurfaceReport): string {
	if (surface.status === "approved") return `surface=approved ${surface.approvedDigest ?? ""}`.trimEnd();
	return `surface=${surface.status}${surface.reason !== undefined ? ` (${surface.reason})` : ""}`;
}

export interface McpCommandOutput {
	code: number;
	text: string;
	data: unknown;
}

/** Shared operator outcomes for the CLI and slash command. */
/** A server's state in a live gateway: connected, failed or needs-auth once reached, else trusted, untrusted or stale. */
export interface McpLiveStatus {
	status: string;
	reason?: string;
	remedy?: string;
}

/** The live states a gateway listing reports for servers it reached. */
export function mcpLiveStatuses(
	servers: ReadonlyArray<{ id: string; status: string; reason?: string; remedy?: string }>,
): Map<string, McpLiveStatus> {
	const live = new Map<string, McpLiveStatus>();
	for (const server of servers) {
		if (server.status !== "connected" && server.status !== "failed" && server.status !== "needs-auth") continue;
		live.set(server.id, {
			status: server.status,
			...(server.reason !== undefined ? { reason: server.reason } : {}),
			...(server.remedy !== undefined ? { remedy: server.remedy } : {}),
		});
	}
	return live;
}

export function mcpCommandOutput(
	argv: ReadonlyArray<string>,
	options: McpTrustOptions = { cwd: process.cwd() },
	served: ReadonlyMap<string, McpSurface> = new Map(),
	live: ReadonlyMap<string, McpLiveStatus> = new Map(),
): McpCommandOutput {
	const fail = (code: number, message: string): McpCommandOutput => {
		const text = message.replace(/[\r\n]+/gu, " ");
		return { code, text, data: { ok: false, message: text } };
	};
	try {
		const [command, id, ...rest] = argv;
		if (command === "add" || command === "remove") return mcpEditOutput(argv, options, fail);
		if (command === "logout") return mcpLogoutOutput(id, rest, options, fail);
		if (command === "login")
			return fail(
				1,
				`mcp login reads credentials at a terminal or from stdin: run pancode mcp login ${id ?? "<id>"} in a shell`,
			);
		if (command === "list" && id === undefined) {
			const resolved = resolveMcpServers(options);
			const result = {
				...resolved,
				servers: resolved.servers.map((server) => {
					const offline = offlineTools(server, options.cwd);
					const entry = boundEntry(server);
					const surface = surfaceStatusOf(server, served.get(server.id) ?? null);
					const state = live.get(server.id);
					// The shipped schemas are policy, not a listing; list shows the version, title and the variable names it is given.
					const { builtin, ...declaration } = server;
					return {
						...declaration,
						...(state !== undefined ? { status: state } : {}),
						// An env value is often a token: list names the keys and never prints a value.
						...(server.env !== undefined
							? { env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "[redacted]"])) }
							: {}),
						...(builtin !== undefined
							? { builtin: { version: builtin.version, title: builtin.title, environment: builtin.environment } }
							: {}),
						...(entry !== null ? { entry } : {}),
						...networkGrant(server),
						tools: offline.tools.flatMap((tool) => {
							const capability = mcpToolName(server.id, tool.name);
							return capability === null
								? []
								: [{ name: tool.name, capability, actionClass: mcpToolActionClass(server, tool) }];
						}),
						catalog: offline.catalog,
						...(offline.catalogStale === true ? { catalogStale: true } : {}),
						...(offline.instructions !== undefined ? { instructions: offline.instructions } : {}),
						...(offline.resources !== undefined ? { resources: offline.resources } : {}),
						...(offline.prompts !== undefined ? { prompts: offline.prompts } : {}),
						...(surface !== null ? { surface } : {}),
					};
				}),
			};
			// Each server's tools and surface sit under its own header line (CLI audit 7).
			const lines = result.servers.flatMap((server) => {
				const block = [
					`${server.id} scope=${server.scope}${server.plugin !== undefined ? ` plugin=${server.plugin.id}` : ""} ${launchLabel(server)} trust=${server.trust.status}${"reason" in server.trust ? ` (${server.trust.reason})` : ""} actionClass=${serverClassLabel(server.trust, server.tools)}${toolClassesLabel(server.toolActionClasses)}${pathArgumentsLabel(server.toolPathArguments)}${server.scope === "project" ? ` ${entryLabel(server.entryScripts ?? [])}` : ""}${server.builtin !== undefined && server.builtin.environment.length > 0 ? ` environment=${server.builtin.environment.join(",")}` : ""} ${networkLabel(server)}${server.status !== undefined ? ` status=${server.status.status}` : ""}`,
				];
				if (server.status?.reason !== undefined) {
					const remedy =
						server.status.remedy !== undefined && !server.status.reason.includes(server.status.remedy)
							? `; run ${server.status.remedy}`
							: "";
					block.push(`  ${server.status.status}: ${server.status.reason}${remedy}`);
				}
				for (const tool of server.tools) block.push(`  ${tool.capability} actionClass=${tool.actionClass}`);
				if (server.trust.status === "trusted" && server.catalog === "missing")
					block.push("  no recorded tool catalog; use pancode mcp list --refresh");
				if (server.catalogStale === true)
					block.push("  catalog stale: older than the server's own ttlMs; pancode mcp list --refresh lists it again");
				const offers = resourcesAndPromptsLine(server.resources, server.prompts);
				if (offers !== null) block.push(offers);
				if (server.surface !== undefined) block.push(`  ${surfaceLabel(server.surface)}`);
				if (server.instructions !== undefined) block.push(...instructionsLines(server.instructions));
				return block;
			});
			lines.push(
				...result.diagnostics.map(
					(entry) => `${entry.severity === "warning" ? "warning: " : ""}${entry.path}: ${entry.message}`,
				),
				...result.trustDiagnostics,
			);
			const failing = result.diagnostics.filter((entry) => entry.severity !== "warning");
			return {
				code: failing.length || result.trustDiagnostics.length ? 1 : 0,
				text: lines.join("\n") || "mcp: none",
				data: result,
			};
		}
		if ((command !== "trust" && command !== "untrust") || !id)
			return fail(
				2,
				"usage: pancode mcp list | add <id> [--scope user|project] (--url <url> [--header <Name>=<key>]... | -- <command> [args...]) | remove <id> [--scope user|project] | login <id> [--client-secret] | logout <id> | test <id> [--call <tool> [--args <json>]]... | trust <id> [--action-class <class>] [--network] | untrust <id>",
			);
		// A flag where the id belongs is named as a flag, never looked up as a server id (C5); exit 1 stays (NIGHT-DECISIONS 2).
		if (id.startsWith("-")) return fail(1, `unknown flag: ${id}`);
		let actionClass: McpTrustActionClass | undefined;
		let network = false;
		const flags = [...rest];
		if (flags.length && command !== "trust") return fail(2, "--action-class and --network apply only to trust");
		while (flags.length) {
			const flag = flags.shift();
			if (flag === "--network" && !network) {
				network = true;
				continue;
			}
			const value = flags.shift();
			if (
				flag !== "--action-class" ||
				actionClass !== undefined ||
				!MCP_TRUST_ACTION_CLASSES.includes(value as McpTrustActionClass)
			)
				return fail(
					2,
					`trust takes --action-class <${MCP_TRUST_ACTION_CLASSES.join("|")}> and --network, each at most once`,
				);
			actionClass = value as McpTrustActionClass;
		}
		const declared = resolveMcpServers(options).servers.find((entry) => entry.id === id);
		const builtin = declared?.scope === "builtin";
		if (command === "trust" && builtin) {
			// The network grant is the one decision an operator records for a builtin server.
			if (!network || actionClass !== undefined) return fail(1, mcpBuiltinTrustRefusal(id));
			const result = grantMcpBuiltinNetwork({ ...options, id });
			if (!result.ok) return fail(1, result.message);
			return {
				code: 0,
				text: `mcp: granted ${id} network in fleet workers (recorded ${result.grant.grantedAt})`,
				data: result,
			};
		}
		// A grant outlives the server's removal from a later PanCode, so untrust still finds it.
		const leftover =
			declared === undefined &&
			readMcpTrustState(options.configDir).state.builtins?.some((entry) => entry.id === id) === true;
		if (command === "untrust" && (builtin || leftover)) {
			const result = revokeMcpBuiltinNetwork({ ...options, id });
			return result.ok
				? {
						code: 0,
						text: `mcp: untrusted ${id} (network grant ${result.removed ? "removed" : "already absent"})`,
						data: result,
					}
				: fail(1, result.message);
		}
		if (command === "trust") {
			const result = trustMcpServer({ ...options, id, ...(actionClass ? { actionClass } : {}), network });
			if (!result.ok) return fail(1, result.message);
			const { entryScripts, ...data } = result;
			const { record } = result;
			// The record itself is --json's; text names what it grants in a sentence.
			return {
				code: 0,
				text: [
					`mcp: trusted ${id} for ${record.projectRoot} with actionClass=${record.actionClass} network=${record.network === true} ${entryLabel(entryScripts)}${toolClassesLabel(result.toolActionClasses)}${pathArgumentsLabel(result.toolPathArguments)} (digest ${record.digest.slice(0, 12)}, recorded ${record.trustedAt})`,
					// A trusted declaration decides where a stored credential goes, so trust names each route.
					...(declared?.url !== undefined
						? mcpCredentialRoutes(declared.url, declared.headers).map((route) => `  ${route}`)
						: []),
				].join("\n"),
				data,
			};
		}
		const resolved = resolveMcpServers(options);
		const server = resolved.servers.find((entry) => entry.id === id);
		if (!server) return fail(1, `no declared MCP server with id '${id}'`);
		if (server.scope === "user")
			return fail(1, `server '${id}' is a user-scope declaration; it is trusted by authorship`);
		const result = untrustMcpServer({ ...options, id });
		return result.ok
			? { code: 0, text: `mcp: untrusted ${id} (record ${result.removed ? "removed" : "already absent"})`, data: result }
			: fail(1, result.message);
	} catch (error) {
		return fail(1, error instanceof Error ? error.message : String(error));
	}
}

interface McpTestCall {
	tool: string;
	args: Record<string, unknown>;
}

/** `test <id> [--call <tool> [--args <json>]]...`, or the usage error that refuses it. */
function parseMcpTestArgs(argv: ReadonlyArray<string>): { id: string; calls: McpTestCall[] } | string {
	const [, id, ...rest] = argv;
	if (id === undefined || id.startsWith("--")) return "usage: pancode mcp test <id> [--call <tool> [--args <json>]]...";
	const calls: McpTestCall[] = [];
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (flag === "--call" && value !== undefined && !value.startsWith("--")) {
			calls.push({ tool: value, args: {} });
			index += 1;
			continue;
		}
		const last = calls.at(-1);
		if (flag === "--args" && value !== undefined && last !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				return `--args for ${last.tool} must be a JSON object`;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				return `--args for ${last.tool} must be a JSON object`;
			last.args = parsed as Record<string, unknown>;
			index += 1;
			continue;
		}
		return "usage: pancode mcp test <id> [--call <tool> [--args <json>]]...; --args follows its --call";
	}
	return { id, calls };
}

/** Actionable message when `mcp test --call` hits a non-interactive operator-confirmation refusal. */
function mcpTestConfirmationRefusal(
	server: ResolvedMcpServer,
	tool: string,
	verdict: Extract<RegistryVerdict, { kind: "blocked" }>,
): string {
	const actionClass = verdict.denial?.actionClass ?? verdict.decision.classification.actionClass;
	if (actionClass !== "read") {
		const classifyRemedy =
			server.scope === "user"
				? `set actionClass: read or toolActionClasses: { ${tool}: read } on ${server.id} in ${server.path} if it is read-only`
				: server.scope === "project" || server.scope === "plugin"
					? `run pancode mcp trust ${server.id} --action-class read (or set toolActionClasses: { ${tool}: read } in ${server.path} and re-trust) if it is read-only`
					: undefined;
		return `refused: ${tool} has actionClass=${actionClass}, which needs operator confirmation (pancode mcp test runs non-interactively); ${classifyRemedy !== undefined ? `${classifyRemedy}, or ` : ""}run it in an interactive session`;
	}
	const why = verdict.decision.policy?.reasons[0] ?? verdict.decision.classification.reasons[0];
	return `refused: ${tool} needs operator confirmation${why !== undefined ? ` (${why})` : ""}, and pancode mcp test runs non-interactively; run it in an interactive session`;
}

/** One `mcp test` call as the registry settled it. */
function mcpTestCallRecord(
	server: ResolvedMcpServer,
	tool: string,
	capability: string,
	verdict: RegistryVerdict,
): Record<string, unknown> {
	if (verdict.kind === "not_visible") return { tool, isError: true, refused: true, text: verdict.reason };
	if (verdict.kind === "blocked") {
		const denial = verdict.denial;
		const text =
			denial?.layer === "operator_approval" && verdict.reason.includes("no permission listener")
				? mcpTestConfirmationRefusal(server, tool, verdict)
				: verdict.reason;
		return {
			tool,
			isError: true,
			refused: true,
			text,
			...(denial !== undefined ? { denial } : {}),
			...(denial?.layer === "mcp_server_policy"
				? {
						serverPolicyRefusal: {
							code: denial.code,
							message: verdict.decision.classification.reasons[0] ?? verdict.reason,
						},
					}
				: {}),
		};
	}
	const result = verdict.result;
	const details = result.details ?? {};
	// A surface that is not approved refuses the call before it is sent.
	if (result.kind === "error" && (details.refusal as { kind?: unknown } | undefined)?.kind === "mcp_surface_unapproved")
		return { tool, isError: true, refused: true, text: result.message };
	// Only a result the server answered carries its id; an error without it is
	// a request that never got an answer.
	if (result.kind === "error" && details.server !== server.id) return { tool, error: result.message };
	const structured = details.structuredContent;
	return {
		tool,
		isError: result.kind === "error",
		text: result.kind === "error" ? result.message.replace(`${capability}: `, "") : result.output,
		...(structured !== undefined ? { structuredContent: structured } : {}),
	};
}

/**
 * Launch one declared server the way the gateway does and report what PanCode
 * sees: the negotiated protocol, the server's identity, its tools with the
 * action class PanCode enforces, and the raw result of each requested call. The
 * launch goes through the gateway's own capability source, so trust gating,
 * cwd containment, the safe tool environment and teardown are the session's,
 * not a second copy of them.
 */
async function mcpTestOutput(id: string, calls: ReadonlyArray<McpTestCall>): Promise<McpCommandOutput> {
	const fail = (message: string, data: Record<string, unknown> = {}): McpCommandOutput => ({
		code: 1,
		text: `mcp test ${id}: ${message}`,
		data: { ok: false, message, ...data },
	});
	const cwd = process.cwd();
	const server = resolveMcpServers({ cwd }).servers.find((entry) => entry.id === id);
	if (server === undefined) return fail(`no declared MCP server with id '${id}'`);
	const trust = server.trust;
	const described = { id: server.id, scope: server.scope, trust, ...networkGrant(server) };
	if (trust.status !== "trusted")
		return fail(`server '${id}' is ${trust.status}; it is never launched until trusted: pancode mcp trust ${id}`, {
			server: described,
		});
	const [{ createMcpCapabilitySource }, { createRegistry }, { createWorkerSafety }, { createMcpClient }] =
		await Promise.all([
			import("../tools/gateway/mcp-capabilities.js"),
			import("../tools/registry.js"),
			import("../engine/worker-tools.js"),
			import("../domains/gateway/mcp/index.js"),
		]);
	let client: McpClient | null = null;
	const registry = createRegistry({ safety: createWorkerSafety({ cwd }) });
	const source = createMcpCapabilitySource({
		cwd,
		registry,
		// An operator command, as `pancode store put` is: it may write every tag.
		store: { writable: true },
		clientFactory: (spec, options) => {
			const created = createMcpClient(spec, options);
			if (spec.id === id) client = created;
			return created;
		},
	});
	try {
		const refreshed = await source.refresh(id);
		const live = client as McpClient | null;
		const info = live?.serverInfo() ?? null;
		if (live === null || info === null || refreshed.reason !== undefined)
			return fail(refreshed.reason ?? "the server did not finish initializing", { server: described });
		const owned = source.catalog().entries.filter((entry) => source.ownerIdOf(entry.name) === id);
		const tools = owned.map((entry) => ({
			name: entry.name.slice(`mcp_${id}__`.length),
			capability: entry.name,
			actionClass: entry.actionClass,
			...source.discoveryNote(entry.name),
		}));
		// Each call goes through the registry the server's tools were registered
		// in, so `mcp test` admits exactly what a session admits: action class,
		// confirmation rule, execute projection, information flow and repeat
		// refusal. Arguments are not checked against the tool's input schema;
		// the server validates them. No park listener or safety judge exists
		// here, so an ask is refused instead of waiting; a headless run's judge
		// may still allow the same call.
		const results: Array<Record<string, unknown>> = [];
		for (const call of calls) {
			const capability = mcpToolName(id, call.tool);
			if (capability === null || source.ownerIdOf(capability) !== id || registry.get(capability) === undefined) {
				results.push({
					tool: call.tool,
					isError: true,
					refused: true,
					text: `server '${id}' lists no tool named '${call.tool}'; nothing was sent`,
				});
				continue;
			}
			let verdict: RegistryVerdict;
			try {
				verdict = await registry.invoke({ tool: capability, args: call.args });
			} catch (error) {
				results.push({ tool: call.tool, error: error instanceof Error ? error.message : String(error) });
				break;
			}
			const record = mcpTestCallRecord(server, call.tool, capability, verdict);
			results.push(record);
			// The request got no answer (timeout, a dead server), so later calls
			// would only report the same transport failure. A JSON-RPC error answer
			// is that call's own error and the run goes on.
			if ("error" in record) break;
		}
		const latestInfo = live.serverInfo() ?? info;
		const skills = await mcpTestSkills(source, server, latestInfo);
		const listing = refreshed.listing;
		const offers = await liveResourcesAndPrompts(source, live, id);
		const surface = surfaceStatusOf(server, source.servedSurface(id));
		const dropped = listing?.dropped ?? [];
		const data = {
			ok: results.every((result) => result.isError === false),
			server: described,
			protocolVersion: latestInfo.protocolVersion,
			serverInfo: latestInfo.serverInfo,
			...(latestInfo.instructions !== null ? { instructions: latestInfo.instructions } : {}),
			tools,
			...(dropped.length > 0 ? { dropped } : {}),
			truncated: listing?.truncated === true,
			...offers.data,
			...(surface !== null ? { surface } : {}),
			...(listing?.events !== undefined ? { events: listing.events } : {}),
			...(listing?.eventsTruncated === true ? { eventsTruncated: true } : {}),
			...(listing?.eventsFailure !== undefined ? { eventsFailure: listing.eventsFailure } : {}),
			...(skills !== null ? { skills: skills.data } : {}),
			calls: results,
		};
		const lines = [
			mcpTestHeadline(id, latestInfo, tools.filter((tool) => !isMcpResourceCapability(tool.name)).length, described),
			...tools.map((tool) => `  ${tool.capability} actionClass=${tool.actionClass}`),
			...dropped.map((tool) => `  dropped ${tool.name}: ${escapeTerminalControls(tool.reason)}`),
			...offers.lines,
			...(surface !== null ? [`  ${surfaceLabel(surface)}`] : []),
			...(listing?.events ?? []).map(
				(event) =>
					`  event ${escapeTerminalControls(event.name)} delivery=${event.delivery.join(",")} arguments=${boundedCallText(JSON.stringify(event.arguments))}${event.description.length > 0 ? ` ${boundedCallText(escapeTerminalControls(event.description.replace(/\s+/g, " ")))}` : ""}`,
			),
			...(listing?.eventsTruncated === true ? ["  events truncated at the client cap"] : []),
			...(listing?.eventsFailure !== undefined
				? [`  events unavailable: ${escapeTerminalControls(listing.eventsFailure)}`]
				: []),
			...(latestInfo.instructions !== null ? instructionsLines(latestInfo.instructions) : []),
			...(skills?.lines ?? []),
			...results.map(
				(result) =>
					`call ${String(result.tool)}: ${"error" in result ? "failed" : result.refused === true ? "refused" : result.isError === true ? "error" : "ok"} ${boundedCallText(String(result.error ?? result.text))}`,
			),
		];
		return { code: data.ok ? 0 : 1, text: lines.join("\n"), data };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), { server: described });
	} finally {
		await source.close();
	}
}

const MCP_TEST_LISTED = 20;

/**
 * What `mcp test` shows of a launched server's resources and prompts: the
 * counts, then the first entries of each by name. Every name is server text,
 * so it is one bounded line with terminal controls escaped.
 */
async function liveResourcesAndPrompts(
	source: Pick<McpCapabilitySource, "resourceServerIds" | "listResources">,
	client: McpClient,
	id: string,
): Promise<{ lines: string[]; data: Record<string, unknown> }> {
	const lines: string[] = [];
	const data: Record<string, unknown> = {};
	const named = (text: string): string => escapeTerminalControls(text.replace(/\s+/gu, " ")).slice(0, 160);
	const errorLine = (text: string): string => escapeTerminalControls(text.replace(/\s+/gu, " ")).slice(0, 400);
	let resources: McpResourceCount | undefined;
	let listed: Array<{ uri: string; name: string }> = [];
	if (source.resourceServerIds().includes(id)) {
		const answer = await source.listResources(id);
		if (answer.ok) {
			const { resources: entries, templates, truncated } = answer.value;
			resources = { resources: entries.length, templates: templates.length, ...(truncated ? { truncated } : {}) };
			listed = [
				...entries.map((entry) => ({ uri: entry.uri, name: entry.name })),
				...templates.map((entry) => ({ uri: entry.uriTemplate, name: entry.name })),
			];
			data.resources = { ...resources, listed: listed.slice(0, MCP_TEST_LISTED) };
		} else data.resources = { error: answer.error };
	}
	let prompts: string[] = [];
	let promptCount: { count: number; truncated?: true } | undefined;
	if (client.serverInfo()?.capabilities.prompts !== undefined) {
		try {
			const listing = await client.listPrompts();
			prompts = listing.prompts.map((prompt) => prompt.name);
			promptCount = { count: prompts.length, ...(listing.truncated ? { truncated: true as const } : {}) };
			data.prompts = { ...promptCount, listed: prompts.slice(0, MCP_TEST_LISTED) };
		} catch (error) {
			data.prompts = { error: error instanceof Error ? error.message : String(error) };
			lines.push(`  prompts: ${errorLine(String((data.prompts as { error: unknown }).error))}`);
		}
	}
	const line = resourcesAndPromptsLine(resources, promptCount);
	if (line !== null) lines.unshift(line);
	if (typeof data.resources === "object" && data.resources !== null && "error" in data.resources)
		lines.push(`  resources: ${errorLine(String((data.resources as { error: unknown }).error))}`);
	for (const entry of listed.slice(0, MCP_TEST_LISTED)) lines.push(`  @${id}:${named(entry.uri)}`);
	if (listed.length > MCP_TEST_LISTED) lines.push(`  ... ${listed.length - MCP_TEST_LISTED} more resources`);
	for (const prompt of prompts.slice(0, MCP_TEST_LISTED)) {
		lines.push(
			isMcpPromptCommandName(prompt)
				? `  /${id}:${named(prompt)}`
				: `  prompt ${named(prompt)} (not callable as /${id}:<name>)`,
		);
	}
	if (prompts.length > MCP_TEST_LISTED) lines.push(`  ... ${prompts.length - MCP_TEST_LISTED} more prompts`);
	return { lines, data };
}

/**
 * The skills a server that declares the skills extension lists, each with its
 * manifest digest and whether that version is approved here, and the entries
 * PanCode refuses with their reasons; null for a server that declares none.
 * Listing reads no skill file.
 */
async function mcpTestSkills(
	source: McpCapabilitySource,
	server: ResolvedMcpServer,
	info: McpServerInfo,
): Promise<{ data: Record<string, unknown>; lines: string[] } | null> {
	const declared = mcpSkillsSettings(info.capabilities);
	if (declared.settings === null && declared.reason === null) return null;
	const access = await source.skillAccess(server.id);
	if (access.transport === null) {
		const reason = boundedMcpSkillText(access.reason, 4096);
		return { data: { reason }, lines: [`  skills: none loaded: ${reason}`] };
	}
	const { listing } = access;
	const displays = mcpSkillDisplayNames(server.id, listing.skills);
	const skills = listing.skills.map((entry) => {
		const status = judgeMcpSkillApproval(
			currentMcpSkillApproval(server, entry.uri, { cwd: process.cwd() }),
			server,
			entry,
		);
		return {
			name: displays.get(entry.uri) ?? `${server.id}:${entry.name}`,
			uri: entry.uri,
			manifestDigest: entry.manifestDigest,
			files: entry.resources.length,
			bytes: entry.totalBytes,
			approval: status.status,
		};
	});
	const refused = listing.refused.map((item) => ({
		uri: item.uri === null ? null : boundedMcpSkillText(item.uri, 512),
		name: item.name === null ? null : boundedMcpSkillText(item.name, 256),
		kind: item.kind,
		reason: boundedMcpSkillText(item.reason),
	}));
	const lines = [
		...skills.map(
			(skill) =>
				`  skill ${skill.name} ${skill.manifestDigest} files=${skill.files} bytes=${skill.bytes} ${skill.approval}`,
		),
		...refused.map((item) => `  skill refused ${item.uri ?? item.name ?? "(unnamed)"} (${item.kind}: ${item.reason})`),
		...(listing.truncated ? [`  skills: the listing stopped at PanCode's cap; ${server.id} serves more`] : []),
		...(skills.length === 0 && refused.length === 0 ? ["  skills: none listed"] : []),
	];
	return {
		data: {
			directoryRead: access.transport.settings?.directoryRead === true,
			ttlMs: listing.ttlMs,
			truncated: listing.truncated,
			skills,
			refused,
		},
		lines,
	};
}

interface McpSurfaceApprovalOptions extends McpTrustOptions {
	id: string;
	/** The reviewed digest; the served surface is recorded only when it matches. */
	hash?: string;
	/** Record the served surface without a digest, as an operator at a terminal does. */
	record?: boolean;
}

/**
 * `trust <id> --surface`: launch one trusted server the way the gateway does,
 * show the tool surface it serves and record it as approved when asked to.
 * Nothing is recorded for a server that failed to list, and a reviewed digest
 * that differs from the served one records nothing.
 */
async function mcpSurfaceOutput(options: McpSurfaceApprovalOptions): Promise<McpCommandOutput> {
	const { id } = options;
	const fail = (message: string, data: Record<string, unknown> = {}): McpCommandOutput => ({
		code: 1,
		text: `mcp trust ${id} --surface: ${message}`,
		data: { ok: false, message, ...data },
	});
	const trustOptions = {
		cwd: options.cwd,
		...(options.configDir ? { configDir: options.configDir } : {}),
		...(options.builtin !== undefined ? { builtin: options.builtin } : {}),
	};
	const server = resolveMcpServers(trustOptions).servers.find((entry) => entry.id === id);
	if (server === undefined) return fail(`no declared MCP server with id '${id}'`);
	if (server.scope === "builtin") return fail(mcpBuiltinTrustRefusal(id));
	if (server.trust.status !== "trusted")
		return fail(`server '${id}' is ${server.trust.status}; approve its launch first: pancode mcp trust ${id}`);
	const [{ createMcpCapabilitySource }, { createRegistry }, { createWorkerSafety }] = await Promise.all([
		import("../tools/gateway/mcp-capabilities.js"),
		import("../tools/registry.js"),
		import("../engine/worker-tools.js"),
	]);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: options.cwd }) });
	const source = createMcpCapabilitySource({ ...trustOptions, registry, attended: false });
	let served: McpSurface | null;
	try {
		const refreshed = await source.refresh(id);
		served = source.servedSurface(id);
		if (served === null) return fail(refreshed.reason ?? "the server listed no tools");
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	} finally {
		await source.close();
	}
	const tools = Object.entries(served.tools).map(([name, sha256]) => ({ name, sha256 }));
	const toolLines = tools.map((tool) => `  ${tool.name} ${tool.sha256}`);
	const before = judgeMcpSurface(server, currentMcpSurfaceApproval(server, trustOptions), served);
	const report = (status: McpSurfaceStatus): McpSurfaceReport =>
		status.status === "approved" ? status : { ...status, remedy: mcpSurfaceRemedy(id) };
	if (options.hash !== undefined && options.hash !== served.digest)
		return fail(`served surface ${served.digest} differs from the reviewed ${options.hash}; nothing was recorded`, {
			recorded: false,
			surface: report(before),
			tools,
		});
	if (before.status === "approved" || (options.hash === undefined && options.record !== true)) {
		const hint =
			before.status === "approved"
				? "surface already approved"
				: `not recorded; to approve this surface: pancode mcp trust ${id} --surface --hash ${served.digest}`;
		return {
			code: 0,
			text: [`mcp: ${id} surface ${served.digest}`, ...toolLines, hint].join("\n"),
			data: { ok: true, recorded: false, surface: report(before), tools },
		};
	}
	const approved = approveMcpSurface({ ...trustOptions, id, surface: served, expectedDigest: served.digest });
	if (!approved.ok) return fail(approved.message, { recorded: false, surface: report(before), tools });
	const after = judgeMcpSurface(server, approved.surface, served);
	return {
		code: 0,
		text: [`mcp: ${id} surface ${served.digest}`, ...toolLines, `approved surface of ${id}`].join("\n"),
		data: { ok: true, recorded: true, surface: report(after), tools, record: approved.surface },
	};
}

export interface McpSkillApprovalOptions extends McpTrustOptions {
	id: string;
	/** The skill as the operator named it: its uri, the name PanCode shows, or its bare name. */
	skill: string;
	/** The reviewed manifest digest; the served version is recorded only when it matches. */
	hash?: string;
	/** Record the served version without a digest, as an operator at a terminal does. */
	record?: boolean;
}

/**
 * `trust <id> --skill <name>`: launch one trusted server, list its skills
 * live, fetch the named one with skills/get and show its manifest (every file
 * with size and digest, and the frontmatter), then record that exact version
 * as approved when asked to. No skill file is read. A version that changed
 * between the listing and skills/get, or differs from a reviewed --hash,
 * records nothing.
 */
export async function mcpSkillApprovalOutput(options: McpSkillApprovalOptions): Promise<McpCommandOutput> {
	const { id } = options;
	const fail = (message: string, data: Record<string, unknown> = {}): McpCommandOutput => ({
		code: 1,
		text: `mcp trust ${id} --skill: ${message}`,
		data: { ok: false, message, ...data },
	});
	const trustOptions = {
		cwd: options.cwd,
		...(options.configDir ? { configDir: options.configDir } : {}),
		...(options.builtin !== undefined ? { builtin: options.builtin } : {}),
	};
	const server = resolveMcpServers(trustOptions).servers.find((entry) => entry.id === id);
	if (server === undefined) return fail(`no declared MCP server with id '${id}'`);
	if (server.trust.status !== "trusted")
		return fail(`server '${id}' is ${server.trust.status}; approve its launch first: pancode mcp trust ${id}`);
	const [{ createMcpCapabilitySource }, { createRegistry }, { createWorkerSafety }] = await Promise.all([
		import("../tools/gateway/mcp-capabilities.js"),
		import("../tools/registry.js"),
		import("../engine/worker-tools.js"),
	]);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: options.cwd }) });
	const source = createMcpCapabilitySource({ ...trustOptions, registry, attended: false });
	let entry: McpSkillEntry;
	let displayName: string;
	try {
		const access = await source.skillAccess(id, { relist: true });
		if (access.transport === null) return fail(boundedMcpSkillText(access.reason, 4096));
		const refused = access.listing.refused.find((item) => item.uri === options.skill || item.name === options.skill);
		const found = findMcpSkill(id, access.listing.skills, options.skill);
		if (found.entry === null) {
			return fail(
				refused !== undefined
					? `${boundedMcpSkillText(refused.uri ?? refused.name ?? options.skill, 256)} is not loadable (${refused.kind}: ${boundedMcpSkillText(refused.reason)}); nothing was recorded`
					: found.reason,
			);
		}
		displayName = found.displayName;
		const got = await getMcpSkill(access.transport, found.entry.uri);
		if (!got.ok) return fail(`skills/get refused ${displayName}: ${got.kind}: ${boundedMcpSkillText(got.reason)}`);
		if (got.entry.manifestDigest !== found.entry.manifestDigest)
			return fail(
				`${displayName} changed between skills/list (${found.entry.manifestDigest}) and skills/get (${got.entry.manifestDigest}); nothing was recorded`,
			);
		entry = got.entry;
	} catch (error) {
		return fail(boundedMcpSkillText(error instanceof Error ? error.message : String(error), 4096));
	} finally {
		await source.close();
	}
	const files = entry.resources.map((file) => ({
		path: mcpSkillRelativePath(entry, file.uri),
		uri: file.uri,
		size: file.size,
		digest: file.digest,
	}));
	const skill = {
		name: displayName,
		uri: entry.uri,
		manifestDigest: entry.manifestDigest,
		bytes: entry.totalBytes,
		files,
		frontmatter: entry.frontmatter,
	};
	const lines = [
		`mcp: ${id} skill ${displayName} ${boundedMcpSkillText(entry.uri, 512)}`,
		`  manifest ${entry.manifestDigest} (${files.length} files, ${entry.totalBytes} bytes)`,
		...files.map((file) => `  ${boundedMcpSkillText(file.path, 512)} ${file.size} ${file.digest}`),
		...Object.entries(entry.frontmatter).map(
			([field, value]) =>
				`  frontmatter ${boundedMcpSkillText(field, 64)}: ${boundedMcpSkillText(typeof value === "string" ? value : JSON.stringify(value))}`,
		),
	];
	const served = { uri: entry.uri, name: entry.name, manifestDigest: entry.manifestDigest };
	const before = judgeMcpSkillApproval(currentMcpSkillApproval(server, entry.uri, trustOptions), server, served);
	const argument = displayName.slice(id.length + 1);
	const report = (status: McpSkillApprovalStatus) => ({
		status: status.status,
		approvedDigest: status.status === "unapproved" ? null : status.approval.manifestDigest,
		...(status.status === "changed" ? { reason: status.reason } : {}),
	});
	if (options.hash !== undefined && options.hash !== entry.manifestDigest)
		return fail(
			`served manifest ${entry.manifestDigest} differs from the reviewed ${options.hash}; nothing was recorded`,
			{
				recorded: false,
				skill,
				approval: report(before),
			},
		);
	if (before.status === "approved" || (options.hash === undefined && options.record !== true)) {
		const hint =
			before.status === "approved"
				? "skill already approved"
				: `not recorded; to approve this version: pancode mcp trust ${id} --skill ${argument} --hash ${entry.manifestDigest}`;
		return {
			code: 0,
			text: [...lines, hint].join("\n"),
			data: { ok: true, recorded: false, skill, approval: report(before) },
		};
	}
	const approved = approveMcpSkill({
		...trustOptions,
		id,
		skill: { ...served, files: files.length, bytes: entry.totalBytes },
	});
	if (!approved.ok) return fail(approved.message, { recorded: false, skill, approval: report(before) });
	return {
		code: 0,
		text: [...lines, `approved skill ${displayName} of ${id}`].join("\n"),
		data: {
			ok: true,
			recorded: true,
			skill,
			approval: report(judgeMcpSkillApproval(approved.approval, server, served)),
			record: approved.approval,
		},
	};
}

/**
 * `untrust <id> --skill <name>`: withdraw the approval of one skill, named by
 * its uri or by the name it was approved under. Nothing is launched.
 */
export function mcpSkillRevokeOutput(options: McpTrustOptions & { id: string; skill: string }): McpCommandOutput {
	const { id } = options;
	const fail = (message: string): McpCommandOutput => ({
		code: 1,
		text: `mcp untrust ${id} --skill: ${message}`,
		data: { ok: false, message },
	});
	const server = resolveMcpServers(options).servers.find((entry) => entry.id === id);
	const approvals = server !== undefined ? mcpSkillApprovalsFor(server, options) : [];
	const local = options.skill.startsWith(`${id}:`) ? options.skill.slice(id.length + 1) : options.skill;
	const named = approvals.filter((approval) => approval.uri === options.skill || approval.name === local);
	if (named.length > 1)
		return fail(
			`${named.length} approved skills of ${id} are named ${boundedMcpSkillText(local, 256)}; name one by its uri: ${named.map((approval) => boundedMcpSkillText(approval.uri, 512)).join(", ")}`,
		);
	const uri = named[0]?.uri ?? options.skill;
	const result = revokeMcpSkill({ ...options, id, uri });
	if (!result.ok) return fail(result.message);
	return {
		code: 0,
		text: `mcp: skill ${boundedMcpSkillText(uri, 512)} of ${id} ${result.removed ? "no longer approved" : "had no approval in this project"}`,
		data: { ok: true, removed: result.removed, uri },
	};
}

/** `trust <id> --skill <name> [--hash <digest>]` or `untrust <id> --skill <name>`, or the usage error that refuses it. */
function parseSkillArgs(argv: ReadonlyArray<string>): { id: string; skill: string; hash?: string } | string {
	const [command, id, ...rest] = argv;
	const usage =
		command === "untrust"
			? "usage: pancode mcp untrust <id> --skill <name|uri>"
			: "usage: pancode mcp trust <id> --skill <name|uri> [--hash <manifest digest>]";
	if (id === undefined || id.startsWith("-")) return usage;
	let skill: string | undefined;
	let hash: string | undefined;
	for (let index = 0; index < rest.length; index += 2) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (value === undefined || value.startsWith("--")) return usage;
		if (flag === "--skill" && skill === undefined) skill = value;
		else if (flag === "--hash" && hash === undefined && command === "trust") {
			const digest = value.startsWith("sha256:") ? value : `sha256:${value}`;
			if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) return "--hash takes the manifest digest, sha256:<64 lowercase hex>";
			hash = digest;
		} else return `${usage}; --skill takes no launch flags`;
	}
	if (skill === undefined) return usage;
	return { id, skill, ...(hash !== undefined ? { hash } : {}) };
}

/** `trust <id> --surface [--hash <sha256>]`, or the usage error that refuses it. */
function parseSurfaceArgs(argv: ReadonlyArray<string>): { id: string; hash?: string } | string {
	const usage = "usage: pancode mcp trust <id> --surface [--hash <sha256>]";
	const [, id, ...rest] = argv;
	if (id === undefined || id.startsWith("-")) return usage;
	let surface = false;
	let hash: string | undefined;
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index];
		if (flag === "--surface" && !surface) {
			surface = true;
			continue;
		}
		const value = rest[index + 1];
		if (flag === "--hash" && hash === undefined && value !== undefined) {
			if (!/^[a-f0-9]{64}$/.test(value)) return "--hash takes the 64-character lowercase hex surface digest";
			hash = value;
			index += 1;
			continue;
		}
		return `${usage}; --surface takes no launch flags`;
	}
	if (!surface) return "--hash applies only to trust --surface";
	return { id, ...(hash !== undefined ? { hash } : {}) };
}

export async function runMcpCommand(argv: ReadonlyArray<string>): Promise<number> {
	const separator = argv.indexOf("--");
	const head = separator === -1 ? argv : argv.slice(0, separator);
	const tail = separator === -1 ? [] : argv.slice(separator);
	if (head.includes("--help") || head.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = head.includes("--json");
	if (argv[0] === "test") {
		const parsed = parseMcpTestArgs(argv.filter((arg) => arg !== "--json"));
		const result =
			typeof parsed === "string"
				? { code: 2, text: parsed, data: { ok: false, message: parsed } }
				: await mcpTestOutput(parsed.id, parsed.calls);
		if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
		else if (result.code !== 0 && !("protocolVersion" in (result.data as object))) printError(result.text);
		else process.stdout.write(`${result.text}\n`);
		return result.code;
	}
	if (argv[0] === "login") {
		const result = await mcpLoginOutput(argv.filter((arg) => arg !== "--json"));
		if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
		else if (result.code !== 0) printError(result.text);
		else process.stdout.write(`${result.text}\n`);
		return result.code;
	}
	const interactive = !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
	if ((argv[0] === "trust" || argv[0] === "untrust") && argv.includes("--skill")) {
		const parsed = parseSkillArgs(argv.filter((arg) => arg !== "--json"));
		const result =
			typeof parsed === "string"
				? { code: 2, text: parsed, data: { ok: false, message: parsed } }
				: argv[0] === "untrust"
					? mcpSkillRevokeOutput({ cwd: process.cwd(), id: parsed.id, skill: parsed.skill })
					: await mcpSkillApprovalOutput({ cwd: process.cwd(), ...parsed, record: interactive });
		if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
		else if (result.code !== 0) printError(result.text);
		else process.stdout.write(`${result.text}\n`);
		return result.code;
	}
	if (argv[0] === "trust" && (argv.includes("--surface") || argv.includes("--hash"))) {
		const parsed = parseSurfaceArgs(argv.filter((arg) => arg !== "--json"));
		const result =
			typeof parsed === "string"
				? { code: 2, text: parsed, data: { ok: false, message: parsed } }
				: await mcpSurfaceOutput({ cwd: process.cwd(), ...parsed, record: interactive });
		if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
		else if (result.code !== 0) printError(result.text);
		else process.stdout.write(`${result.text}\n`);
		return result.code;
	}
	let refreshFailure: string | null = null;
	const served = new Map<string, McpSurface>();
	let live = new Map<string, McpLiveStatus>();
	const refresh =
		argv[0] === "list" &&
		argv.includes("--refresh") &&
		argv.slice(1).every((arg) => arg === "--refresh" || arg === "--json");
	if (refresh) {
		const [{ createMcpCapabilitySource }, { createRegistry }, { createWorkerSafety }] = await Promise.all([
			import("../tools/gateway/mcp-capabilities.js"),
			import("../tools/registry.js"),
			import("../engine/worker-tools.js"),
		]);
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }) });
		const source = createMcpCapabilitySource({ cwd: process.cwd(), registry });
		try {
			const listing = await source.list();
			for (const server of listing.servers) {
				const surface = source.servedSurface(server.id);
				if (surface !== null) served.set(server.id, surface);
			}
			live = mcpLiveStatuses(listing.servers);
			refreshFailure =
				listing.servers
					.filter((server) => server.status === "failed" || server.status === "needs-auth")
					.map((server) => `${server.id}: ${server.reason}`)
					.join("; ") || null;
		} finally {
			await source.close();
		}
	}
	const result = mcpCommandOutput(
		[...head.filter((arg) => arg !== "--json" && (!refresh || arg !== "--refresh")), ...tail],
		{ cwd: process.cwd() },
		served,
		live,
	);
	// Launch trust approves a process; the tool surface it serves is a second
	// approval. At a terminal the operator sees it now and it is recorded.
	if (argv[0] === "trust" && result.code === 0) {
		const id = argv[1] as string;
		if (interactive) {
			const surface = await mcpSurfaceOutput({ cwd: process.cwd(), id, record: true });
			// Launch trust is recorded either way; a surface that could not be listed is reported, not fatal.
			result.text += `\n${surface.text}`;
		} else if (!json) {
			const server = resolveMcpServers({ cwd: process.cwd() }).servers.find((entry) => entry.id === id);
			if (server !== undefined && currentMcpSurfaceApproval(server, { cwd: process.cwd() }) === undefined)
				result.text += `\nsurface not approved: no tool of ${id} runs until pancode mcp trust ${id} --surface`;
		}
	}
	if (refreshFailure !== null) {
		result.code = 1;
		(result.data as { trustDiagnostics: string[] }).trustDiagnostics.push(refreshFailure);
	}
	if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
	// List prints its own failing rows on stdout; a usage error goes to stderr like every other verb's (C3).
	else if (result.code && (argv[0] !== "list" || result.code === 2)) printError(result.text);
	else process.stdout.write(`${result.text}\n`);
	return result.code;
}
