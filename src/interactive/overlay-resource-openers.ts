// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ProjectTrustCardModel } from "../cli/project-trust-card.js";
import { promptRefs } from "../domains/extensions/operator-commands.js";
import type { HubEntryKind, ResourcesContract } from "../domains/resources/index.js";
import type { TUI } from "../engine/tui.js";
import { promptSourceLabel } from "../session-control/prompt-source-label.js";
import type { HubBrowseRequest, SlashCommandContext } from "../session-control/slash-command-types.js";
import type { PancodeKeybindingManager } from "./keybinding-manager.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openExtensionViewPanel } from "./overlays/extension-view-panel.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openHubOverlay } from "./overlays/hub.js";
import { createHubLifecycle, type HubSessionReload, hubRefreshHost } from "./overlays/hub-lifecycle.js";
import { openInteropOverlay } from "./overlays/interop.js";
import { openProjectTrustOverlay } from "./overlays/project-trust.js";
import type { PancodeEditor } from "./pancode-editor.js";

export type { HubBrowseRequest as HubOpenRequest } from "../session-control/slash-command-types.js";

export interface OverlayResourceOpenersDeps {
	tui: TUI;
	transitions: Pick<OverlayTransitions, "state" | "handle">;
	keybindings: PancodeKeybindingManager;
	editor: Pick<PancodeEditor, "setText">;
	getSlashContext: () => SlashCommandContext;
	resources?: Pick<ResourcesContract, "skills">;
	closeOverlay: () => void;
	commandHidden?: (command: string) => boolean;
	openHelpOverlay?: typeof openHelpOverlay;
	openSkillsHub?: typeof openHubOverlay;
	openExtensionsOverlay?: typeof openExtensionsOverlay;
	openInteropOverlay?: typeof openInteropOverlay;
}

export interface OverlayResourceOpeners {
	openExtensionViewPanelState(
		owner: string,
		deps: Omit<Parameters<typeof openExtensionViewPanel>[2], "close"> & { onClosed(): void },
	): boolean;
	openHelpOverlayState(query?: string): void;
	openSkillsHubState(request?: HubBrowseRequest | HubEntryKind): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
	/** The project trust card; `done` runs once when it closes, true for Trust all. False while another overlay is up. */
	openProjectTrustState(model: ProjectTrustCardModel, done: (trusted: boolean) => void): boolean;
}

/**
 * The session's own reloads, or nothing for a seam this host has not wired.
 * An extension change reaches the running session only through the operator
 * reload, which restarts runtimes and republishes hooks and waits for an idle
 * session; PanHub overlay is open, so it normally queues until it closes.
 */
function sessionReload(ctx: SlashCommandContext): HubSessionReload {
	const reload = ctx.reloadPlugins;
	const operator = ctx.operatorExtensions;
	return {
		...(reload ? { resources: () => reload() } : {}),
		...(operator
			? {
					extensions: () => {
						const queued = !operator.canReloadNow;
						// The settled result is reported by the operator host's own reload notice.
						operator.reload().catch((error: unknown) => {
							ctx.notice("warn", `extensions: reload failed: ${error instanceof Error ? error.message : String(error)}`);
						});
						return queued ? "queued" : "reloading";
					},
				}
			: {}),
	};
}

export function createOverlayResourceOpeners(deps: OverlayResourceOpenersDeps): OverlayResourceOpeners {
	const openHelp = deps.openHelpOverlay ?? openHelpOverlay;
	const openHub = deps.openSkillsHub ?? openHubOverlay;
	const openExtensions = deps.openExtensionsOverlay ?? openExtensionsOverlay;
	const openInterop = deps.openInteropOverlay ?? openInteropOverlay;

	const openHelpOverlayState = (query?: string): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "help";
		const ctx = deps.getSlashContext();
		const prompts = (ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items ?? [];
		deps.transitions.handle = openHelp(
			deps.tui,
			deps.keybindings,
			deps.closeOverlay,
			query,
			ctx.operatorExtensions?.commands(promptRefs(prompts)),
			// A picked command lands in the composer unsent, cursor at the end.
			(text) => deps.editor.setText(text),
			deps.commandHidden,
			prompts.map((prompt) => ({
				name: prompt.name,
				description: prompt.description,
				source: promptSourceLabel(prompt.sourceInfo),
				...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
			})),
		);
		deps.tui.requestRender();
	};

	const openInteropOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "interop";
		deps.transitions.handle = openInterop(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	const openSkillsHubState = (request?: HubBrowseRequest | HubEntryKind): void => {
		if (deps.transitions.state !== "closed") return;
		const open: HubBrowseRequest = typeof request === "string" ? { tab: request } : (request ?? {});
		deps.transitions.state = "skills-hub";
		const ctx = deps.getSlashContext();
		deps.transitions.handle = openHub(deps.tui, {
			...(open.tab ? { initialTab: open.tab } : {}),
			...(open.focus ? { focus: open.focus } : {}),
			...(open.intent ? { intent: open.intent } : {}),
			...(open.importSource ? { importSource: open.importSource } : {}),
			...(open.scope ? { initialScope: open.scope } : {}),
			// The session's own reload is the refresh a committed change asks for:
			// plugin resources always, extensions when one changed. It is reported
			// separately from the write and can be retried on its own, so a refresh
			// failure never restates a successful install.
			lifecycle: createHubLifecycle(hubRefreshHost(sessionReload(ctx)), (failure) =>
				ctx.notice("warn", `hub: a pinned program did not download: ${failure}`),
			),
			// A fleet's `use` is its approval preview, which is a surface of its own.
			// PanHub closes first so the preview owns the overlay slot, exactly
			// as `/fleet run <playbook>` typed into the composer would.
			openFleetRun: (name) => {
				deps.closeOverlay();
				deps.getSlashContext().startFleetRun?.(name, {});
			},
			// Discovery is explicit. Opening PanHub never sweeps another
			// agent's home; this is the only route that does, and only on `o`.
			openImport: () => {
				deps.closeOverlay();
				openInteropOverlayState();
			},
			setEditorText: (text) => {
				deps.editor.setText(text);
				deps.tui.requestRender();
			},
			notice: (level, text) => deps.getSlashContext().notice(level, text),
			onClose: deps.closeOverlay,
		});
		deps.tui.requestRender();
	};

	const openExtensionsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "extensions";
		deps.transitions.handle = openExtensions(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	return {
		openExtensionViewPanelState(owner, panelDeps) {
			if (deps.transitions.state !== "closed") return false;
			deps.transitions.state = "extensions";
			const handle = openExtensionViewPanel(deps.tui, owner, { ...panelDeps, close: deps.closeOverlay });
			let closed = false;
			deps.transitions.handle = {
				...handle,
				hide() {
					if (closed) return;
					closed = true;
					handle.hide();
					panelDeps.onClosed();
				},
			};
			deps.tui.requestRender();
			return true;
		},
		openProjectTrustState(model, done) {
			if (deps.transitions.state !== "closed") return false;
			deps.transitions.state = "project-trust";
			let trusted = false;
			let closed = false;
			const handle = openProjectTrustOverlay(deps.tui, model, {
				onTrust: () => {
					trusted = true;
					deps.closeOverlay();
				},
				onClose: deps.closeOverlay,
			});
			// Every way out (Esc, Not now, a session change that closes all overlays) settles the card once.
			deps.transitions.handle = {
				...handle,
				hide() {
					if (closed) return;
					closed = true;
					handle.hide();
					done(trusted);
				},
			};
			deps.tui.requestRender();
			return true;
		},
		openHelpOverlayState,
		openSkillsHubState,
		openExtensionsOverlayState,
		openInteropOverlayState,
	};
}
