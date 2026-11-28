// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { snapshotTurnConstraints } from "../../core/turn-constraints.js";
import type { ChatLoop } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";

/**
 * The submit admission: a tracked submit that records every run still going, behind a FIFO gate that admits one
 * submit at a time and opens the preparation window from the keystroke.
 */
export function createChatLoopAdmission(
	loop: ChatLoopScope,
	submitInner: ChatLoop["submit"],
): { submitTracked: ChatLoop["submit"]; submit: ChatLoop["submit"] } {
	const { enterPreparation, hostRunContext, keepalive, leavePreparation, prewarm } = loop;
	const submitTracked: ChatLoop["submit"] = (text, options) => {
		loop.priorSubmit = loop.activeSubmit;
		const preparationToken = options?.machineTurn?.preparationToken;
		loop.machinePreparation = preparationToken === undefined ? null : { token: preparationToken, runtime: null };
		// The flag brackets the whole submit, including the early returns an
		// admission failure takes, so a refused turn does not leave the pre-warm
		// believing a turn is still running.
		loop.turnActive = true;
		const run = submitInner(text, options).finally(() => {
			if (loop.machinePreparation?.token === preparationToken) loop.machinePreparation = null;
			loop.turnActive = false;
			keepalive.cancel();
		});
		// A steer during a run is a submit that returns at once. Replacing the record with it forgot the
		// live run, so an interrupt's wait for the cancel to settle returned early and shutdown could stop the writer
		// under a persisting turn. The record covers every submit still going.
		loop.activeSubmit = Promise.all([loop.priorSubmit, run.catch(() => {})]).then(() => {});
		return run;
	};

	// FIFO admission gate. Between entry and `state.streaming = true` a fresh
	// submit awaits the target probe, auto-compaction, and the session prompt
	// compile; a second submit arriving in that window used to run the same
	// pipeline concurrently, skip the probe the first one was still awaiting,
	// append its user turn first, and leave the first to fail on the engine's
	// active-prompt invariant after its turn was already in the ledger. Each
	// submit now waits for the previous one to either own the stream or return,
	// then re-evaluates `state.streaming`, so a prompt typed during boot lands
	// as the next steer or follow-up in the order it was typed. The gate is
	// released at admission, not settlement, so steering stays immediate.
	let admissionTail: Promise<void> | null = null;
	const submit: ChatLoop["submit"] = (text, options = {}) => {
		const constraints = snapshotTurnConstraints(options.constraints);
		options = { ...options, ...(constraints === undefined ? {} : { constraints }) };
		// Capture before admission can await. Internal resubmits inherit the
		// async scope; every independent public submit explicitly starts its own.
		const hostRun = options.hostRun === undefined ? undefined : structuredClone(options.hostRun);
		// The operator owns the slot from the keystroke, not from admission. The
		// prefix the pre-warm already pushed through stays in it either way, so
		// aborting here costs nothing and stops the real turn from queueing behind
		// a request nobody is waiting on.
		prewarm.cancel();
		keepalive.cancel();
		const previous = admissionTail;
		let release: () => void = () => {};
		const ticket = new Promise<void>((resolve) => {
			release = resolve;
		});
		admissionTail = ticket;
		const releaseTicket = (): void => {
			release();
			if (admissionTail === ticket) admissionTail = null;
		};
		// The window opens here, not at admission: the caller has already cleared
		// the editor and painted the prompt, and a submit that queues behind the
		// FIFO gate is still a prompt PanCode is holding. It closes once, at
		// whichever of admission and settlement comes first, so a refused probe
		// and a blocked overflow preflight close it as reliably as a turn that
		// reaches the stream.
		enterPreparation();
		let leftPreparation = false;
		const leaveOnce = (): void => {
			if (leftPreparation) return;
			leftPreparation = true;
			leavePreparation();
		};
		const start = async (): Promise<void> => {
			const { onPreparationVisible, ...submitOptions } = options;
			try {
				await onPreparationVisible?.();
			} catch {
				// A presentation observer cannot refuse a turn after the editor has
				// consumed it. The ordinary render path can recover on its next tick.
			}
			if (options.isAdmissionCurrent?.() === false) {
				releaseTicket();
				return;
			}
			return hostRunContext
				.run(hostRun, () =>
					submitTracked(text, {
						...submitOptions,
						onAdmitted: () => {
							releaseTicket();
							leaveOnce();
							options.onAdmitted?.();
						},
					}),
				)
				.finally(releaseTicket);
		};
		const run = previous ? previous.then(start) : start();
		return run.finally(leaveOnce);
	};
	return { submitTracked, submit };
}
