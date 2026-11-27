// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The terminal's side of an extension's pane and global keys. A package's
 * pane shares the dock slot with the View dock; its keys yield to every
 * PanCode binding and leader letter, and are pressed through the same gate
 * as the pane's taps, so a double press means the same thing from either.
 */
import type { ExtensionUiAction } from "@pancode/sdk/extension";
import { PANCODE_APP_KEYBINDINGS, PANCODE_KEYBINDINGS } from "../../domains/config/keybindings.js";
import type { OperatorExtensions } from "../../domains/extensions/operator-extensions.js";
import { extensionOwnerLabel } from "../../domains/extensions/owner-label.js";
import {
	type ExtensionKeyBinding,
	type ExtensionKeyClaims,
	resolveExtensionKeys,
} from "../../domains/extensions/services/keys.js";
import { createExtensionPaneHost, type ExtensionPaneHost } from "../../domains/extensions/services/pane.js";
import type { MuxContract } from "../../domains/mux/contract.js";
import { createDockKeyGate } from "../../domains/mux/dock-keys.js";
import { type Keybinding, type KeyId, matchesKey } from "../../engine/tui.js";
import type { InteractiveNoticeLevel } from "../interactive-subscriptions.js";
import type { PancodeKeybindingManager } from "../keybinding-manager.js";
import { createExtensionDockHost, type ExtensionDockHost } from "./extension-dock.js";
import { WORKSPACE_FOCUS_KEY, WORKSPACE_LEAVE_KEY } from "./registry.js";

type LeaderEntry = { key: string; label: string; run: () => void };

export interface ExtensionPaneKeysDeps {
	/** Absent outside herdr: no pane host, and a key presses its action directly. */
	mux: MuxContract | undefined;
	/** Read late: the operator and the key manager are built after this. */
	operator: () => OperatorExtensions | undefined;
	keybindings: () => PancodeKeybindingManager;
	notify: (level: InteractiveNoticeLevel, text: string, key?: string) => void;
}

export interface ExtensionPaneKeys {
	readonly pane: ExtensionPaneHost | undefined;
	press(extensionId: string, action: ExtensionUiAction): void;
	/** The View dock, which yields the shared slot to a pane and which a pane closes to take it. */
	viewDock(deps: Omit<Parameters<typeof createExtensionDockHost>[0], "yieldSlot">): ExtensionDockHost;
	/** Settles the declared keys now; a refusal is said once per session. */
	bindings(): ExtensionKeyBinding[];
	/** The input runtime's hooks: the workspace's leader entries then each bound key's letter, and the keys themselves. */
	inputHooks(workspace: () => ReadonlyArray<LeaderEntry>): {
		extraLeaderTargets: () => LeaderEntry[];
		extensionKey: (data: string) => boolean;
	};
}

/**
 * Settle declared extension keys against every built-in default, every active
 * operator keybinding (`interface.keybindings`), every built-in leader letter,
 * and the workspace keys. Live dispatch and `/extensions` share this settlement
 * so the bound keys and the displayed reasons never disagree.
 */
export function settleExtensionKeys(
	claims: ReadonlyArray<ExtensionKeyClaims>,
	keybindings: PancodeKeybindingManager,
): ReturnType<typeof resolveExtensionKeys> {
	const taken = new Map<string, string>();
	for (const id of Object.keys(PANCODE_KEYBINDINGS) as Keybinding[]) {
		const label = keybindings.getLabel(id);
		const defaults = PANCODE_KEYBINDINGS[id].defaultKeys;
		for (const key of Array.isArray(defaults) ? defaults : [defaults]) taken.set(key.toLowerCase(), label);
		for (const key of keybindings.getKeys(id)) taken.set(key.toLowerCase(), label);
	}
	const letters = new Map<string, string>();
	for (const descriptor of Object.values(PANCODE_APP_KEYBINDINGS))
		if ("leader" in descriptor && descriptor.leader) letters.set(descriptor.leader, descriptor.label);
	for (const target of keybindings.leaderTargets()) letters.set(target.key, keybindings.getLabel(target.id));
	letters.set(WORKSPACE_LEAVE_KEY, "leave the workspace");
	letters.set(WORKSPACE_FOCUS_KEY, "focus the workspace board");
	return resolveExtensionKeys(claims, taken, letters);
}

export function createExtensionPaneKeys(deps: ExtensionPaneKeysDeps): ExtensionPaneKeys {
	let viewDock: ExtensionDockHost | undefined;
	const refused = new Set<string>();
	const gate = createDockKeyGate();
	const press = (extensionId: string, action: ExtensionUiAction): void => {
		void deps
			.operator()
			?.action(extensionId, action)
			.catch((error) =>
				deps.notify(
					"warning",
					`${extensionOwnerLabel(extensionId)}: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	};
	const mux = deps.mux;
	const pane = mux
		? createExtensionPaneHost({
				mux: () => mux,
				press,
				changed: (extensionId, change) =>
					deps.operator()?.observeExtension(extensionId, { event: "pane_changed", ...change }),
				closeViewDock: async () => {
					await viewDock?.close();
					return !mux.docks().some((dock) => dock.slot === "extension");
				},
				log: (message) => deps.notify("warning", message, "operator-extensions:pane"),
				gate,
			})
		: undefined;
	const bindings = (): ExtensionKeyBinding[] => {
		const claims = deps.operator()?.keyClaims() ?? [];
		if (claims.length === 0) return [];
		const settled = settleExtensionKeys(claims, deps.keybindings());
		for (const refusal of settled.refused) {
			const said = `${refusal.extensionId}\0${refusal.reason}`;
			if (refused.has(said)) continue;
			refused.add(said);
			deps.notify(
				"warning",
				`${extensionOwnerLabel(refusal.extensionId)}: ${refusal.reason}, so the extension's key stays unbound`,
				`operator-extensions:key:${refusal.extensionId}:${refusal.key}`,
			);
		}
		return settled.bound;
	};
	const pressKey = (binding: ExtensionKeyBinding): void => {
		if (pane) pane.key(binding.extensionId, binding.action);
		else
			void gate.press(`${binding.extensionId}\0${binding.action}`, {
				single: () => press(binding.extensionId, { id: binding.action, source: "key", key: "tap" }),
				double: () => press(binding.extensionId, { id: binding.action, source: "key", key: "double" }),
			});
	};
	return {
		pane,
		press,
		viewDock(dockDeps) {
			viewDock = createExtensionDockHost({ ...dockDeps, ...(pane ? { yieldSlot: () => pane.yieldSlot() } : {}) });
			return viewDock;
		},
		bindings,
		inputHooks: (workspace) => ({
			extraLeaderTargets: () => {
				const entries = workspace();
				const taken = new Set(entries.map((entry) => entry.key));
				return [
					...entries,
					...bindings()
						.filter((binding) => !taken.has(binding.letter))
						.map((binding) => ({ key: binding.letter, label: binding.label, run: () => pressKey(binding) })),
				];
			},
			extensionKey: (data) => {
				const binding = bindings().find((candidate) => matchesKey(data, candidate.key as KeyId));
				if (binding) pressKey(binding);
				return binding !== undefined;
			},
		}),
	};
}
