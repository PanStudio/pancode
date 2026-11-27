// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One terminal pane per extension in the host's dock, the host half of `ctx.pane`.
 *
 * The pane runs a binary the package declared, never a shell, and takes the
 * `extension` dock slot it shares with the host's View dock: opening either
 * closes the other, so the operator sees one extension below PanCode at a time.
 * Hiding parks the pane with its process still running. A program inside the
 * pane reaches its package by appending a line to a tap file in the store; the
 * host classifies taps and the package's global key through one gate, so a
 * second press inside 400 ms arrives as `double`.
 */
import path from "node:path";
import type { ExtensionBinaryDeclaration, ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import { terminalBackground } from "../../../core/terminal-background.js";
import { roleHex } from "../../../core/theme-roles.js";
import type { MuxContract } from "../../mux/contract.js";
import { createDockKeyGate, type DockKeyGate } from "../../mux/dock-keys.js";
import { type TapFileWatcher, watchTapFile } from "../../mux/tap-file.js";
import type { MuxPaneRecord } from "../../mux/types.js";
import { packBinaryPath, parseBinaryArgs, parseBinaryEnv } from "./binaries.js";

/** The dock slot extension panes share with the View dock. */
const SLOT = "extension" as const;
/** A pane asks for at most this many rows; more would crowd PanCode's own. */
export const PANE_ROWS_MAX = 24;
const TITLE_MAX = 40;

export type ExtensionPaneState = "visible" | "hidden" | "closed";
export type ExtensionPaneChangeReason = "opened" | "hidden" | "revealed" | "closed" | "exited" | "replaced";
export type ExtensionPaneKey = "tap" | "double";

/** The six colors a pane program can theme itself with, for the background PanCode detected. */
export interface ExtensionPanePalette {
	background: "dark" | "light" | null;
	accent: string;
	strong: string;
	text: string;
	low: string;
	mid: string;
	high: string;
}

export interface ExtensionPaneOwner {
	extensionId: string;
	declaration: Pick<ExtensionRuntimeDeclarationV2, "binaries">;
	/** Absolute store directory: the pane's working directory and the root its tap file resolves under. */
	storeDir: string;
}

export interface ExtensionPaneOpen {
	binary: string;
	args: string[];
	env: Record<string, string>;
	title: string;
	rows: number | null;
	share: number | null;
	hidden: boolean;
	tap: { file: string; action: string } | null;
}

export interface ExtensionPaneHost {
	/** One `ctx.pane` call; answers what the runtime sees or throws the operator-readable reason. */
	call(owner: ExtensionPaneOwner, op: string, payload: unknown): Promise<unknown>;
	/** A global key the package declared: classified through the same gate as its pane's taps. */
	key(extensionId: string, action: string): void;
	/** Close the extension's pane, as its runtime stops for good: disable, uninstall, session end. */
	release(extensionId: string): Promise<void>;
	/** The View dock is about to take the slot; any extension pane leaves it first. */
	yieldSlot(): Promise<boolean>;
	/** Whether this extension holds the slot now. */
	owns(extensionId: string): boolean;
	dispose(): Promise<void>;
}

export interface ExtensionPaneHostDeps {
	mux: () => MuxContract | null;
	/** Press a package action, as a tap or key gate classified it. */
	press: (extensionId: string, action: { id: string; source: "dock" | "key"; key: ExtensionPaneKey }) => void;
	/** The package hears `pane_changed`. */
	changed: (extensionId: string, change: { state: ExtensionPaneState; reason: ExtensionPaneChangeReason }) => void;
	/** Close the View dock before an extension pane takes the slot; false when it would not close. */
	closeViewDock?: () => Promise<boolean>;
	log?: (message: string) => void;
	gate?: DockKeyGate;
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pane request");
	return value as Record<string, unknown>;
}

/** Store-relative, inside the store, and plain text: the host truncates the file and reads it. */
function storePath(storeDir: string, relative: unknown, label: string): string {
	if (typeof relative !== "string" || relative.length === 0 || relative.length > 200 || relative.includes("\0"))
		throw new Error(`${label} must be a store-relative path`);
	const resolved = path.resolve(storeDir, relative);
	if (path.isAbsolute(relative) || !resolved.startsWith(storeDir + path.sep))
		throw new Error(`${label} must stay inside the extension's store`);
	return resolved;
}

/** Checks one `ctx.pane.open` request against the declaration; throws the reason. */
function parsePaneOpen(
	value: unknown,
	binaries: ReadonlyArray<ExtensionBinaryDeclaration>,
	storeDir: string,
): ExtensionPaneOpen {
	const raw = record(value);
	const binary = binaries.find((entry) => entry.name === raw.binary);
	if (!binary) throw new Error(`pane binary '${String(raw.binary)}' is not declared`);
	const title = raw.title ?? binary.name;
	if (typeof title !== "string" || title.length === 0 || title.length > TITLE_MAX || /\p{Cc}/u.test(title))
		throw new Error(`pane title must be plain text of at most ${TITLE_MAX} characters`);
	const rows = raw.rows ?? null;
	if (rows !== null && (!Number.isInteger(rows) || (rows as number) < 1 || (rows as number) > PANE_ROWS_MAX))
		throw new Error(`pane rows must be a whole number from 1 to ${PANE_ROWS_MAX}`);
	const share = raw.share ?? null;
	if (share !== null && (typeof share !== "number" || !(share > 0) || share > 0.5))
		throw new Error("pane share must be above 0 and at most 0.5");
	let tap: ExtensionPaneOpen["tap"] = null;
	if (raw.tap !== undefined) {
		const tapRaw = record(raw.tap);
		if (typeof tapRaw.action !== "string" || tapRaw.action.length === 0)
			throw new Error("pane tap needs the action a tap presses");
		tap = { file: storePath(storeDir, tapRaw.file, "pane tap file"), action: tapRaw.action };
	}
	return {
		binary: binary.name,
		args: parseBinaryArgs(raw.args),
		env: parseBinaryEnv(raw.env, binary),
		title,
		rows: rows as number | null,
		share: share as number | null,
		hidden: raw.hidden === true,
		tap,
	};
}

function extensionPanePalette(): ExtensionPanePalette {
	const background = terminalBackground();
	return {
		background,
		accent: roleHex("selectedOption", background),
		strong: roleHex("body", background),
		text: roleHex("metadata", background),
		low: roleHex("toolGlyph", background),
		mid: roleHex("transcriptKnowledgeAction", background),
		high: roleHex("harnessAction", background),
	};
}

interface Held {
	extensionId: string;
	label: string;
	taps: TapFileWatcher | null;
	/** Set while the host closes the pane, so the departure is reported with its cause. */
	closing: ExtensionPaneChangeReason | null;
}

export function createExtensionPaneHost(deps: ExtensionPaneHostDeps): ExtensionPaneHost {
	const gate = deps.gate ?? createDockKeyGate();
	const log = (message: string): void => deps.log?.(message);
	let held: Held | null = null;
	let disposed = false;
	let queue: Promise<unknown> = Promise.resolve();
	let unsubscribe: (() => void) | null = null;
	let subscribedTo: MuxContract | null = null;

	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.catch(() => undefined);
		return run;
	};
	const live = (): MuxContract => {
		const mux = deps.mux();
		if (!mux) throw new Error("pane: this session has no pane host; run PanCode inside herdr");
		if (!mux.available()) throw new Error(`pane: herdr panes are not available (${mux.detection().reason})`);
		if (subscribedTo !== mux) {
			unsubscribe?.();
			subscribedTo = mux;
			unsubscribe = mux.onPaneGone(gone);
		}
		return mux;
	};
	const notify = (extensionId: string, state: ExtensionPaneState, reason: ExtensionPaneChangeReason): void => {
		try {
			deps.changed(extensionId, { state, reason });
		} catch (error) {
			log(`pane change for ${extensionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const drop = (reason: ExtensionPaneChangeReason): void => {
		if (!held) return;
		const { extensionId, taps } = held;
		taps?.stop();
		held = null;
		notify(extensionId, "closed", reason);
	};
	function gone(entry: MuxPaneRecord): void {
		if (held && entry.label === held.label) drop(held.closing ?? "exited");
	}
	const visibility = (mux: MuxContract | null): ExtensionPaneState =>
		held && mux ? mux.dockVisibility(SLOT) : "closed";
	const paneId = (mux: MuxContract): string | null => mux.docks().find((dock) => dock.slot === SLOT)?.paneId ?? null;
	const close = async (mux: MuxContract, reason: ExtensionPaneChangeReason): Promise<boolean> => {
		if (!held) return true;
		const id = paneId(mux);
		if (id === null) {
			drop(reason);
			return true;
		}
		held.closing = reason;
		const closed = await mux.closePane(id);
		// The departure push may lag the close answer; the record leaves either way.
		if (closed) drop(reason);
		else if (held) held.closing = null;
		return closed;
	};
	const press = (extensionId: string, action: string, source: "dock" | "key"): void => {
		void gate.press(extensionId, {
			single: () => deps.press(extensionId, { id: action, source, key: "tap" }),
			double: () => deps.press(extensionId, { id: action, source, key: "double" }),
		});
	};

	const open = async (owner: ExtensionPaneOwner, request: ExtensionPaneOpen): Promise<ExtensionPaneState> => {
		const mux = live();
		if (held?.extensionId === owner.extensionId && visibility(mux) !== "closed") return visibility(mux);
		if (held && !(await close(mux, "replaced"))) throw new Error("pane: the pane in the dock did not close");
		if (paneId(mux) !== null && !(await (deps.closeViewDock?.() ?? Promise.resolve(false))))
			throw new Error("pane: the dock holds a view that did not close");
		const binary = owner.declaration.binaries?.find((entry) => entry.name === request.binary);
		if (!binary) throw new Error(`pane binary '${request.binary}' is not declared`);
		const resolved = packBinaryPath(owner.extensionId, binary);
		if ("reason" in resolved) throw new Error(resolved.reason);
		const label = `ext:${owner.extensionId}`;
		let taps: TapFileWatcher | null = null;
		if (request.tap) {
			const action = request.tap.action;
			taps = watchTapFile(request.tap.file, () => {
				if (!disposed) press(owner.extensionId, action, "dock");
			});
		}
		held = { extensionId: owner.extensionId, label, taps, closing: null };
		let refusal: string | null = null;
		const ref = await mux.openUtilityPane({
			argv: [resolved.path, ...request.args],
			cwd: owner.storeDir,
			label,
			title: request.title,
			env: request.env,
			purpose: "utility",
			dock: {
				slot: SLOT,
				...(request.share === null ? {} : { share: request.share }),
				...(request.rows === null ? {} : { minCells: request.rows }),
				...(request.hidden ? { hidden: true } : {}),
			},
			onFailure: (failure) => {
				refusal = failure.message;
			},
		});
		if (ref === null) {
			taps?.stop();
			held = null;
			throw new Error(`pane: the pane did not open: ${refusal ?? "the pane host refused"}`);
		}
		const state = request.hidden ? "hidden" : "visible";
		notify(owner.extensionId, state, "opened");
		return state;
	};

	const ownedMux = (extensionId: string): MuxContract | null => {
		if (held?.extensionId !== extensionId) return null;
		return live();
	};

	return {
		call(owner, op, payload): Promise<unknown> {
			if (disposed) return Promise.reject(new Error("pane: the host is shutting down"));
			if (op === "palette") return Promise.resolve(extensionPanePalette());
			if (op === "state")
				return Promise.resolve(held?.extensionId === owner.extensionId ? visibility(deps.mux()) : "closed");
			return serial(async (): Promise<unknown> => {
				if (op === "open") return open(owner, parsePaneOpen(payload, owner.declaration.binaries ?? [], owner.storeDir));
				const mux = ownedMux(owner.extensionId);
				if (op === "close") {
					if (mux && !(await close(mux, "closed"))) throw new Error("pane: the pane did not close");
					// A tap from inside the pane left the keyboard there; it comes back with the pane gone.
					await mux?.focusSelf();
					return "closed";
				}
				if (op === "hide" || op === "reveal") {
					if (!mux) throw new Error("pane: no pane is open; open one first");
					let reason: string | null = null;
					const onFailure = (failure: { message: string }): void => {
						reason = failure.message;
					};
					if (op === "hide") {
						if (visibility(mux) === "hidden") return "hidden";
						if (!(await mux.hideDock(SLOT, { onFailure })))
							throw new Error(`pane: the pane did not hide: ${reason ?? "the pane host refused"}`);
						await mux.focusSelf();
						notify(owner.extensionId, "hidden", "hidden");
						return "hidden";
					}
					if (visibility(mux) === "visible") return "visible";
					if ((await mux.showDock(SLOT, { onFailure })) === null)
						throw new Error(`pane: the pane stayed hidden: ${reason ?? "the pane host refused"}`);
					notify(owner.extensionId, "visible", "revealed");
					return "visible";
				}
				throw new Error(`pane: unknown operation ${op}`);
			});
		},
		key(extensionId, action): void {
			if (!disposed) press(extensionId, action, "key");
		},
		release(extensionId): Promise<void> {
			return serial(async () => {
				const mux = deps.mux();
				if (held?.extensionId !== extensionId) return;
				if (mux) await close(mux, "closed");
				else drop("closed");
			});
		},
		yieldSlot(): Promise<boolean> {
			return serial(async () => {
				const mux = deps.mux();
				if (!held) return true;
				if (!mux) {
					drop("replaced");
					return true;
				}
				return close(mux, "replaced");
			});
		},
		owns(extensionId): boolean {
			return held?.extensionId === extensionId;
		},
		async dispose(): Promise<void> {
			await serial(async () => {
				const mux = deps.mux();
				if (held && mux) await close(mux, "closed").catch(() => false);
				drop("closed");
			});
			disposed = true;
			unsubscribe?.();
			unsubscribe = null;
		},
	};
}
