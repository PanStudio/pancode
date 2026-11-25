// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { ClientCredential } from "../../contracts/auth.js";
import type { Operation } from "../../contracts/operations.js";
import type { PermissionTimers } from "../../server/acp/permissions.js";
import { Supervisor } from "../../server/acp/supervisor.js";
import { createApp } from "../../server/app.js";
import { parse } from "../../server/http/validate.js";
import { launcherProof } from "../../server/launch-proof.js";
import { getVersionInfo, runningBuildId } from "../../server/pancode/http-shims.js";
import { ArenaService } from "../../server/services/arena.js";
import { CliRunner } from "../../server/services/cli-runner.js";
import { EventHub } from "../../server/services/event-hub.js";
import { EvidenceService } from "../../server/services/evidence.js";
import { FleetService } from "../../server/services/fleet.js";
import { HubService } from "../../server/services/hub.js";
import { MachineAttachments } from "../../server/services/machine-attach.js";
import { OperationRegistry } from "../../server/services/operations.js";
import { ProblemReportsService } from "../../server/services/problem-reports.js";
import { ProjectReviewService } from "../../server/services/project-review.js";
import { ReportsService } from "../../server/services/reports.js";
import { ResearchService } from "../../server/services/research.js";
import { SessionService } from "../../server/services/sessions.js";
import { SettingsService, turnCapacitySetting } from "../../server/services/settings.js";
import { SetupService } from "../../server/services/setup.js";
import { SystemService } from "../../server/services/system.js";
import { TargetsService } from "../../server/services/targets-cli.js";
import { TelemetryService } from "../../server/services/telemetry.js";
import { ToolchainService } from "../../server/services/toolchain.js";
import { TraceService } from "../../server/services/traces.js";
import { WorkspaceService } from "../../server/services/workspaces.js";
import { AppFiles } from "../../server/state/files.js";
import { WorkerHost } from "../../server/worker/host.js";
import type { WorkerSettings } from "../../server/worker/protocol.js";
import { sourceCli } from "./hub-fixture.js";
import { scratchHome } from "./scratch-home.js";
import { closeWithTest } from "./test-cleanup.js";

type HarnessOptions = Parameters<typeof boot>[1];

/**
 * Boots the server's services in process, with two domain lanes. Inside a test the harness also closes itself
 * when that test ends: a test its timeout cancelled while the lanes booted never reached its own
 * `t.after(h.close)`, and the lanes left running stalled test:gui.
 */
export function harness(settings: WorkerSettings = {}, options: HarnessOptions = {}) {
	const booting = boot(settings, options);
	closeWithTest(async () => (await booting.catch(() => undefined))?.close());
	return booting;
}

async function boot(
	settings: WorkerSettings = {},
	options: {
		scenario?: string;
		env?: NodeJS.ProcessEnv;
		snapshotHold?: () => Promise<void>;
		permissionTimers?: PermissionTimers;
		parkAfterMs?: number;
		origin?: () => string;
		clientDir?: string;
		pwa?: boolean;
		/**
		 * false: no domain lanes. A test that drives only the supervisor and session routes never calls them, and
		 * booting two lanes costs seconds of CPU per harness. A call reaching one rejects.
		 */
		lanes?: boolean;
	} = {},
) {
	const home = await scratchHome();
	const env = { ...home.env, ...options.env };
	// CLI children run the checkout's own source, never whatever `pancode` is on PATH. A test may still point
	// them at a fixture through options.env. The domain lanes get the same env, as the server gives its lanes the
	// CliRunner's: the reads lane's machine registry read spawns the CLI too, and without the override it found no
	// CLI on a runner with neither a root dist/ nor pancode on PATH and answered 503.
	const cliEnv = { PANCODE_WEB_CLI: sourceCli, ...env };
	const lane = (name: "reads" | "ops") =>
		options.lanes === false
			? (absentLane(name) as unknown as WorkerHost)
			: new WorkerHost(name, { fixture: true, ...settings }, cliEnv);
	const reads = lane("reads"),
		ops = lane("ops");
	const hub = new EventHub(),
		operations = new OperationRegistry(hub);
	const files = new AppFiles(join(home.path, "state")),
		workspaces = new WorkspaceService(files);
	const supervisor = new Supervisor(
		workspaces,
		files,
		hub,
		{
			...env,
			PANCODE_WEB_CLI: fileURLToPath(new URL("../fixtures/acp-fixture-child.mjs", import.meta.url)),
			PANCODE_WEB_FIXTURE_SCENARIO: options.scenario ?? "text",
			PANCODE_WEB_FIXTURE_LOG: join(home.path, "acp.jsonl"),
		},
		4,
		options.permissionTimers,
		undefined,
		options.parkAfterMs,
	);
	await supervisor.reconcile();
	const cli = new CliRunner(cliEnv);
	const sessions = new SessionService(supervisor, workspaces, reads, cli);
	// Wired as the server wires it: a written turn limit is re-read from the user layer and applied.
	const settingsService: SettingsService = new SettingsService(reads, workspaces, ops, () =>
		realpath(join(home.path, "state"))
			.then((cwd) => settingsService.controlsAt(cwd))
			.then((controls) => {
				const capacity = turnCapacitySetting(controls);
				if (capacity !== undefined) supervisor.setTurnCapacity(capacity);
			}),
	);
	const setup = new SetupService(reads, cliEnv, workspaces);
	// Wired as the server wires it, so the machine switcher reads the scratch home's (empty) node registry.
	const attachments = new MachineAttachments({
		endpoints: async () =>
			reads.call("machines.endpoints", { cwd: await realpath(join(home.path, "state")) }, { deadlineMs: 65_000 }),
		local: () => ({ pancode: getVersionInfo().pancode, build: runningBuildId }),
		hub,
		env,
	});
	const research = new ResearchService(cli, workspaces, operations, cliEnv);
	const app = createApp({
		token: "test-token",
		origin: options.origin ?? (() => "http://127.0.0.1:4317"),
		hub,
		operations,
		toolchain: new ToolchainService(reads, ops, operations, hub),
		attachments,
		traces: new TraceService(reads),
		telemetry: new TelemetryService(reads, (id) => supervisor.knows(id)),
		settings: settingsService,
		setup,
		fleet: new FleetService(reads),
		system: new SystemService(reads, workspaces, ops),
		hubService: new HubService(reads, cli, workspaces, ops),
		review: new ProjectReviewService(cli, workspaces),
		reports: new ReportsService(cli, workspaces),
		problemReports: new ProblemReportsService(ops, workspaces),
		arena: new ArenaService(cli, workspaces, operations, cliEnv),
		research,
		evidence: new EvidenceService(reads, cli, workspaces, operations),
		targets: new TargetsService(cli, workspaces, settingsService, operations, supervisor),
		sessions,
		idle: () =>
			!(operations.activeCount || cli.activeCount || setup.busy || supervisor.busy || supervisor.hasOpenSessions),
		...(options.snapshotHold ? { snapshotHold: options.snapshotHold } : {}),
		diagnostics: true,
		pwa: options.pwa ?? false,
		...(options.clientDir ? { clientDir: options.clientDir } : {}),
	});
	const base = "http://127.0.0.1:4317";
	/** Open a client as a launcher does, by proving the launch token; null when the listener refuses the exchange. */
	const exchange = async (label = "Test client", resume?: string): Promise<ClientCredential | null> => {
		const post = (path: string, body: unknown) =>
			app.request(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
				body: JSON.stringify(body),
			});
		const issued = await post("/api/auth/challenge", {});
		if (issued.status !== 200) return null;
		const { challenge } = (await issued.json()) as { challenge: string };
		const response = await post("/api/auth/clients", {
			label,
			...(resume ? { resume } : {}),
			challenge,
			proof: launcherProof("test-token", challenge, 4317),
		});
		return response.status === 200 ? ((await response.json()) as ClientCredential) : null;
	};
	/** Requests as one client. `credential` resolves lazily so a harness that never calls the API never exchanges. */
	const as = (credential: () => Promise<string>) => {
		const request = async (path: string, init: RequestInit = {}) =>
			app.request(`${base}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${await credential()}`, ...init.headers },
			});
		const post = (path: string, body: unknown = {}, key: string = crypto.randomUUID()) =>
			request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Idempotency-Key": key },
				body: JSON.stringify(body),
			});
		return { request, post };
	};
	let primary: Promise<ClientCredential | null> | undefined;
	// A listener that refuses the exchange (a wrong origin, say) still answers each request with its refusal.
	const { request, post } = as(async () => {
		primary ??= exchange();
		return (await primary)?.credential ?? "unissued";
	});
	/** A second window: its own client id and credential against the same server. */
	const client = async (label?: string, resume?: string) => {
		const issued = await exchange(label, resume);
		if (!issued) throw new Error("The test server refused the launch token exchange.");
		return { ...issued, ...as(async () => issued.credential) };
	};
	let closing: Promise<void> | undefined;
	const close = () =>
		(closing ??= (async () => {
			await Promise.all([supervisor.shutdown(), research.close(), cli.close(), setup.close(), attachments.stopAll()]);
			await Promise.all([reads.close(), ops.close()]);
			await home.close();
		})());
	// A test's own budgets start once both domain lanes listen. A cold lane spends
	// seconds evaluating root src/** first, and a request that waited out that boot
	// was charged for it against WorkerHost's 30 s queue deadline. Tests of cold
	// lanes construct a WorkerHost themselves.
	try {
		await Promise.all([reads.ready(), ops.ready()]);
	} catch (error) {
		await close();
		throw error;
	}
	return {
		home,
		files,
		workspaces,
		sessions,
		supervisor,
		/** Settles once the turn limit a settings write changed has been applied. */
		reads,
		ops,
		cli,
		hub,
		operations,
		research,
		app,
		request,
		post,
		exchange,
		client,
		close,
	};
}
/** A stand-in for a lane the harness did not boot: ready and close settle, every other method rejects. */
function absentLane(name: string): object {
	return new Proxy(
		{},
		{
			get: (_target, key) =>
				key === "ready" || key === "close"
					? async () => undefined
					: key === "then"
						? undefined
						: async () => {
								throw new Error(`This harness has no ${name} lane; it was built with lanes: false.`);
							},
		},
	);
}
export async function json<S extends TSchema>(response: Response, schema: S): Promise<Static<S>> {
	return parse(schema, await response.json());
}
export async function terminal(operations: OperationRegistry, id: string, timeoutMs = 4000): Promise<Operation> {
	for (let i = 0; i < Math.ceil(timeoutMs / 20); i++) {
		const record = operations.get(id);
		if (record.status !== "queued" && record.status !== "running") return record;
		await setTimeout(20);
	}
	throw new Error(`Operation did not finish within ${timeoutMs} ms.`);
}
