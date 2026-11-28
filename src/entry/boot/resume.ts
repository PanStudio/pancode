// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { noteMainRunV2 } from "../../cli/run-failure.js";
import { flushPackActivities } from "../../core/pack-activity.js";
import { consumeRestartIntent } from "../../core/restart-intent.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { getTerminationCoordinator } from "../../core/termination.js";
import { pancodeStateDir } from "../../core/xdg.js";
import type { SessionContract } from "../../domains/session/contract.js";
import { SessionLiveError } from "../../domains/session/index.js";
import type { BootOptions } from "../boot-options.js";
import { bindSessionPackActivity } from "../pack-activity.js";

/** What resolveBootResume reads from the names bootOrchestrator built before it. */
export interface BootResumeInput {
	bootStderr: (text: string) => void;
	bus: TelemetryHub;
	interactive: boolean;
	options: BootOptions;
	session: SessionContract | undefined;
	termination: ReturnType<typeof getTerminationCoordinator>;
}

/**
 * Stage P2, after the contract check: the session package activity binding and the boot-time resume, which records why
 * a requested resume failed rather than exiting, so the exit stays with bootOrchestrator.
 */
export function resolveBootResume(input: BootResumeInput) {
	const { bootStderr, bus, interactive, options, session, termination } = input;
	if (session) {
		const unbindActivity = bindSessionPackActivity(session);
		termination.onDrain(unbindActivity);
		termination.onDrain(bus.subscribe("session.reattached", () => flushPackActivities()));
	}
	// A headless `--resume`/`--continue`, or the interactive `--resume <id>`/`--continue`, resolves here, where the
	// session domain exists. Headless it is a hard requirement: a caller that asked to continue a conversation must not
	// receive an answer written without that conversation's history. Interactive, a miss opens a fresh session.
	const requestedResume = options.headless ? options.headless.resumeSession : options.resume;
	let headlessResumeFailure: string | null = null;
	let headlessResumeSlug: SessionLiveError["slug"] | undefined;
	let resolvedResumeId: string | undefined;
	if (requestedResume !== undefined && requestedResume.kind !== "picker") {
		if (!session) {
			headlessResumeFailure = "session continuation requires the session domain, which is not loaded";
		} else if (requestedResume.kind === "id") {
			const resolved = session.resolveId(requestedResume.id);
			if (typeof resolved === "string") resolvedResumeId = resolved;
			else
				headlessResumeFailure = `session prefix ${requestedResume.id} is ambiguous; matches: ${resolved.ambiguous.join(", ")}`;
		} else {
			const latest = session.history().find((meta) => meta.hasModelTurn !== false);
			if (latest === undefined)
				headlessResumeFailure = `no previous session with a model turn recorded for ${process.cwd()}`;
			else resolvedResumeId = latest.id;
		}
	}
	const resumeId =
		resolvedResumeId ?? (interactive ? consumeRestartIntent(pancodeStateDir(), process.cwd()) : undefined);
	if (options.headless?.sessionName !== undefined) session?.nameSession(options.headless.sessionName);
	let resumedSessionAtBoot = false;
	if (resumeId && session && headlessResumeFailure === null) {
		try {
			// A v2 envelope names the session a fork branched from; a no-op unless --output-format json|stream-json.
			if (requestedResume?.kind !== "picker" && requestedResume?.fork === true)
				noteMainRunV2({ parentSessionId: session.forkFrom(resumeId).parentSessionId ?? resumeId });
			else session.resume(resumeId);
			resumedSessionAtBoot = true;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (err instanceof SessionLiveError) headlessResumeSlug = err.slug;
			if (requestedResume !== undefined) headlessResumeFailure = `failed to resume session ${resumeId}: ${detail}`;
			else bootStderr(`PanCode: failed to resume session ${resumeId}: ${detail}\n`);
		}
	}
	return {
		resumeState: {
			get headlessResumeFailure() {
				return headlessResumeFailure;
			},
			get headlessResumeSlug() {
				return headlessResumeSlug;
			},
			get resumedSessionAtBoot() {
				return resumedSessionAtBoot;
			},
		},
	};
}
