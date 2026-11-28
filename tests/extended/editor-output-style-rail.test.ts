// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { PancodeSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProcessTerminal, Terminal } from "../../src/engine/tui.js";
import { ApplicationInputTuiMainScreen, stripTerminalSequences, VStack } from "../../src/engine/tui.js";
import type { TerminalLease } from "../../src/interactive/terminal-lease.js";
import { createProcessTerminalLease } from "../../src/interactive/terminal-lease.js";

class RailTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

const noop = (): void => {};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lease(settings: PancodeSettings): TerminalLease {
	const terminal = new RailTerminal();
	const tui = new ApplicationInputTuiMainScreen(terminal);
	const created = createProcessTerminalLease({
		settings,
		testing: {
			shell: {
				terminal: terminal as unknown as ProcessTerminal,
				tui,
				mount(root, focus) {
					tui.addChild(root);
					tui.setFocus(focus);
				},
				anchor: async () => 0,
				releaseAnchor: noop,
				stop: noop,
				settle: async () => {},
				complete: noop,
				commitCurrentFrame: async () => null,
				hasObservedBackpressure: () => false,
				setStreamPacingActive: noop,
				nextCommittedFrame: async () => null,
			},
			termination: {
				installSignalHandlers: noop,
				releaseInterruptOwnership: () => noop,
				onDrain: noop,
				shutdown: async () => {},
			},
			signals: { on: () => process, off: () => process },
			write: noop,
		},
	});
	cleanups.push(() => created.close());
	return created;
}

function topRail(target: TerminalLease): string {
	return stripTerminalSequences(target.editor.render(80)[0] ?? "");
}

function bottomRail(target: TerminalLease): string {
	return stripTerminalSequences(target.editor.render(80).at(-1) ?? "");
}

// BT-009 + FW c1-o1: the adopted editor reads live input-owned chrome through the lease proxy,
// keeping idle rails uninterrupted and carrying queued counts and draft mode without harness facts.
it("keeps composer rails input-only across Stage 0 adoption and forwards live queue state", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.thinkingLevel = "medium";
	settings.interface.outputDetail = "compact";
	const shell = lease(settings);
	assert.equal(topRail(shell), "━".repeat(80), "Stage 0 keeps the idle top rail uninterrupted");
	assert.equal(bottomRail(shell), "━".repeat(80), "Stage 0 keeps the idle bottom rail uninterrupted");

	let queued = 0;
	let streaming = false;
	shell.registerApplicationInput(() => undefined);
	const root = new VStack();
	root.addChild(shell.editor);
	assert.equal(
		shell.adopt({
			root,
			editorChrome: {
				isStreaming: () => streaming,
				getQueuedFollowUpCount: () => queued,
				getQueueReviewKeyLabel: () => "Alt+Q",
			},
			admitSubmission: async () => {},
		}),
		true,
	);

	assert.equal(topRail(shell), "━".repeat(80), "adopted idle rail stays clean");
	assert.doesNotMatch(bottomRail(shell), /think medium|ctx/u, "harness facts never return to composer rails");
	queued = 2;
	assert.match(topRail(shell), /2 queued/u, "adopted chrome forwards live queued count");
	streaming = true;
	shell.editor.setText("adjust approach");
	assert.match(topRail(shell), /STEER.*2 queued/u, "adopted chrome forwards live steer mode alongside queue");
});
