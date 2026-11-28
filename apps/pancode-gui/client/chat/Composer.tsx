// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The composer. Every decision it makes lives in `composer-model.ts`; this file is
 * the wiring and the markup. Its stateless pieces of markup live beside it in
 * `ComposerAttachments`, `ComposerQueue`, `ComposerOptions`, `ComposerKeyboardHint`
 * and `ComposerCommand`, and the handles other surfaces use to reach it live in
 * `composer-registry.ts`.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 * 1. It reads the draft from a store outside React, and its props are scalars
 *    or memoized facts behind `memo`, so a streamed timeline delta does not
 *    re-render the textarea. Passing the whole `SessionSnapshot` in would undo
 *    that, and so would a `route` object rebuilt on every render.
 * 2. The textarea is never disabled while a turn runs. Only the submit changes
 *    meaning, and a draft typed mid-turn survives the turn.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	memo,
	Suspense,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { CommandRequest, QueueEditRequest, QueueSnapshot } from "../../contracts/steering.js";
import type { Client } from "../api/client.js";
import { queueSnapshot } from "../api/events.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { Keycaps } from "../interaction/Keycaps.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { useLayersActive } from "../interaction/use-shortcut.js";
import { countRender } from "../render/render-probe.js";
import { requestReport } from "../report/report-events.js";
import { PancodePulse, PULSE_SIZE } from "../shell/PancodeMark.js";
import { useSessionCommands } from "../shell/SessionControls.js";
import { useRenameSession } from "../shell/sessions.js";
import { useShell } from "../shell/shell-context.js";
import { taskTitle } from "../shell/shell-model.js";
import { AutonomyPill } from "./AutonomyPill.js";
import { persistAttachments, savedAttachments } from "./attachment-drafts.js";
import { readAttachment } from "./attachment-image.js";
import {
	type Attachment,
	admitAttachment,
	attachmentSize,
	decodeTextFile,
	type FileAttachment,
	type ImageAttachment,
} from "./attachments-model.js";
import { AttachmentList, AttachmentReview, PasteReview } from "./ComposerAttachments.js";
import { CommandOutcome, SlashLineHint } from "./ComposerCommand.js";
import { ComposerKeyboardHint } from "./ComposerKeyboardHint.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { QueuedMessages } from "./ComposerQueue.js";
import { useSessionControl } from "./ControlBanner.js";
import type { CommandFields } from "./command-model.js";
import { fitComposerField, initialEnterSends, rememberEnterSends, touchFirst } from "./composer-field.js";
import { type HistoryBrowse, readHistory, rememberPrompt, stepHistory } from "./composer-history.js";
import {
	attachAbility,
	attachmentBlock,
	type ComposerNotice,
	capabilityRefusal,
	clampIndex,
	composerDelivery,
	composerKeyAction,
	composerPlaceholder,
	composerSituation,
	draftEstimate,
	noticeForError,
	noticeForQueueEdit,
	noticeForRefusal,
	offersSteerChoice,
	paletteKeyAction,
	paletteStatus,
	projectQueue,
	queueAccess,
	restoredDraft,
	type SubmitIntent,
	sendingButtonLabel,
	shellNotice,
	slashNotice,
	steeringAffordances,
	steeringCheck,
	steerModeOffers,
	submitIntent,
	submitLabel,
	unreachable,
} from "./composer-model.js";
import { actionOpeners, commandRunners, focusHandlers, formOpeners } from "./composer-registry.js";
import { contextBaseline, invokeContextCommand } from "./context-command.js";
import type { ContextOperationRef } from "./context-command-model.js";
import { commandPresentation, contextCommandKind, startedByCommand } from "./context-command-model.js";
import { draftStore } from "./draft-store.js";
import { foldFleetRuns, isLiveRun, steerOutcome } from "./fleet-facts.js";
import { SuggestionPalette, suggestionOptionId } from "./MentionPalette.js";
import {
	applyMention,
	mentionAgents,
	mentionPickVerb,
	mentionQuery,
	parseSteerMention,
	type RunningRun,
	resolveSteerTarget,
	steerRefusal,
	suggestionList,
} from "./mention-model.js";
import { HistorySearch, preloadPanels, VisualActions } from "./on-demand-panels.js";
import { usePaneActions } from "./pane-context.js";
import { pastedImages, pastedTextName, pasteStaysNative, planPaste } from "./paste-model.js";
import { queuePollInterval } from "./queue-poll-model.js";
import { openRoutePicker, RoutePicker } from "./RoutePicker.js";
import type { RouteFacts } from "./route.js";
import { SlashActionDialog, SlashPalette, slashOptionId } from "./SlashPalette.js";
import {
	aliasEntries,
	argumentSuggestions,
	completedDraft,
	exactEntry,
	extensionEntries,
	filterSlashEntries,
	parseSlashLine,
	promptEntries,
	resolveAlias,
	type SlashAction,
	type SlashAlias,
	type SlashEntry,
	slashEntries,
	slashQuery,
} from "./slash-model.js";
import { useOutputDetail } from "./use-output-detail.js";
import "./composer-box.css";
import "./composer.css";
import { sessionCapabilitiesQuery, sessionCommandsQuery } from "../api/queries.js";

export interface ComposerProps {
	readonly client: Client;
	readonly sessionId: string;
	/** The workspace an `@` reference is completed against. */
	readonly workspaceId: string;
	readonly sessionState: SessionSnapshot["state"];
	readonly initialFocus: boolean;
	/** The id of the turn running right now, or null when none is. */
	readonly runningTurnId: string | null;
	readonly contextRunning?: boolean;
	/** The session's latest context operation, so a context command does not repeat the card that reports it. */
	readonly contextOperation?: ContextOperationRef | null;
	/** Where the next request goes. Memoize it: a new object on every render re-renders the field. */
	readonly route: RouteFacts;
}

export const Composer = memo(function Composer({
	client,
	sessionId,
	workspaceId,
	sessionState,
	initialFocus,
	runningTurnId,
	contextRunning = false,
	contextOperation = null,
	route,
}: ComposerProps) {
	countRender("composer");
	const queries = useQueryClient();
	const store = draftStore(sessionId);
	const draft = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	const field = useRef<HTMLTextAreaElement | null>(null);
	const sending = useRef(false);
	const commandSending = useRef(false);
	const fieldId = useId();
	const hintId = useId();
	const [enterSends, setEnterSends] = useState(initialEnterSends);
	const options = useRef<HTMLDetailsElement | null>(null);
	const [optionsOpen, setOptionsOpen] = useState(false);
	const [actionsOpen, setActionsOpen] = useState(false);
	const [actionsInitial, setActionsInitial] = useState<string | null>(null);
	const [actionDrafts, setActionDrafts] = useState<Record<string, CommandFields>>({});
	useDetailsDismiss(options);
	const [attachments, setAttachments] = useState<Attachment[]>(() => savedAttachments(sessionId));
	const [attachmentsStored, setAttachmentsStored] = useState(true);
	const [reviewingAttachment, setReviewingAttachment] = useState<string | null>(null);
	const [readingAttachments, setReadingAttachments] = useState(false);
	const attachmentReads = useRef(0);
	const [attachProblem, setAttachProblem] = useState<string | null>(null);
	const [pasteReview, setPasteReview] = useState<{ text: string; reason: string; bytes: number } | null>(null);
	const [pasteNotice, setPasteNotice] = useState<{ id: string; text: string } | null>(null);
	const attached = useRef<Attachment[]>(attachments);
	const picker = useRef<HTMLInputElement | null>(null);
	const pickerId = useId();
	const layerOwned = useLayersActive();
	const running = runningTurnId !== null;
	const { viewing: controller, take } = useSessionControl(
		client,
		sessionId,
		sessionState === "open" || sessionState === "parked",
	);
	const viewing = controller?.label ?? null;
	const params = { params: { id: sessionId }, query: {}, body: {} };
	useEffect(() => {
		setAttachmentsStored(persistAttachments(sessionId, attachments));
	}, [sessionId, attachments]);

	useEffect(() => {
		const focus = () => field.current?.focus();
		focusHandlers.set(sessionId, focus);
		return () => {
			if (focusHandlers.get(sessionId) === focus) focusHandlers.delete(sessionId);
		};
	}, [sessionId]);
	useEffect(() => {
		if (initialFocus && sessionState === "open" && !touchFirst()) field.current?.focus();
	}, [initialFocus, sessionState]);

	// This runs only with the isolated draft, never with incoming transcript frames.
	// biome-ignore lint/correctness/useExhaustiveDependencies: draft.text is the resize trigger; the DOM read happens in the callback.
	useLayoutEffect(() => fitComposerField(field.current), [draft.text]);
	useEffect(() => {
		const fit = () => fitComposerField(field.current);
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);
	useEffect(() => rememberEnterSends(enterSends), [enterSends]);
	const [outputDetail, setOutputDetail] = useOutputDetail();
	const estimate = useMemo(
		() =>
			draftEstimate(draft.text, {
				files: attachments.filter((item): item is FileAttachment => item.kind === "file"),
				images: attachments.filter((item) => item.kind === "image").length,
			}),
		[draft.text, attachments],
	);

	// Read once per session and keep. Every steering route answers 409 when the
	// agent announced nothing, so this decides what is rendered at all.
	const capabilities = useQuery({
		...sessionCapabilitiesQuery(client, sessionId),
		enabled: sessionState === "open",
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const steering = steeringAffordances(capabilities.data);
	const modes = steerModeOffers(steering);

	// Read only when Actions opens or a draft starts with a slash. The template list changes on a
	// hub reload, so this observer lets it go stale where the palette does not.
	const slashDraft = draft.text.trimStart().startsWith("/");
	const commandCatalog = useQuery({
		...sessionCommandsQuery(client, sessionId),
		enabled: (actionsOpen || slashDraft) && sessionState === "open" && !!capabilities.data?.commands,
	});
	// The slash palette. The textarea stays the combobox and owns every key; the list only renders.
	const pane = usePaneActions();
	const listId = useId();
	const [activeIndex, setActiveIndex] = useState(0);
	// Escape closes the palette for the text it was pressed on; typing reopens it.
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [dialog, setDialog] = useState<SlashAction | null>(null);
	// The words a typed `/btw <question>` or `/draft <request>` carried, for the dialog's form to start from.
	const [dialogSeed, setDialogSeed] = useState("");
	const [slashError, setSlashError] = useState<string | null>(null);
	// What a typed terminal name said instead of running, kept until the draft it was said about changes.
	const [aliasNote, setAliasNote] = useState<{ text: string; message: string } | null>(null);
	const shell = useShell();
	const navigate = useNavigate();
	const renameTask = useRenameSession(client);
	// The branch tree is keyed on settled turns, the way the pane passes it.
	const [settledTurns, setSettledTurns] = useState(0);
	useEffect(() => {
		if (runningTurnId === null) setSettledTurns((count) => count + 1);
	}, [runningTurnId]);
	const slashFacts = useMemo(
		() => ({ capabilities: capabilities.data, catalog: commandCatalog.data, paneAvailable: pane !== null }),
		[capabilities.data, commandCatalog.data, pane],
	);
	const entries = useMemo(() => slashEntries(slashFacts), [slashFacts]);
	// Terminal names the app answers, then the agent's prompt templates and extension commands, are offered after
	// everything the task lists itself, and only in the slash list.
	const typedEntries = useMemo(() => {
		const listed = [...entries, ...aliasEntries(slashFacts, entries)];
		return [...listed, ...promptEntries(slashFacts, listed), ...extensionEntries(slashFacts, listed)];
	}, [entries, slashFacts]);
	const query = sessionState === "open" ? slashQuery(draft.text) : null;
	const matches = useMemo(() => (query === null ? [] : filterSlashEntries(typedEntries, query)), [typedEntries, query]);
	const paletteOpen = matches.length > 0 && dismissed !== draft.text && dialog === null && !actionsOpen;
	const active = clampIndex(activeIndex, matches.length);
	const line = slashDraft ? parseSlashLine(draft.text, commandCatalog.data) : null;

	// The `@` list. The caret is state only so the reference under it can be read during render; it
	// changes with typing and caret moves, never with transcript frames.
	const [caret, setCaret] = useState(0);
	const [mentionIndex, setMentionIndex] = useState(0);
	const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
	const mention =
		sessionState === "open" && !paletteOpen && draft.text.includes("@") ? mentionQuery(draft.text, caret) : null;
	const files = useQuery({
		queryKey: ["workspace-files", workspaceId, mention?.path ?? ""],
		queryFn: () =>
			client.call(routes.workspaceFiles, { params: { id: workspaceId }, query: { input: mention?.path ?? "" }, body: {} }),
		enabled: mention !== null && workspaceId !== "",
		staleTime: 4_000,
		retry: false,
		// The previous list stays up while the next keystroke's answer is on its way.
		placeholderData: (previous) => previous,
	});
	const fileMatches = mention === null ? [] : (files.data?.matches ?? []);
	// Read from the cache when the list is built, never subscribed to: the composer must not render
	// with the transcript.
	const liveRuns = (): readonly RunningRun[] =>
		foldFleetRuns(queries.getQueryData<SessionSnapshot>(["session", sessionId])?.fleet ?? []).filter(isLiveRun);
	const agents = mentionAgents(mention, running && steering.dispatch, liveRuns);
	const argMatches =
		!paletteOpen && slashDraft && mention === null ? argumentSuggestions(draft.text, commandCatalog.data) : [];
	const { rows: suggestions, key: suggestionKey } = suggestionList(mention, agents, fileMatches, argMatches, draft.text);
	const mentionOpen = suggestions.length > 0 && mentionDismissed !== suggestionKey && dialog === null && !actionsOpen;
	const mentionActive = clampIndex(mentionIndex, suggestions.length);
	const [steerNote, setSteerNote] = useState<{ tone: "success" | "warn" | "fail"; message: string } | null>(null);
	// A second Esc within this window stops the turn; the first only says so.
	const [stopArmed, setStopArmed] = useState(false);
	useEffect(() => {
		if (!stopArmed) return;
		const timer = setTimeout(() => setStopArmed(false), 2_000);
		return () => clearTimeout(timer);
	}, [stopArmed]);
	// What ↑ and ↓ recalled, so the next press continues from it instead of moving the caret.
	const browse = useRef<(HistoryBrowse & { readonly text: string }) | null>(null);
	// Ctrl+R: the sent messages read when the search opened, or null while it is closed.
	const [historySearch, setHistorySearch] = useState<readonly string[] | null>(null);
	// History search and the slash dialogs load apart from the task page; fetch them once it is idle.
	useEffect(() => preloadPanels(), []);
	// The draft a send judged as it stood; a /name in it is judged whole until the operator edits it.
	const [judgedSlash, setJudgedSlash] = useState<string | null>(null);
	const slashStage = draft.text === judgedSlash ? "submit" : "draft";
	const slash =
		slashDraft && line === null && !paletteOpen ? slashNotice(draft.text, commandCatalog.data, slashStage) : null;

	const queuePolicy = queueAccess(steering, sessionState, running);
	const queue = useQuery({
		queryKey: ["session-queue", sessionId],
		queryFn: () => client.call(routes.sessionQueue, params),
		enabled: queuePolicy.read,
		retry: false,
		// An agent with the queue capability pushes every change; an older one is asked while the queue can move.
		refetchInterval: (query) =>
			queuePollInterval(queuePolicy.read, Boolean(capabilities.data?.queue), running, query.state.data),
	});
	const queued = projectQueue(queue.data);
	const queueOps = capabilities.data?.queue?.ops;

	const send = useMutation({
		meta: { errorSurface: "inline" },
		// A request that never reached the server is tried again with the same idempotency key, so it lands once;
		// while the browser is offline the retry waits for the network instead of failing.
		retry: (failures, error) => failures < 3 && unreachable(error),
		mutationFn: async ({
			intent,
			attachments: sent,
		}: {
			intent: Exclude<SubmitIntent, { kind: "blocked" }>;
			draft: typeof draft;
			attachments: readonly Attachment[];
		}) => {
			if (intent.kind === "prompt") {
				const images = sent.filter((item): item is ImageAttachment => item.kind === "image");
				const files = sent.filter((item): item is FileAttachment => item.kind === "file");
				await client.call(
					routes.turn,
					{
						...params,
						body: {
							text: intent.text,
							...(images.length > 0 ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
							...(files.length > 0 ? { files: files.map(({ name, text }) => ({ name, text })) } : {}),
						},
					},
					intent.idempotencyKey,
				);
				return null;
			}
			if (intent.kind === "shell") {
				await client.call(
					routes.shellSession,
					{
						...params,
						body: {
							command: intent.command,
							...(intent.excludeFromContext ? { excludeFromContext: true } : {}),
						},
					},
					intent.idempotencyKey,
				);
				return null;
			}
			return client.call(
				routes.steerSession,
				{ ...params, body: { text: intent.text, mode: intent.mode } },
				intent.idempotencyKey,
			);
		},
		onSuccess: (result, submitted) => {
			if (result !== null && !result.accepted) store.refuse(submitted.draft);
			else store.acknowledge(submitted.draft);
			if (result === null && submitted.attachments.length > 0) {
				// A refusal from an earlier pick described a file that is not going anywhere now.
				setAttachProblem(null);
				const sent = new Set(submitted.attachments.map((item) => item.id));
				attached.current = attached.current.filter((image) => !sent.has(image.id));
				setAttachments(attached.current);
			}
			// The event stream normally paints the turn. A snapshot also catches up if
			// this browser was reconnecting when the request was accepted.
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			if (result !== null) void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
		},
		onError: (error, submitted) => {
			// A 409 is a definite server refusal and is cached by its idempotency key.
			// Network failures are ambiguous, so they keep the key for a safe retry.
			if (capabilityRefusal(error) !== null) store.refuse(submitted.draft);
		},
		onSettled: () => {
			sending.current = false;
		},
	});

	const interrupt = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: () => client.call(routes.interruptSession, { ...params, body: {} }),
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["session", sessionId] }),
	});
	const { controls } = useSessionCommands();
	const control = controls.records.find((row) => row.sessionId === sessionId && row.stage !== "complete");
	// A confirmed stop settles before the turn's own end arrives. Until it does, the control keeps saying
	// Stopping rather than flicking back to Stop for the few frames in between.
	const stopping =
		control ??
		controls.records.find(
			(row) =>
				row.sessionId === sessionId &&
				row.action === "stop" &&
				row.stage === "complete" &&
				!row.nothingStopped &&
				row.turnId !== null &&
				row.turnId === runningTurnId,
		);
	const stopTurn = () => {
		if (!runningTurnId) return;
		const snapshot = queries.getQueryData<SessionSnapshot>(["session", sessionId]);
		controls.start(
			{
				id: sessionId,
				workspaceId,
				title: snapshot ? taskTitle(snapshot) : "Conversation",
				currentTurnId: runningTurnId,
			},
			"stop",
		);
	};
	const command = useMutation({
		meta: { errorSurface: "inline" },
		onSettled: () => {
			commandSending.current = false;
		},
		mutationFn: ({
			request,
			key,
			baseline,
		}: {
			request: CommandRequest;
			key: string;
			description: string;
			sent: string | null;
			/** The context operation on record when the command was sent, so the one it opens can be told apart. */
			baseline: string | null;
		}) => invokeContextCommand({ client, queries, sessionId, request, baseline, key }),
		onSuccess: (_result, submitted) => {
			// A typed line is cleared once it ran, and only if it was not edited in the meantime.
			if (submitted.sent !== null && store.snapshot().text === submitted.sent) store.clear();
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			if (submitted.request.command === "tasks")
				void queries.invalidateQueries({ queryKey: ["session-board", sessionId] });
		},
	});
	const runCommand = (plan: { request: CommandRequest; description: string }, sent: string | null) => {
		if (commandSending.current || command.isPending || contextRunning || control) return;
		commandSending.current = true;
		setSlashError(null);
		command.mutate({
			request: plan.request,
			key: crypto.randomUUID(),
			description: plan.description,
			sent,
			baseline: contextBaseline(queries, sessionId),
		});
	};
	const runNamed = useRef<(name: string) => boolean>(() => false);
	runNamed.current = (name) => {
		const parsed = parseSlashLine(`/${name}`, commandCatalog.data);
		if (parsed?.kind !== "command") return false;
		runCommand(parsed.plan, null);
		return true;
	};
	useEffect(() => {
		const open = (action: SlashAction) => {
			if (action === "report") return requestReport({ sessionId });
			setDialogSeed("");
			setDialog(action);
		};
		const form = (name: string) => {
			setActionsInitial(name);
			setActionsOpen(true);
		};
		actionOpeners.set(sessionId, open);
		formOpeners.set(sessionId, form);
		return () => {
			if (actionOpeners.get(sessionId) === open) actionOpeners.delete(sessionId);
			if (formOpeners.get(sessionId) === form) formOpeners.delete(sessionId);
		};
	}, [sessionId]);
	useEffect(() => {
		const run = (name: string) => runNamed.current(name);
		commandRunners.set(sessionId, run);
		return () => {
			if (commandRunners.get(sessionId) === run) commandRunners.delete(sessionId);
		};
	}, [sessionId]);
	// A context command's operation card reports its progress and result. The command line steps aside for
	// it, and only for it: a refusal before any operation began has no card and keeps its own output.
	const commandKind = command.variables ? contextCommandKind(command.variables.request) : null;
	const cardRunsCommand =
		command.variables !== undefined &&
		startedByCommand(commandKind, sessionId, command.variables.baseline, contextOperation) !== null;
	const commandShown = command.data ? commandPresentation(command.data.result, command.data.owner) : null;
	const placeCaret = (at: number | null) =>
		requestAnimationFrame(() => {
			const element = field.current;
			if (!element) return;
			element.focus();
			const position = at ?? element.value.length;
			element.setSelectionRange(position, position);
			setCaret(position);
		});
	const placeCaretAtEnd = () => placeCaret(null);
	// The terminal's Files pane picks a file to mention; here an `@` at the caret opens the same pick.
	const startMention = () => {
		const element = field.current;
		const text = store.snapshot().text;
		const at = element ? element.selectionEnd : text.length;
		const before = text.slice(0, at);
		const insert = before === "" || /\s$/u.test(before) ? "@" : " @";
		store.write(`${before}${insert}${text.slice(at)}`);
		placeCaret(at + insert.length);
	};
	const insertLine = (element: HTMLTextAreaElement) => {
		const { selectionStart, selectionEnd, value } = element;
		store.write(`${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`);
		placeCaret(selectionStart + 1);
	};
	const pickSuggestion = (index: number) => {
		setMentionIndex(0);
		if (mention === null) {
			const row = argMatches[index];
			if (!row) return;
			store.write(row.draft);
			placeCaretAtEnd();
			return;
		}
		const agent = agents[index];
		const file = fileMatches[index - agents.length];
		if (!agent && !file) return;
		const edit = agent
			? { text: `@${agent.agentId} ${draft.text.slice(caret).trimStart()}`, caret: agent.agentId.length + 2 }
			: file
				? applyMention(draft.text, caret, mention, file.path, file.directory)
				: null;
		if (edit === null) return;
		store.write(edit.text);
		placeCaret(edit.caret);
	};
	const guide = useMutation({
		mutationFn: ({ run, message }: { run: RunningRun; message: string; sent: string }) =>
			client.call(routes.steerDispatchRun, {
				params: { id: sessionId },
				query: {},
				body: { runId: run.runId, action: "guide", message },
			}),
		onSuccess: (result, submitted) => {
			const outcome = steerOutcome("guide", result);
			setSteerNote({
				tone: outcome.tone === "success" ? "success" : "warn",
				message: `${submitted.run.agentId}: ${outcome.message}`,
			});
			if (result.accepted && store.snapshot().text === submitted.sent) store.clear();
		},
		onError: (error) =>
			setSteerNote({
				tone: capabilityRefusal(error) === null ? "fail" : "warn",
				message: capabilityRefusal(error) ?? (error instanceof Error ? error.message : String(error)),
			}),
	});
	const pick = (entry: SlashEntry) => {
		setActiveIndex(0);
		setSlashError(null);
		if (entry.kind === "command") {
			const parsed = entry.needsArgs ? null : parseSlashLine(`/${entry.name}`, commandCatalog.data);
			if (parsed?.kind === "command") {
				store.clear();
				runCommand(parsed.plan, null);
				return;
			}
			// Required arguments: complete the name and let the operator type them; Enter then runs it.
			store.write(completedDraft(entry));
			placeCaretAtEnd();
			return;
		}
		// A template's arguments are free text the hint only describes, so picking one leaves it to finish; one
		// without a hint runs bare, as the terminal runs it, and one that cannot expand keeps the list and its reason.
		if (entry.kind === "prompt") {
			if (entry.unavailable !== null) return;
			if (entry.runsBare) {
				store.write(`/${entry.name}`);
				submit();
				return;
			}
			store.write(completedDraft(entry));
			placeCaretAtEnd();
			return;
		}
		if (entry.kind === "extension") {
			store.write(`/${entry.name}`);
			submit();
			return;
		}
		if (entry.kind === "alias") {
			if (entry.alias.needsText) {
				store.write(completedDraft(entry));
				placeCaretAtEnd();
			} else runAlias(entry.alias, "");
			return;
		}
		store.clear();
		if (entry.kind === "pane") pane?.show(entry.view);
		else if (entry.action === "report") requestReport({ sessionId });
		else setDialog(entry.action);
	};
	// A terminal name runs the app's own control for it. A notice keeps the draft; anything else clears it,
	// as a command does once it ran.
	const runAlias = (alias: SlashAlias, rest: string) => {
		setSlashError(null);
		const note = (message: string) => setAliasNote({ text: store.snapshot().text, message });
		const target = alias.target;
		if (target.kind === "notice") return note(target.message);
		if (target.kind === "command") {
			const line = `/${target.command} ${target.subcommand}${target.passRest && rest !== "" ? ` ${rest}` : ""}`;
			const parsed = parseSlashLine(line, commandCatalog.data);
			if (parsed === null) return note(`/${alias.name} is not available in this session.`);
			if (parsed.kind === "invalid") return note(parsed.error);
			runCommand(parsed.plan, store.snapshot().text);
			return;
		}
		if (target.kind === "control" && target.control === "rename") {
			if (rest === "") return note("Type a name after /rename, or click the session title.");
			renameTask.mutate(
				{ sessionId, workspaceId, label: rest },
				{ onError: (error) => setAliasNote({ text: store.snapshot().text, message: error.message }) },
			);
		}
		setAliasNote(null);
		store.clear();
		if (target.kind === "pane") pane?.show(target.view);
		else if (target.kind === "action") {
			setDialogSeed(rest);
			setDialog(target.action);
		} else if (target.kind === "navigate") void navigate(target.path);
		else if (target.control === "mention") startMention();
		else if (target.control === "help") shell?.openHelp();
		else if (target.control === "new") shell?.startTask();
		else if (target.control === "model" && !openRoutePicker(sessionId))
			void navigate(`/settings/models?${new URLSearchParams({ workspace: workspaceId })}`);
	};

	const drain = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: () => client.call(routes.clearSessionQueue, { ...params, body: {} }),
		onSuccess: (result) => {
			store.write(restoredDraft(store.snapshot().text, result.restored));
			void queries.invalidateQueries({ queryKey: ["session-queue", sessionId] });
			field.current?.focus();
		},
	});
	const [queueNote, setQueueNote] = useState<ComposerNotice | null>(null);
	const edit = useMutation({
		mutationFn: (request: QueueEditRequest) =>
			client.call(routes.editSessionQueue, { ...params, body: request }, crypto.randomUUID()),
		onMutate: () => setQueueNote(null),
		onSuccess: (result, request) => {
			queries.setQueryData<QueueSnapshot>(["session-queue", sessionId], queueSnapshot(result.entries));
			setQueueNote(noticeForQueueEdit(result));
			if (request.op === "restore" && result.applied && result.text !== undefined) {
				store.write(restoredDraft(store.snapshot().text, [result.text]));
				placeCaretAtEnd();
			}
			if (request.op === "send_now") void queries.invalidateQueries({ queryKey: ["session", sessionId] });
		},
		onError: (error) => setQueueNote(noticeForError(error)),
	});
	// What the engine said about one turn's interrupt, stop or queue is not a fact about the next
	// turn: without this an interrupt refusal stayed under the composer for the rest of the session.
	const resetInterrupt = interrupt.reset;
	const resetDrain = drain.reset;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the turn id is the trigger; the resets are stable.
	useEffect(() => {
		resetInterrupt();
		resetDrain();
		setQueueNote(null);
	}, [runningTurnId]);

	const steeringUnavailable = steeringCheck(capabilities);
	const unknownSlash = slashNotice(draft.text, commandCatalog.data, slashStage)?.message;
	const situation = composerSituation({
		sessionState,
		running,
		send,
		control,
		steering,
		steeringUnavailable,
		shell: capabilities.data?.shell !== undefined,
		viewing,
		unknownSlash,
	});
	const intent = submitIntent(draft, situation);
	const sendingLabel = sendingButtonLabel(situation);
	const delivery = composerDelivery(situation, draft.mode, contextRunning, readingAttachments);
	const reviewedAttachment = attachments.find((item) => item.id === reviewingAttachment) ?? null;
	const { canAttachImages, canAttachFiles, canAttach, attachLabel } = attachAbility(capabilities.data, sessionState);
	const attachBlock = attachmentBlock(intent.kind, attachments, capabilities.data, running, contextRunning);
	const shellHint = shellNotice(draft.text, situation.shell);
	const steerChoice = offersSteerChoice(running, modes, draft.text);
	// An image goes as an image when the agent takes them; anything else is offered as text.
	const readPicked = async (file: File): Promise<Attachment> => {
		if (file.type.startsWith("image/") && canAttachImages) return readAttachment(file, crypto.randomUUID());
		const name = file.name || "Pasted file";
		if (!canAttachFiles) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image.`);
		const read = decodeTextFile(name, new Uint8Array(await file.arrayBuffer()));
		if (!read.ok) throw new Error(read.reason);
		return { id: crypto.randomUUID(), kind: "file", name, text: read.text, bytes: read.bytes };
	};
	// One at a time, so each admission sees the attachments the previous one added.
	const attach = async (files: readonly File[]) => {
		if (sending.current) return;
		attachmentReads.current++;
		setReadingAttachments(true);
		setAttachProblem(null);
		try {
			for (const file of files) {
				try {
					const item = await readPicked(file);
					const admitted = admitAttachment(attached.current, item);
					if (!admitted.ok) {
						setAttachProblem(admitted.reason);
						break;
					}
					store.attachmentsChanged();
					attached.current = [...attached.current, item];
					setAttachments(attached.current);
				} catch (error) {
					setAttachProblem(error instanceof Error ? error.message : String(error));
				}
			}
		} finally {
			attachmentReads.current--;
			setReadingAttachments(attachmentReads.current > 0);
		}
	};
	const detach = (id: string) => {
		if (sending.current) return;
		store.attachmentsChanged();
		attached.current = attached.current.filter((image) => image.id !== id);
		setAttachments(attached.current);
		setAttachProblem(null);
	};
	// Recomputed from the store rather than closed over, so a keystroke that
	// lands between render and keydown still sends the text the operator sees.
	const submit = () => {
		if (sending.current || attachmentReads.current > 0 || (contextRunning && !running) || control) return;
		const current = store.snapshot();
		// `@agent text` guides a running worker instead of the main turn. With no worker running the
		// line is an ordinary message, and its `@word` an ordinary file reference.
		const steerTo = steering.dispatch ? parseSteerMention(current.text) : null;
		const runs = steerTo === null ? [] : liveRuns();
		if (steerTo !== null && runs.length > 0) {
			const target = resolveSteerTarget(steerTo.target, runs);
			if (target.kind === "match") {
				if (guide.isPending) return;
				setSteerNote(null);
				rememberPrompt(current.text);
				guide.mutate({ run: target.run, message: steerTo.text, sent: current.text });
			} else setSteerNote({ tone: "warn", message: steerRefusal(steerTo.target, target, runs) });
			return;
		}
		// A line naming a session action or a catalog command runs it instead of becoming a prompt.
		// Anything else that starts with a slash, a prompt template say, still goes to the agent.
		if (sessionState === "open" && current.text.trimStart().startsWith("/")) {
			const exact = exactEntry(typedEntries, current.text);
			if (exact?.kind === "alias") {
				rememberPrompt(current.text);
				runAlias(exact.alias, "");
				return;
			}
			if (exact) {
				pick(exact);
				return;
			}
			const parsed = parseSlashLine(current.text, commandCatalog.data);
			if (parsed?.kind === "invalid") {
				setSlashError(parsed.error);
				return;
			}
			if (parsed?.kind === "command") {
				rememberPrompt(current.text);
				runCommand(parsed.plan, current.text);
				return;
			}
			const typed = parsed === null ? resolveAlias(current.text, slashFacts) : null;
			if (typed !== null) {
				rememberPrompt(current.text);
				runAlias(typed.alias, typed.rest);
				return;
			}
		}
		const currentSlash = slashNotice(current.text, commandCatalog.data, "submit")?.message;
		if (currentSlash !== undefined) setJudgedSlash(current.text);
		const { unknownSlash: _, ...rest } = situation;
		const next = submitIntent(current, currentSlash === undefined ? rest : { ...rest, unknownSlash: currentSlash });
		if (
			next.kind !== "blocked" &&
			attachmentBlock(next.kind, attached.current, capabilities.data, running, contextRunning) === null
		) {
			sending.current = true;
			browse.current = null;
			rememberPrompt(current.text);
			store.markSubmitted(current);
			send.mutate({ intent: next, draft: current, attachments: attached.current });
		}
	};

	const notice =
		noticeForError(send.error ?? interrupt.error ?? drain.error) ??
		queueNote ??
		noticeForRefusal(send.data) ??
		noticeForRefusal(interrupt.data);

	return (
		<>
			<form
				className="composer composer--conversation"
				data-steering={steerChoice ? "" : undefined}
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
				onDragOver={(event) => {
					if (canAttach && !send.isPending && event.dataTransfer.types.includes("Files")) event.preventDefault();
				}}
				onDrop={(event) => {
					if (!canAttach || send.isPending || event.dataTransfer.files.length === 0) return;
					event.preventDefault();
					void attach([...event.dataTransfer.files]);
				}}
			>
				<div className="composer__delivery-note" data-tone={delivery.tone} data-quiet={delivery.quiet}>
					<strong>{delivery.label}</strong>
					<span>{viewing !== null && take.error ? take.error.message : delivery.detail}</span>
					{viewing !== null ? (
						<button
							type="button"
							className="composer__secondary composer__take-control"
							disabled={take.isPending}
							onClick={() => take.mutate()}
						>
							{take.isPending ? "Taking control…" : "Take control"}
						</button>
					) : null}
				</div>
				{/* The server refuses every change from a window that only views the task, so none is offered. */}
				<fieldset className="composer__body" disabled={viewing !== null}>
					<label className="composer__label sr-only" htmlFor={fieldId}>
						Message PanCode
					</label>
					{historySearch !== null ? (
						<Suspense fallback={null}>
							<HistorySearch
								entries={historySearch}
								onAccept={(match) => {
									setHistorySearch(null);
									store.write(match.text);
									// From the taken message ↓ steps on to newer ones and back to the draft it replaced.
									browse.current = { index: match.index, stash: draft.text, text: match.text };
									placeCaretAtEnd();
								}}
								onCancel={(refocus) => {
									setHistorySearch(null);
									if (refocus) placeCaretAtEnd();
								}}
							/>
						</Suspense>
					) : paletteOpen ? (
						<SlashPalette listId={listId} entries={matches} activeIndex={active} onActivate={setActiveIndex} onPick={pick} />
					) : mentionOpen ? (
						<SuggestionPalette
							listId={listId}
							label={mention !== null ? "Files in this workspace" : "Command arguments"}
							rows={suggestions}
							activeIndex={mentionActive}
							onActivate={setMentionIndex}
							onPick={pickSuggestion}
							keys={
								mention !== null ? (
									<>
										<Keycaps chord="Enter" /> or <Keycaps chord="Tab" /> {mentionPickVerb(mentionActive, agents, fileMatches)} ·{" "}
										<Keycaps chord="Esc" /> close{files.data?.truncated ? " · keep typing to narrow" : ""}
									</>
								) : (
									<>
										<Keycaps chord="Tab" /> pick · <Keycaps chord="Enter" /> {line?.kind === "command" ? "runs the line" : "pick"}{" "}
										· <Keycaps chord="Esc" /> close
									</>
								)
							}
						/>
					) : line !== null && dialog === null ? (
						<SlashLineHint line={line} slashError={slashError} enterSends={enterSends} />
					) : null}
					<p className="sr-only" role="status">
						{paletteStatus(paletteOpen ? matches.length : 0, mentionOpen ? suggestions.length : 0)}
					</p>
					{/* A stopped turn can leave held messages waiting for the operator. */}
					{queuePolicy.read && queued.length > 0 ? (
						<QueuedMessages
							queued={queued}
							running={running}
							queueOps={queueOps}
							sendNow={queuePolicy.sendNow}
							drain={drain}
							edit={edit}
						/>
					) : null}
					{attachments.length > 0 ? (
						<AttachmentList
							attachments={attachments}
							pending={send.isPending}
							onReview={setReviewingAttachment}
							onRemove={(id) => {
								detach(id);
								field.current?.focus();
							}}
						/>
					) : null}
					{pasteNotice && attachments.some((item) => item.id === pasteNotice.id) ? (
						<p className="composer__paste-note" role="status">
							<Icon name="paperclip" />
							{pasteNotice.text}
						</p>
					) : null}
					{attachments.length > 0 && !attachmentsStored ? (
						<p className="composer__paste-note" role="status">
							Browser draft storage is unavailable. These attachments are kept in memory; save them before reloading this tab.
						</p>
					) : null}
					{pasteReview ? <PasteReview pasteReview={pasteReview} onDismiss={() => setPasteReview(null)} /> : null}
					<textarea
						id={fieldId}
						ref={field}
						className="composer__field"
						aria-autocomplete="list"
						{...(paletteOpen
							? {
									"aria-controls": listId,
									"aria-activedescendant": matches[active] ? slashOptionId(listId, matches[active]) : undefined,
								}
							: mentionOpen
								? { "aria-controls": listId, "aria-activedescendant": suggestionOptionId(listId, mentionActive) }
								: {})}
						aria-describedby={hintId}
						value={draft.text}
						// Text already on its way is not a draft being written: an approval that lands first may take focus.
						{...(send.isPending && send.variables?.draft.text === draft.text ? { "data-sent": "" } : {})}
						rows={1}
						// A paused task keeps its draft editable without waking its agent.
						disabled={sessionState !== "open" && sessionState !== "parked"}
						placeholder={composerPlaceholder(sessionState, viewing, running, steering, initialFocus)}
						onChange={(event) => {
							store.write(event.target.value);
							setCaret(event.target.selectionStart);
							setMentionIndex(0);
							setMentionDismissed(null);
							setSteerNote(null);
							setStopArmed(false);
							browse.current = null;
							setActiveIndex(0);
							setSlashError(null);
							if (!event.target.value.startsWith("/")) setDismissed(null);
							if (!send.isPending && !send.isIdle) send.reset();
						}}
						onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
						onPaste={(event) => {
							if (sending.current && event.clipboardData.files.length > 0) {
								event.preventDefault();
								setAttachProblem("Wait for this send to finish before adding attachments.");
								return;
							}
							const images = pastedImages([...event.clipboardData.files], canAttachImages);
							if (images.length > 0) {
								event.preventDefault();
								void attach(images);
								return;
							}
							const paste = event.clipboardData.getData("text/plain");
							if (pasteStaysNative(paste, store.snapshot().text)) return;
							event.preventDefault();
							const field = event.currentTarget;
							const plan = planPaste(
								paste,
								store.snapshot().text,
								field.selectionStart,
								field.selectionEnd,
								canAttachFiles && !sending.current,
								pastedTextName(attached.current),
							);
							setPasteNotice(null);
							if (plan.kind === "review") {
								setPasteReview(plan);
								return;
							}
							if (plan.kind === "file") {
								const file: FileAttachment = { ...plan.file, id: crypto.randomUUID() };
								const admission = admitAttachment(attached.current, file);
								if (!admission.ok) {
									setPasteReview({ text: paste, reason: admission.reason, bytes: file.bytes });
									return;
								}
								store.attachmentsChanged();
								attached.current = [...attached.current, file];
								setAttachments(attached.current);
								setPasteNotice({
									id: file.id,
									text: `Full paste attached as ${file.name} · ${attachmentSize(file.bytes)}`,
								});
							}
							setPasteReview(null);
							store.write(plan.text);
							if (!send.isPending && !send.isIdle) send.reset();
							requestAnimationFrame(() => field.setSelectionRange(plan.caret, plan.caret));
						}}
						onKeyDown={(event) => {
							if (!event.nativeEvent.isComposing && matchesKeybinding(KEYBINDINGS.historySearch, event)) {
								event.preventDefault();
								setHistorySearch(readHistory());
								return;
							}
							// The stop chord never types into the draft; the page-level shortcut does the stopping.
							if (matchesKeybinding(KEYBINDINGS.cancelTurn, event)) {
								event.preventDefault();
								return;
							}
							if (!event.nativeEvent.isComposing && matchesKeybinding(KEYBINDINGS.mentionFile, event)) {
								event.preventDefault();
								startMention();
								return;
							}
							if (matchesKeybinding(KEYBINDINGS.queue, event)) {
								event.preventDefault();
								const row = document.querySelector<HTMLElement>(".composer__queue-actions button:not(:disabled)");
								if (row) row.focus();
								else setQueueNote({ tone: "warn", message: "No messages are waiting on the engine." });
								return;
							}
							// Alt+S delivers the draft as immediate direction, whichever delivery is chosen.
							if (
								!event.nativeEvent.isComposing &&
								matchesKeybinding(KEYBINDINGS.sendNow, event) &&
								running &&
								draft.text.trim() !== "" &&
								modes.some((offer) => offer.mode === "next-slot")
							) {
								event.preventDefault();
								store.chooseMode("next-slot");
								if (!send.isPending && !send.isIdle) send.reset();
								submit();
								return;
							}
							if (paletteOpen && !event.nativeEvent.isComposing) {
								const key = paletteKeyAction(event, active, matches.length);
								if (key?.kind === "move") {
									event.preventDefault();
									setActiveIndex(key.index);
									return;
								}
								if (key?.kind === "pick") {
									event.preventDefault();
									const entry = matches[active];
									if (entry) pick(entry);
									return;
								}
								if (key?.kind === "dismiss") {
									// The palette is the innermost layer here; nothing behind it should also close.
									event.preventDefault();
									event.stopPropagation();
									setDismissed(draft.text);
									return;
								}
							}
							const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
							if (mentionOpen && !event.nativeEvent.isComposing) {
								// On a command line that can already run, Enter runs it and Tab takes the suggestion.
								const enterPicks = mention !== null || line?.kind !== "command";
								const key = paletteKeyAction(event, mentionActive, suggestions.length, enterPicks);
								if (key?.kind === "move") {
									event.preventDefault();
									setMentionIndex(key.index);
									return;
								}
								if (key?.kind === "pick") {
									event.preventDefault();
									pickSuggestion(mentionActive);
									return;
								}
								if (key?.kind === "dismiss") {
									event.preventDefault();
									event.stopPropagation();
									setMentionDismissed(suggestionKey);
									return;
								}
							}
							// Esc with nothing open stops the turn, as it does in the terminal, on the second press.
							if (event.key === "Escape" && plain && running && !layerOwned && !optionsOpen) {
								event.preventDefault();
								if (stopArmed && !stopping) stopTurn();
								setStopArmed(!stopArmed);
								return;
							}
							if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain && !event.nativeEvent.isComposing) {
								const element = event.currentTarget;
								const browsing = browse.current !== null && browse.current.text === draft.text ? browse.current : null;
								// ↑ recalls from the very start of the field, where there is no line above to move to.
								const offered =
									event.key === "ArrowUp"
										? browsing !== null || (element.selectionStart === 0 && element.selectionEnd === 0)
										: browsing !== null;
								const step = offered
									? stepHistory(readHistory(), browsing, event.key === "ArrowUp" ? "older" : "newer", draft.text)
									: null;
								if (step !== null) {
									event.preventDefault();
									store.write(step.text);
									browse.current = step.browse === null ? null : { ...step.browse, text: step.text };
									placeCaretAtEnd();
									return;
								}
							}
							const action = composerKeyAction(
								{
									key: event.key,
									altKey: event.altKey,
									ctrlKey: event.ctrlKey,
									metaKey: event.metaKey,
									shiftKey: event.shiftKey,
								},
								{ layerOwned, composing: event.nativeEvent.isComposing, plainEnterSends: enterSends },
							);
							if (action === "insert-line") {
								event.preventDefault();
								insertLine(event.currentTarget);
								return;
							}
							if (action !== "send") return;
							event.preventDefault();
							submit();
						}}
					/>
					{store.uncertainSubmission() && (
						<p className="composer__notice" role="status">
							<StatusMark tone="warn" label="Review draft" />A send may have finished before this page reloaded. Check the
							conversation above before sending this draft again.
							<button type="button" className="composer__secondary" onClick={() => store.clear()}>
								Discard draft
							</button>
						</p>
					)}
					{stopArmed && running ? (
						<p className="composer__notice" role="status">
							Press <Keycaps chord="Esc" /> again to stop this turn.
						</p>
					) : null}
					{steerNote ? (
						<p className="composer__notice" role={steerNote.tone === "fail" ? "alert" : "status"}>
							<StatusMark
								tone={steerNote.tone}
								label={steerNote.tone === "success" ? "Sent to agent" : steerNote.tone === "fail" ? "Failed" : "Not sent"}
							/>
							{steerNote.message}
						</p>
					) : null}
					{attachProblem ? (
						<p className="composer__notice" role="alert">
							<StatusMark tone="fail" label="Not attached" />
							{attachProblem}
						</p>
					) : null}
					<ComposerKeyboardHint
						hintId={hintId}
						enterSends={enterSends}
						sendsNow={running && modes.some((offer) => offer.mode === "next-slot")}
						attachments={attachments}
						estimate={estimate}
					/>
					<div className="composer__actions">
						<div className="composer__tools">
							{canAttach ? (
								<input
									ref={picker}
									id={pickerId}
									hidden
									type="file"
									{...(canAttachFiles ? {} : { accept: "image/png,image/jpeg,image/gif,image/webp" })}
									multiple
									onChange={(event) => {
										const files = [...(event.target.files ?? [])];
										event.target.value = "";
										void attach(files);
									}}
								/>
							) : null}
							<button
								type="button"
								className="composer__labeled-button"
								disabled={!canAttach || send.isPending || readingAttachments}
								title={
									send.isPending
										? "This request is being sent. You can attach files when it settles."
										: canAttach
											? attachLabel
											: "Attachments are unavailable for this session"
								}
								onClick={() => picker.current?.click()}
							>
								<Icon name="paperclip" />
								{readingAttachments ? "Reading…" : "Attach"}
							</button>
							<button
								type="button"
								className="composer__labeled-button composer__actions-button"
								aria-haspopup="dialog"
								aria-expanded={actionsOpen}
								disabled={sessionState !== "open"}
								onClick={() => {
									setActionsInitial(null);
									setActionsOpen(true);
								}}
							>
								<Icon name="overview" />
								Actions
							</button>
							<ComposerOptions
								options={options}
								onOpenChange={setOptionsOpen}
								canInterrupt={running && steering.interrupt}
								interrupt={interrupt}
								outputDetail={outputDetail}
								onOutputDetail={setOutputDetail}
								enterSends={enterSends}
								onEnterSends={setEnterSends}
							/>
							<AutonomyPill
								client={client}
								sessionId={sessionId}
								capabilities={capabilities.data}
								locked={running}
								chord={sessionState === "open"}
							/>
						</div>
						<div className="composer__route-actions">
							<RoutePicker
								client={client}
								sessionId={sessionId}
								route={route}
								running={running}
								capabilities={capabilities.data}
								chord={sessionState === "open"}
							/>
							{steerChoice ? (
								<fieldset className="composer__delivery">
									<legend className="sr-only">Deliver this message</legend>
									{modes.map((offer) => (
										<button
											key={offer.mode}
											type="button"
											aria-pressed={draft.mode === offer.mode}
											aria-label={offer.label}
											title={`${offer.label}. ${offer.lands}`}
											disabled={send.isPending}
											onClick={() => {
												store.chooseMode(offer.mode);
												if (!send.isPending && !send.isIdle) send.reset();
											}}
										>
											<span className="composer__delivery-full">{offer.label}</span>
											<span className="composer__delivery-short">{offer.short}</span>
										</button>
									))}
								</fieldset>
							) : null}
							{running ? (
								<button
									className="composer__icon-button composer__stop composer__stop--live"
									type="button"
									disabled={!!stopping}
									onClick={() => stopTurn()}
									aria-label={stopping ? (stopping.stage === "unresolved" ? "Review stop request" : "Stopping…") : "Stop turn"}
									title="End this turn now. Nothing further is run."
								>
									<Icon name="stop" />
									<span aria-hidden="true">
										{stopping ? (stopping.stage === "unresolved" ? "Check request" : "Stopping") : "Stop"}
									</span>
								</button>
							) : null}
							{!running || draft.text.trim() !== "" ? (
								<button
									className="composer__submit primary"
									type="submit"
									disabled={intent.kind === "blocked" || attachBlock !== null || readingAttachments}
									aria-label={sendingLabel ?? submitLabel(intent, situation, draft.mode)}
									title={intent.kind === "blocked" ? intent.reason : (attachBlock ?? submitLabel(intent, situation, draft.mode))}
								>
									{send.isPending ? <PancodePulse size={PULSE_SIZE.row} /> : <Icon name="arrowUp" />}
									<span aria-hidden="true">{sendingLabel ?? submitLabel(intent, situation, draft.mode)}</span>
								</button>
							) : null}
						</div>
					</div>
					{attachBlock !== null && intent.kind !== "blocked" ? (
						<p className="composer__blocked" role="status">
							{attachBlock}
							{capabilities.error && (
								<button
									type="button"
									className="composer__secondary"
									disabled={capabilities.isFetching}
									onClick={() => void capabilities.refetch()}
								>
									Retry attachment support
								</button>
							)}
						</p>
					) : null}
					{intent.kind === "blocked" &&
					draft.text.trim() !== "" &&
					intent.reason !== delivery.detail &&
					intent.reason !== slash?.message ? (
						<p className="composer__blocked" role="status">
							{intent.reason}
							{running && steeringUnavailable === "failed" ? (
								<button
									type="button"
									className="composer__secondary"
									disabled={capabilities.isFetching}
									onClick={() => void capabilities.refetch()}
								>
									Retry control check
								</button>
							) : null}
						</p>
					) : null}
					{shellHint !== null && intent.kind === "shell" && attachBlock === null ? (
						<p className="composer__notice" role="status">
							<StatusMark tone="neutral" label="Shell" />
							{shellHint}
						</p>
					) : null}
					{aliasNote !== null && aliasNote.text === draft.text ? (
						<p className="composer__notice" role="status">
							<StatusMark tone="neutral" label="Not run" />
							{aliasNote.message}
						</p>
					) : null}
					{slash && !send.isPending ? (
						<p className="composer__notice" role="status">
							<StatusMark tone={slash.tone} label="Not a command" />
							{slash.message}
						</p>
					) : null}
					<CommandOutcome command={command} cardRunsCommand={cardRunsCommand} commandShown={commandShown} />
					{notice ? (
						<p className="composer__notice" role={notice.tone === "fail" ? "alert" : "status"}>
							<StatusMark tone={notice.tone} label={notice.tone === "fail" ? "Failed" : "Refused"} />
							{notice.message}
						</p>
					) : null}
				</fieldset>
			</form>
			{/* Outside the form: React bubbles a portaled panel's submit through its owner, and the
		    composer's own submit must never hear it. */}
			{reviewedAttachment ? (
				<AttachmentReview
					item={reviewedAttachment}
					pending={send.isPending}
					onClose={() => setReviewingAttachment(null)}
					onRemove={() => {
						detach(reviewedAttachment.id);
						setReviewingAttachment(null);
						field.current?.focus();
					}}
				/>
			) : null}
			{actionsOpen ? (
				<Suspense fallback={null}>
					<VisualActions
						entries={entries}
						paneAvailable={pane !== null}
						loading={capabilities.isPending || (!!capabilities.data?.commands && commandCatalog.isFetching)}
						error={capabilities.error?.message ?? commandCatalog.error?.message ?? null}
						onRetry={() => {
							void capabilities.refetch();
							if (capabilities.data?.commands) void commandCatalog.refetch();
						}}
						busy={command.isPending || contextRunning || sessionState !== "open" || !!control}
						running={running}
						formDrafts={actionDrafts}
						onFormDraft={(id, fields) => setActionDrafts((drafts) => ({ ...drafts, [id]: fields }))}
						{...(actionsInitial !== null ? { initial: actionsInitial } : {})}
						onClose={() => setActionsOpen(false)}
						onPick={(entry) => {
							setActionsOpen(false);
							if (entry.kind === "pane") pane?.show(entry.view);
							else if (entry.kind === "action" && entry.action === "report") requestReport({ sessionId });
							else if (entry.kind === "action") setDialog(entry.action);
						}}
						onShowChanges={() => {
							setActionsOpen(false);
							pane?.show("changes");
						}}
						onRun={(plan) => {
							if (command.isPending || contextRunning || sessionState !== "open" || control) return;
							runCommand(plan, null);
							setActionsOpen(false);
						}}
					/>
				</Suspense>
			) : null}
			{dialog !== null ? (
				<SlashActionDialog
					action={dialog}
					client={client}
					sessionId={sessionId}
					sessionOpen={sessionState === "open" && !control}
					capabilities={capabilities.data}
					running={running}
					settledTurns={settledTurns}
					seed={dialogSeed}
					onClose={() => {
						setDialog(null);
						setDialogSeed("");
						placeCaretAtEnd();
					}}
				/>
			) : null}
		</>
	);
});
