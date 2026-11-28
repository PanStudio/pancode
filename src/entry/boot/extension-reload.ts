// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import type { ContextContract } from "../../domains/context/contract.js";
import type { ExtensionsContract } from "../../domains/extensions/contract.js";
import { createExtensionRuntimeHookBridge } from "../../domains/extensions/index.js";
import type { MiddlewareRegistrar } from "../../domains/middleware/contract.js";
import { committedPluginSnapshot } from "../../domains/plugins/index.js";
import { createSessionCodeConsent } from "../../domains/safety/session-code-consent.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type {
	WorkerExtensionHook,
	WorkerHookEffect,
	WorkerHookRequest,
	WorkerHookRun,
} from "../../lib/worker-wire/protocol.js";
import type { ChatLoop } from "../../session-control/chat-loop.js";
import type { formatExtensionReloadNotice } from "../../session-control/slash-commands.js";
import type { ToolBootstrapHandle } from "../../tools/bootstrap.js";
import { createFileMutationObserver } from "../../tools/observers.js";
import type { BootOptions } from "../boot-options.js";
import { createExtensionReloadCoordinator, extensionHookReceiptSink } from "../extension-reload.js";
import { reloadPluginResourcesAndNotify } from "../plugin-reload.js";
import { createReloadClasses } from "../reload-classes.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootExtensionsCells {
	readonly chat: ChatLoop;
	readonly toolBootstrap: ToolBootstrapHandle;
	workerHookSource: {
		declarations(): ReadonlyArray<WorkerExtensionHook>;
		dropped(): ReadonlyArray<WorkerExtensionHook>;
		evaluate(request: WorkerHookRequest, run: WorkerHookRun): Promise<ReadonlyArray<WorkerHookEffect>>;
		notify(message: string): void;
	} | null;
}

/** What wireBootExtensions reads from the names bootOrchestrator built before it. */
export interface BootExtensionsInput {
	bus: TelemetryHub;
	config: ConfigContract | undefined;
	contextDomain: ContextContract | undefined;
	extensions: ExtensionsContract | undefined;
	formatExtensionReloadNotice: typeof formatExtensionReloadNotice;
	initialNotices: string[];
	interactive: boolean;
	middlewareRegistrar: MiddlewareRegistrar;
	options: BootOptions;
	session: SessionContract | undefined;
	cells: BootExtensionsCells;
}

/**
 * Stage P5: the per-session code consent, the codewiki's file mutation observer, the reload classes, and the extension
 * reload coordinator that owns user hooks and publishes the worker hook source.
 */
export function wireBootExtensions(input: BootExtensionsInput) {
	const {
		bus,
		config,
		contextDomain,
		extensions,
		formatExtensionReloadNotice,
		initialNotices,
		interactive,
		middlewareRegistrar,
		options,
		session,
	} = input;
	const { cells } = input;
	// The main agent's first test runner in an attended session asks before it
	// runs repository code, whoever wrote that code (#377 follow-up). The
	// consent is per session: a park or a resume clears it. A headless run
	// denies every ask, so it keeps #377's allow.
	const sessionCodeConsent = createSessionCodeConsent({ headless: options.headless !== undefined });
	bus.subscribe("session.parked", () => sessionCodeConsent.reset());
	bus.subscribe("session.reattached", () => sessionCodeConsent.reset());
	// The codewiki refreshes the written paths when the context domain is loaded.
	middlewareRegistrar.registerHook(
		createFileMutationObserver(({ paths }) => {
			contextDomain?.noteFileChanges(paths);
		}),
	);
	// User-defined hooks: extensions and the project (.pancode/hooks.yaml,
	// .pancode/hooks.local.yaml) declare a conservative, receipted hook set on the
	// same effect machinery. A hook may add effects (including request block_tool)
	// but cannot grant a permission safety would deny. The protected-artifact
	// guard follows them to consume protect_path before tool execution.
	// The coordinator is the only writer of the "user-hooks" owner and the only
	// caller of the extensions reload; it publishes the extension generation
	// and the hook registrations with two adjacent assignments on one stack
	// and reloads plugin resources only after both. The boot generation is
	// published here too (the extensions bundle publishes nothing at start),
	// so no consumer ever sees extension resources paired with hooks from a
	// different generation. The owner slot is anchored here, so user hooks
	// keep evaluating before the protection consumer and assessors below.
	let bootHookNotices = true;
	const reloadPlugins = () =>
		reloadPluginResourcesAndNotify(process.cwd(), (event) => bus.emit("plugin.reloaded", event));
	const chatIdle = () => !cells.chat.isStreaming() && cells.chat.turnPreparation().phase === "idle";
	const reloadClasses = createReloadClasses({
		config,
		bus,
		cwd: () => process.cwd(),
		hub: () => committedPluginSnapshot(process.cwd()),
		reloadHub: reloadPlugins,
		extensions: () => extensions?.snapshot()?.packages ?? [],
		mcp: { source: () => cells.toolBootstrap.mcpCapabilities, idle: chatIdle },
	});
	// Every main session hosts api 2 runtimes: the TUI itself, a headless run
	// and ACP through `startExtensionHost`. Workers never do.
	const runtimeHooks = createExtensionRuntimeHookBridge({ sessionId: () => session?.current()?.id ?? null });
	const extensionReload = createExtensionReloadCoordinator({
		extensions,
		middleware: middlewareRegistrar,
		runtimeHooks,
		// The gateway is registered after this coordinator; the lookup runs at call time.
		mcpOwner: (tool) => cells.toolBootstrap.mcpCapabilities?.ownerIdOf(tool) ?? null,
		cwd: () => process.cwd(),
		...(options.trustCardNotices !== undefined ? { holdBootTrustNotices: true } : {}),
		recordReceipt: extensionHookReceiptSink(() => session?.current()?.id),
		report: (line) => {
			if (reloadClasses.captureIssue(line)) return;
			if (!bootHookNotices) bus.emit("extension.load_failed", { message: line });
			else if (interactive) initialNotices.push(line);
			else process.stderr.write(`${line}\n`);
		},
		onCommitted: () => {
			if (!reloadClasses.active) reloadPlugins();
		},
	});
	cells.workerHookSource = extensionReload.workerHooks;
	const commitExtensionHooks = () => {
		const outcome = extensionReload.reload();
		for (const issue of outcome.diagnostics.entries) reloadClasses.captureIssue(`${issue.type}: ${issue.message}`);
		reloadClasses.captureExtensionCommit(formatExtensionReloadNotice(outcome)[1]);
		return outcome;
	};
	return {
		chatIdle,
		commitExtensionHooks,
		extensionReload,
		reloadClasses,
		reloadPlugins,
		runtimeHooks,
		sessionCodeConsent,
		extensionsState: {
			get bootHookNotices() {
				return bootHookNotices;
			},
			set bootHookNotices(value: typeof bootHookNotices) {
				bootHookNotices = value;
			},
		},
	};
}
