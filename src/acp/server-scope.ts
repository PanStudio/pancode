// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The per-connection state one `servePancodeAcpAgent` call shares across the
 * server modules. Fields are read where they are used, never copied, so every
 * module sees the current value; module outputs are getters, read at call time.
 */
import type { ContextActivityPayload } from "../core/telemetry/live-events.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { AcpLiveTelemetry } from "./live-telemetry.js";
import type { AcpServerCommands } from "./server-commands.js";
import type { AcpServerConfig } from "./server-config.js";
import type { AcpServerControl } from "./server-control.js";
import type { AcpServerEvents } from "./server-events.js";
import type { AcpServerGuards } from "./server-guards.js";
import type { AcpServerMachine } from "./server-machine.js";
import type { AcpServerOpen } from "./server-open.js";
import type { AcpHandoffDraft, AcpHandshake, PancodeAcpServerOptions } from "./server-options.js";
import type { AcpPermissionBridge } from "./server-permissions.js";
import type { AcpServerReadouts } from "./server-readouts.js";
import type { AcpServerSession, ActivePrompt } from "./server-tool-updates.js";

/** One cancellable piece of work beside the session's turns: an operator shell line or an aside round. */
export interface AcpSideWork {
	sessionId: string;
	abort: AbortController;
	settled: Promise<void>;
}

/** The one document awaiting review, keyed by the id its client holds. */
export interface AcpPendingHandoff {
	handoffId: string;
	sessionId: string;
	draft: AcpHandoffDraft;
}

/**
 * The prompt state a scheduled main turn holds while it runs. Token-owned: only the lease's own
 * release clears it, and only while it is still the holder, so a stale release never touches a
 * successor turn (#411).
 */
export interface AcpMachineLease {
	readonly jobId: string;
	readonly active: ActivePrompt;
}

export interface AcpServerScope {
	readonly options: PancodeAcpServerOptions;
	readonly handshake: AcpHandshake;
	/** The launch cwd, canonicalized once: the process's one workspace identity. */
	readonly canonicalCwd: string;
	readonly workspaceInstanceId: string;
	readonly now: () => number;
	readonly telemetry: AcpLiveTelemetry;
	readonly permission: AcpPermissionBridge;

	readonly sessions: Map<string, AcpServerSession>;
	readonly closedSessionIds: Set<string>;
	/** A forked parent's id, mapped to the child that took its place in this process. */
	readonly replacedSessions: Map<string, string>;
	readonly closingSessions: Map<string, Promise<Record<string, never>>>;
	/** Why a target's model choices are its configured ones and not the account's live listing. */
	readonly listingFallbacks: Map<string, string>;

	activeSessionId: string | null;
	/**
	 * The one session this process hosts, from the moment it is bound until it is
	 * closed. Distinct from {@link activeSessionId}, which is only set while a
	 * prompt is running: a detached dispatch run legitimately finishes after the
	 * turn that started it, and a client keyed on the bound session still needs
	 * that outcome so its board does not leave the run running forever.
	 */
	boundSessionId: string | null;
	activePromptState: ActivePrompt | null;
	machineLease: AcpMachineLease | null;
	sessionCreated: boolean;
	pendingHandoff: AcpPendingHandoff | null;
	handoffPreparing: boolean;
	/** Counts prompts, so a draft drawn while a request started is known to be stale. */
	promptSerial: number;
	/** The session the startup notices went to; a load of a session that already took a prompt counts as shown. */
	startupHintsSessionId: string | null;
	promptSettled: Promise<void> | null;
	/** The one operator shell line this process runs at a time, as the terminal runs one. */
	activeShell: AcpSideWork | null;
	contextActivity: ContextActivityPayload | null;
	contextCommandInFlight: Promise<unknown> | null;
	/**
	 * The limits last applied to the chat. A slash command acts outside the tool
	 * calls these bound, so it is screened against them before it runs (Z1).
	 */
	standingLimits: TurnConstraints | undefined;
	/** The one /btw or /draft round beside the session. */
	asideRound: AcpSideWork | null;
	readonly guards: AcpServerGuards;
	readonly commands: AcpServerCommands;
	readonly control: AcpServerControl;
	readonly events: AcpServerEvents;
	readonly readoutFeed: AcpServerReadouts;
	readonly config: AcpServerConfig;
	readonly open: AcpServerOpen;
	readonly machine: AcpServerMachine;
}
