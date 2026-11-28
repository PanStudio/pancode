// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { writeDiagnostic } from "../../core/diagnostics.js";
import {
	armedSkillSurface,
	type PendingSkillRequest,
	type PendingSkillToolPolicy,
	SKILL_SURFACE_ENTRY,
	type SkillSurfaceChange,
	skillSurfaceChange,
	skillSurfaceLabels,
	skillSurfaceNames,
} from "../../core/skill-activation.js";
import { latestSkillContextState, mainSkillContextState, SKILL_CONTEXT_STATE } from "../../domains/session/entries.js";
import { activePath } from "../../domains/session/tree/active-path.js";
import type { ChatLoopEvent, ChatNoticeEvent, CreateChatLoopDeps } from "../chat-loop.js";
import { HOST_STATUS_NOTICE_KEY } from "../chat-loop-messages.js";
import type { NoticeSource } from "../notice-source.js";
import type { ChatLoopNoticesState } from "../turn-state.js";

/**
 * One event to every listener. A listener's throw never reaches the turn that emitted, as on the telemetry hub; the
 * snapshot keeps a listener that subscribes or leaves inside its own call from changing this delivery.
 */
function deliverChatLoopEvent(listeners: ReadonlySet<(event: ChatLoopEvent) => void>, event: ChatLoopEvent): void {
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch (error) {
			const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
			writeDiagnostic(`[pancode:chat-loop] Listener crashed on ${event.type}: ${message}`, "error");
		}
	}
}

/**
 * The chat loop's event delivery and the notices it raises on the footer and the transcript, including the
 * skill surface notice a settled turn arms and the admission notice for a turn that never started.
 */
export function createChatLoopNotices(
	deps: CreateChatLoopDeps,
	state: ChatLoopNoticesState,
	listeners: Set<(event: ChatLoopEvent) => void>,
) {
	const emit = (event: ChatLoopEvent): void => deliverChatLoopEvent(listeners, event);

	const refuseSkillRequests = (
		requests: ReadonlyArray<PendingSkillRequest>,
		inlinedPaths: ReadonlyArray<string>,
	): boolean => {
		if (!requests.some((request) => request.name.trim() === "context-handoff")) return false;
		// The file this request inlines is judged, not labeled: a refused request sends nothing, so it labels nothing.
		const refusal = deps.refuseHandoffSkill?.(inlinedPaths) ?? null;
		if (refusal === null) return false;
		emit({
			type: "notice",
			level: "warning",
			surface: "transcript",
			text: refusal,
			admission: { reason: "handoff-skill-refused" },
		});
		return true;
	};

	const emitFooterNotice = (level: ChatNoticeEvent["level"], text: string, key: string): void => {
		emit({ type: "notice", level, surface: "footer", text, key });
	};

	/**
	 * Transcript notices are first-class `notice` events, never fake
	 * `message_end` assistant messages: a notice can never become a headless
	 * turn's answer, never carries usage, and never ends a run. Run closure is
	 * the engine's job (handleRunFailure delivers agent_end on abort and
	 * provider-failure paths) and RunAborted carries abort provenance to the
	 * status reducer.
	 */
	const emitNotice = (
		text: string,
		level: ChatNoticeEvent["level"] = "info",
		key?: string,
		skillSurface?: SkillSurfaceChange,
		source?: NoticeSource,
	): void => {
		emit({
			type: "notice",
			level,
			surface: "transcript",
			text,
			...(key === undefined ? {} : { key }),
			...(skillSurface === undefined ? {} : { skillSurface }),
			...(source === undefined ? {} : { source }),
		});
	};

	/**
	 * Carry (or drop) the tool surface a skill declared once the turn that
	 * loaded it settles, and say so once on the transcript. The operator needs
	 * to know a narrowing is armed across their next messages, and needs one
	 * line back when it lifts; the skill-activation ledger entry already
	 * records provenance, so this is the notice, not a second UI.
	 */
	const armSkillSurface = (
		policy: PendingSkillToolPolicy | undefined,
		loadedBefore?: ReadonlySet<string>,
		explicitOff = false,
	): void => {
		const previous = skillSurfaceNames(state.activeSkillSurface).join(", ");
		const next = armedSkillSurface(policy);
		const current = skillSurfaceNames(next).join(", ");
		if (
			deps.session?.current() &&
			(explicitOff ||
				previous.length > 0 ||
				(policy?.loadedSkillNames.size ?? 0) > 0 ||
				(policy?.requests.length ?? 0) > 0)
		) {
			const entries = activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			// A loaded skill that declares no tool narrowing arms no surface, yet its
			// instructions are in context. Record it from the loading policy: an
			// unknown selection would block every later compaction of this session.
			const selection = next
				? mainSkillContextState(entries, next)
				: policy !== undefined && policy.loadedSkillNames.size > 0
					? mainSkillContextState(entries, policy)
					: { version: 1 as const, activationRefs: [] };
			const data = selection ?? { version: 1 as const, activationRefs: [], unknown: true as const };
			if (JSON.stringify(data) !== JSON.stringify(latestSkillContextState(entries))) {
				// Persist before changing live state: restart must not resurrect a cleared/replaced skill.
				deps.session.appendEntry({ kind: "custom", customType: SKILL_CONTEXT_STATE, parentTurnId: state.lastTurnId, data });
			}
		}
		const change = skillSurfaceChange(skillSurfaceNames(state.activeSkillSurface), next);
		state.activeSkillSurface = next;
		// The change itself is recorded, so a resumed transcript states the same
		// `§` row the live one did; the selection above is what compaction reads.
		if (change !== null && deps.session?.current()) {
			deps.session.appendEntry({
				kind: "custom",
				customType: SKILL_SURFACE_ENTRY,
				parentTurnId: state.lastTurnId,
				data: change,
			});
		}
		const activated = skillSurfaceLabels(policy).filter((label) => !loadedBefore?.has(label.split(" ")[0] ?? label));
		if (activated.length > 0) {
			const loaded: SkillSurfaceChange = {
				version: 1,
				state: "loaded",
				names: activated.map((label) => label.split(" ")[0] ?? label),
				previous: [],
				allowedTools: [],
				disallowedTools: [],
			};
			emitNotice(
				policy?.allowListAdvisory === true && current.length === 0
					? `[PanCode] Skill activated: ${activated.join(", ")}. Its allowed-tools list is guidance in yolo; explicit disallowed-tools still apply.`
					: current.length > 0
						? deps.headless === true
							? `[PanCode] Skill activated: ${activated.join(", ")}. Its tool surface stays armed for the rest of this session.`
							: `[PanCode] Skill activated: ${activated.join(", ")}. Its tool surface stays armed across your next turns until another skill replaces it or you run /skill off.`
						: `[PanCode] Skill activated: ${activated.join(", ")}. It declares no tool narrowing.`,
				"info",
				HOST_STATUS_NOTICE_KEY,
				change !== null && change.state !== "cleared" ? change : loaded,
			);
		}
		if (change?.state === "cleared") {
			emitNotice(
				`[PanCode] Skill tool surface cleared: ${previous}. The full tool surface is back.`,
				"info",
				HOST_STATUS_NOTICE_KEY,
				change,
			);
		} else if (change?.state === "replaced" && activated.length === 0) {
			emitNotice(
				`[PanCode] Skill tool surface replaced: ${previous} by ${current}.`,
				"info",
				HOST_STATUS_NOTICE_KEY,
				change,
			);
		}
	};

	/**
	 * Transcript notice for an admission exit, carrying the reason the turn
	 * never started. Refusals that end the run report at `"error"` level; exits
	 * where the turn simply did not need to start keep `"info"`.
	 */
	const emitAdmissionNotice = (text: string, reason: string, level: ChatNoticeEvent["level"] = "info"): void => {
		emit({ type: "notice", level, surface: "transcript", text, admission: { reason } });
	};
	return { emit, refuseSkillRequests, emitFooterNotice, emitNotice, armSkillSurface, emitAdmissionNotice };
}
