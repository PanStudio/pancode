// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The interactive application's extension stage: the update and operator timers' owners, the extension
 * startup gate, the operator extensions with their owner names, dev session and runtime hooks, and the
 * workspace and ambient surfaces they paint.
 */

import { getTerminationCoordinator } from "../../core/termination.js";
import { createChatTurnUsage, createTurnObservations } from "../../domains/extensions/bus-observations.js";
import { createExtensionHostServices } from "../../domains/extensions/host-services.js";
import { OperatorExtensions } from "../../domains/extensions/operator-extensions.js";
import { bindExtensionOwnerNames, extensionOwnerLabel } from "../../domains/extensions/owner-label.js";
import { BUILTIN_SLASH_NAMES } from "../../session-control/slash-commands.js";
import { runParkedInterview } from "../../tools/extension-interview.js";
import { createExtensionDevSession, type ExtensionDevSession } from "../extension-dev-session.js";
import type { InteractiveDeps } from "../interactive-deps.js";
import { formatKeyLabel } from "../keybinding-manager.js";
import { createAmbientSurfaces } from "../surfaces/ambient.js";
import { createExtensionPaneKeys } from "../surfaces/extension-pane-keys.js";
import { createWorkspaceSurfaces, WORKSPACE_LEAVE_KEY } from "../surfaces/registry.js";
import { renderView } from "../surfaces/view-renderer.js";
import type { ApplicationScope } from "./scope.js";

function isChatReadOnly(chat: InteractiveDeps["chat"]): boolean {
	return chat.toolLimits?.()?.readOnly === true || chat.currentTurnConstraints?.()?.readOnly === true;
}

function frozenExtensionTools(registry: NonNullable<InteractiveDeps["toolRegistry"]>) {
	return registry.listAll().flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : []));
}

export function createAppExtensions(scope: ApplicationScope) {
	const { deps, terminal, tui } = scope;
	const updateAbort = new AbortController();
	// One deferred package-manager update per session, armed by the update
	// monitor or by /upgrade, whichever comes first (#436). The package manager
	// replaces the install in place, so it runs only after this process has left
	// persist. A /restart keeps this process alive as the new child's guardian,
	// so a wrapper started then would wait on both for its full window.
	let deferredUpdateArmed = false;
	const armDeferredUpdate = (start: () => boolean): boolean => {
		if (deferredUpdateArmed) return false;
		deferredUpdateArmed = true;
		getTerminationCoordinator().onPersist(() => {
			if (!getTerminationCoordinator().hasExitHandoff()) start();
		});
		return true;
	};

	// The startup reload starts runtimes after the first frame, so a prompt
	// submitted as soon as the editor takes keys ran its prompt_submit and
	// before_tool hooks against no runtime and they failed open. Hook and tool
	// calls wait for that reload, as the headless and ACP host does
	// (extension-host.ts), and the reload counts the session as idle meanwhile:
	// nothing runs yet that it could swap out, and a turn parked on a hook
	// must not hold back the generation it waits for.
	let extensionStartupPending = true;
	let extensionsAwaitGeneration = (): boolean => false;
	const extensionStartup = new Promise<void>((resolve) => {
		scope.finishExtensionStartup = () => {
			extensionStartupPending = false;
			resolve();
		};
	});
	const extensionPane = createExtensionPaneKeys({
		mux: deps.extensions ? deps.mux : undefined,
		operator: () => operatorExtensions,
		keybindings: () => scope.keybindings,
		notify: (level, text, key) => scope.notify(level, text, key),
	});
	const operatorExtensions = deps.extensions
		? new OperatorExtensions({
				...(extensionPane.pane ? { pane: extensionPane.pane } : {}),
				builtinCommandNames: () => BUILTIN_SLASH_NAMES,
				services: createExtensionHostServices({
					providers: deps.providers,
					telemetry: deps.telemetry,
					session: deps.session,
					ask: (questions) => scope.overlayLifecycle.openTransientAskUserOverlayState(questions),
				}),
				sandboxUnixSockets: () => deps.getSettings?.().safety.sandboxUnixSockets ?? "block",
				readOnly: () => isChatReadOnly(deps.chat),
				context: () => ({
					workspace: process.cwd(),
					sessionId: deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
					mode: "interactive",
				}),
				isIdle: () =>
					extensionStartupPending ||
					extensionsAwaitGeneration() ||
					(!deps.chat.isStreaming() &&
						deps.chat.turnPreparation().phase === "idle" &&
						(scope.overlayLifecycle?.getState() ?? "closed") === "closed" &&
						!scope.editorSubmit?.hasActiveEditorBash()),
				list: (cwd) => deps.extensions?.list(cwd, { all: true }) ?? [],
				...(deps.reloadExtensions ? { commitHooks: deps.reloadExtensions } : {}),
				onChange: () => scope.refreshOperatorUi(),
				...(deps.toolRegistry ? { frozenTools: frozenExtensionTools(deps.toolRegistry) } : {}),
				onDiagnostic: (message) => {
					if (!deps.reloadClasses?.captureIssue(message))
						scope.notify("warning", message, "operator-extensions:observation");
				},
				// A mute fences the runtime at once; the reload that unloads it waits for idle.
				admits: (extensionId): boolean => devSession?.isMuted(extensionId) !== true,
				onReload: (result, reason) => {
					extensionPane.bindings();
					if (deps.reloadClasses?.active) return;
					if (result.status === "deferred") return;
					const failed = result.status === "rejected" || result.degraded === undefined;
					const degraded = (result.degraded ?? 0) > 0;
					if (reason !== "reload" && !failed && !degraded) return;
					scope.notify(failed ? "error" : degraded ? "warning" : "info", result.message, "operator-extensions:reload");
				},
			})
		: undefined;
	// Every extension surface names its owner by the installed package's name. The
	// inventory is read from disk, so the names are re-read at most every two
	// seconds rather than on every painted frame.
	let ownerNames: { at: number; names: Map<string, string> } = { at: 0, names: new Map() };
	bindExtensionOwnerNames(
		deps.extensions
			? (extensionId) => {
					const now = Date.now();
					if (now - ownerNames.at > 2000) {
						const list = deps.extensions?.list(process.cwd(), { all: true }) ?? [];
						ownerNames = {
							at: now,
							names: new Map(list.filter((entry) => entry.effective).map((entry) => [entry.id, entry.name])),
						};
					}
					return ownerNames.names.get(extensionId);
				}
			: undefined,
	);
	const turnObservations = operatorExtensions
		? createTurnObservations((observation) => operatorExtensions.observeV2(observation))
		: undefined;
	// A turn_end carries the provider-reported usage every session host folds alike; the turn summary says how it ended.
	const turnUsage = turnObservations ? createChatTurnUsage() : undefined;
	// The dev scope is a terminal concept: only this surface sets the overlay,
	// so headless runs, ACP and workers never load a package under development.
	const devSession: ExtensionDevSession | undefined =
		operatorExtensions && deps.extensions
			? createExtensionDevSession({
					extensions: deps.extensions,
					operator: operatorExtensions,
					cwd: () => process.cwd(),
					isIdle: () =>
						!deps.chat.isStreaming() &&
						deps.chat.turnPreparation().phase === "idle" &&
						(scope.overlayLifecycle?.getState() ?? "closed") === "closed" &&
						!scope.editorSubmit?.hasActiveEditorBash(),
					ask: (questions, options) => scope.overlayLifecycle.openTransientAskUserOverlayState(questions, options),
					notify: (level, text) => scope.notify(level, text, "operator-extensions:dev"),
				})
			: undefined;
	if (operatorExtensions) extensionsAwaitGeneration = () => operatorExtensions.v2.awaitingGeneration;
	const extensionsSettled = <T>(run: () => Promise<T>): Promise<T> =>
		extensionStartup.then(() => operatorExtensions?.v2.whenLive()).then(run, run);
	if (operatorExtensions)
		deps.runtimeHooks?.bind({
			hook: (extensionId, event, timeoutMs, signal) =>
				extensionsSettled(() => operatorExtensions.hook(extensionId, event, timeoutMs, signal)),
			notify: (message) => scope.notify("warning", message, "operator-extensions:hook"),
			advise: (message, key) => scope.notify("info", message, `operator-extensions:advice:${key}`),
			observeTurnStart: (text) => turnObservations?.turnStart(text),
			tool: (extensionId, name, input, signal) =>
				extensionsSettled(() => operatorExtensions.tool(extensionId, name, input, signal)),
			// A tool's interview is asked like the model's own question, so a
			// permission card preempts it and it resumes afterwards.
			interview: (extensionId, interview, signal) =>
				runParkedInterview(
					{
						ask: (questions, options) => scope.overlayLifecycle.openAskUserOverlayState(questions, options),
						renderIntro: (view, width) => renderView(view, width).lines,
					},
					interview,
					{ extensionId, title: extensionId },
					// The closing cancel still reaches the handler after an abort.
					(answer) => operatorExtensions.interview(extensionId, answer, answer.nav === "cancel" ? undefined : signal),
					signal,
				),
		});
	const workspaceSurfaces = operatorExtensions
		? createWorkspaceSurfaces({
				model: operatorExtensions.surface,
				tui,
				skinFor: (active) => operatorExtensions.skinFor(active.extensionId, active.workspaceId),
				// Read at render time only while a workspace is active, after the presentation exists.
				leaveHint: () => {
					const leader = scope.keybindings.getKeys("pancode.leader")[0];
					return leader ? `${formatKeyLabel(leader, "")} ${WORKSPACE_LEAVE_KEY} or /extensions leave` : "/extensions leave";
				},
				terminalRows: () => terminal.rows,
				press: (extensionId, action, source = "leader") => extensionPane.press(extensionId, { id: action, source }),
				leaderLabel: () => {
					const leader = scope.keybindings.getKeys("pancode.leader")[0];
					return leader ? formatKeyLabel(leader, "") : null;
				},
				leave: () => {
					operatorExtensions.leaveWorkspace();
				},
				focusBoard: (extensionId, title, view) => {
					if (!ambientSurfaces?.focusRegion(extensionId, title, view, "board"))
						scope.notify("info", "Close the open panel first; the board opens over the composer.");
				},
			})
		: undefined;
	const ambientSurfaces = operatorExtensions
		? createAmbientSurfaces({
				operator: operatorExtensions,
				tui,
				dock: extensionPane.viewDock({
					mux: deps.mux ?? null,
					stateDir: deps.stateDir,
					sessionId: () => deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
					log: (message) => scope.notify("warning", message, "operator-extensions:dock"),
				}),
				overlay: () => scope.overlayLifecycle,
				notice: (notice) => scope.notifications.add(notice),
				appendCard: (render) =>
					scope.chatRenderer.mutate(() => scope.chatPanel.appendReplayBlock(render), "extension-card"),
				showText: (owner, text) =>
					scope.slashRuntime.context.showReference?.({
						command: owner,
						source: extensionOwnerLabel(owner),
						kind: "result",
						text,
					}),
				fill: (text) => scope.editor.setLiteralText(text),
				submit: (text) => {
					scope.editor.setLiteralText(text);
					scope.editor.onSubmit?.(text);
				},
			})
		: undefined;

	return {
		updateAbort,
		armDeferredUpdate,
		extensionPane,
		operatorExtensions,
		turnObservations,
		turnUsage,
		devSession,
		workspaceSurfaces,
		ambientSurfaces,
	};
}
