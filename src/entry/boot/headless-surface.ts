// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { segmentUsageFromView } from "../../cli/modes/json-stream.js";
import { runHeadlessMainAgent } from "../../cli/modes/print.js";
import { startRunOutput, writeLocalAnswer, writeRunDiagnostic } from "../../cli/run-failure.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../core/headless-permission.js";
import { recordPackActivity } from "../../core/pack-activity.js";
import { narrowTurnConstraints, templateTurnConstraints } from "../../core/turn-constraints.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { runUsageFromCallRecords } from "../../domains/dispatch/index.js";
import { installedExtensionClaims } from "../../domains/extensions/index.js";
import { saveTaskBankSnapshot } from "../../domains/memory/task-bank-store.js";
import { unpricedRunRoutes } from "../../domains/providers/unpriced-routes.js";
import { expandSubmitReferences, submitDisplay } from "../../domains/resources/submit-expansion.js";
import { createRunCostCap, runCostCeilingUsd } from "../../domains/scheduling/budget.js";
import { runHeadlessCompaction } from "../../domains/session/index.js";
import { READ_MODEL_FOLD } from "../../domains/telemetry/index.js";
import type { ReloadTarget } from "../../session-control/reload-report.js";
import type { BootOptions } from "../boot-options.js";
import type { BootResult } from "../orchestrator.js";
import { createSessionExtensionHosting } from "../session-extension-hosting.js";
import type { BootSurfaceInput, BootSurfaceSeams } from "./surface.js";

/** A headless `pancode run`: one prompt against the wired session, then shutdown. `headless` is `options.headless`, narrowed. */
export async function runHeadlessSurface(
	surface: BootSurfaceInput,
	seams: BootSurfaceSeams,
	headless: NonNullable<BootOptions["headless"]>,
): Promise<BootResult> {
	const {
		activePathEntries,
		autonomyWindow,
		bumpSessionState,
		bus,
		chat,
		chatIdle,
		commitExtensionHooks,
		dispatch,
		getCurrentSettings,
		headlessGitHelpers,
		mcpSubmit,
		memoryOwner,
		printJsonSessionHeader,
		providers,
		recordBoot,
		reloadClasses,
		resources,
		result,
		session,
		startSessionExtensionHost,
		startupOverrides,
		taskMemoryBank,
		telemetry,
		termination,
		timer,
		toolRegistry,
	} = surface;
	const { cells } = surface;
	const { answerExtensionLine, parseSlashCommand, resolvePermission, subscribeLoopGuardStop } = seams;
	recordBoot();
	if (headless.compact) return runHeadlessCompaction(chat, headless.compact, { termination, timer });
	dispatch?.primeRouteQuota?.();
	// Operatorless: there is no TUI subscriber to turn a loop-guard interrupt
	// into a run stop, so a degenerate local model would spin until an
	// external timeout (each call blocked, the agent loop never aborted). Wire
	// the shared interrupt->stop subscriber so the run ends with the same
	// durable closing turn the interactive surface produces.
	const unsubscribeLoopGuardStop = subscribeLoopGuardStop(bus, chat);
	const headlessPermissionReason = HEADLESS_PERMISSION_DENIED_REASON;
	const headlessExtensions = createSessionExtensionHosting({
		start: () => startSessionExtensionHost("headless", headless?.answers?.interview),
		commit: commitExtensionHooks,
		idle: chatIdle,
		bus,
		report: (line) => process.stderr.write(`pancode: ${line}\n`),
	});
	// `--max-cost-usd` bounds what this run adds, so a continued session's
	// earlier spend does not count against it. It becomes the session
	// ceiling every paid request already passes: the main agent's, each
	// compaction's and each dispatch's admission. A lower configured
	// ceiling still holds. The start is read the way admission reads spend, so the cap counts only this run (#434).
	const runCostCap =
		headless.maxCostUsd === undefined
			? null
			: createRunCostCap((await telemetry?.settledSessionSpend())?.usd ?? 0, headless.maxCostUsd);
	if (runCostCap !== null) {
		startupOverrides.set(
			"safety.limits.sessionCostUsd",
			runCostCeilingUsd({
				spentUsd: runCostCap.startUsd,
				runMaxUsd: runCostCap.maxUsd,
				configuredUsd: getCurrentSettings().safety.limits.sessionCostUsd,
			}),
		);
		bumpSessionState();
		result.getContract("scheduling")?.setRunCostCap?.(runCostCap);
	}
	const unpricedRoutes = runCostCap === null ? [] : unpricedRunRoutes(getCurrentSettings(), providers);
	if (unpricedRoutes.length > 0) {
		process.stderr.write(
			`pancode run: --max-cost-usd does not bound unpriced routes: ${unpricedRoutes.join(", ")}; declare connections[].pricing to bound them\n`,
		);
	}
	const unsubscribeHeadlessPermission = toolRegistry.onPermissionRequired((call, decision, meta) => {
		void resolvePermission(
			{ bus, registry: toolRegistry },
			{
				action: "stop",
				payload: {
					status: "denied",
					requestId: meta.requestId,
					origin: "main",
					decidedBy: "policy:no-operator",
					tool: call.tool,
					actionClass: decision.classification.actionClass,
					reason: headlessPermissionReason,
					requestedBy: "headless",
				},
			},
		);
	});
	try {
		// WTF-P F04: `/ext:<id>:<cmd>` and a `replaces: prompt` takeover run in the
		// extension runtime with no model turn, as they do in the terminal.
		const typed = parseSlashCommand(headless.prompt);
		if (typed.kind === "unknown-command" && installedExtensionClaims(typed.token, process.cwd())) {
			const headlessExtensionHost = await headlessExtensions.ensure();
			await headlessExtensionHost?.ready.catch(() => undefined);
			const answer = await answerExtensionLine(
				headless.prompt,
				typed.token,
				headlessExtensionHost?.operator,
				resources?.prompts(process.cwd()).items ?? [],
			);
			if (answer !== null) {
				if (answer.ok) writeLocalAnswer(answer.text, (headless.mode ?? "text") !== "text");
				else writeRunDiagnostic(`pancode: ${answer.message}\n`);
				await termination.shutdown(answer.ok ? 0 : 1);
				return { exitCode: answer.ok ? 0 : 1, bootTimeMs: timer.snapshot().totalMs };
			}
		}
		const parsedSkillRequest = resources?.parsePendingSkillRequests(headless.prompt, process.cwd()) ?? {
			text: headless.prompt,
			pendingSkillRequests: [],
		};
		const promptExpansion = resources?.expandPromptTemplate(parsedSkillRequest.text, process.cwd());
		if (promptExpansion?.expanded && promptExpansion.template.sourceInfo.owner)
			recordPackActivity({
				type: "pancode_plugin_resource_use",
				kind: "prompt",
				owner: promptExpansion.template.sourceInfo.owner,
				outcome: "expanded",
				details: { name: promptExpansion.template.name },
			});
		// A prompt named as `/name` is a request for that template. When the
		// template refuses, the run says why and stops; sending the literal
		// `/name` on to the model spends a turn answering a command it cannot
		// run, and the operator never sees the refusal.
		if (promptExpansion?.expanded === false && promptExpansion.refusal) {
			writeRunDiagnostic(`pancode: ${promptExpansion.refusal.message}\n`);
			await termination.shutdown(1);
			return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
		}
		// A display-only template that reached boot (the CLI preflight answers
		// most of them earlier) is printed for the operator and the run ends;
		// its body was never model text.
		if (promptExpansion?.expanded === false && promptExpansion.display) {
			writeLocalAnswer(promptExpansion.display.text, (headless.mode ?? "text") !== "text");
			await termination.shutdown(0);
			return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
		}
		// Started only for a run that reaches the model, so the early exits
		// above spawn no runtime. Only a --answers file answers here; without
		// one a tool's interview is cancelled with reason headless.
		// The first turn's turn_start reaches a runtime only once the startup
		// generation has committed. A run whose startup failed goes on without runtimes.
		await (await headlessExtensions.ensure())?.ready.catch(() => undefined);
		// SIGINT while an `@path` in the prompt is read ends the run before any
		// request; aborting kills poppler, a detached child that would outlive it (#438).
		const attachmentRead = new AbortController();
		const stopAttachmentRead = bus.subscribe("shutdown.requested", () => attachmentRead.abort());
		// An MCP prompt's text is the server's: it is sent as the prompt gave it, never read for `@path`.
		const mcpPrompt =
			promptExpansion?.expanded || !mcpSubmit
				? null
				: await mcpSubmit.expandPrompt(parsedSkillRequest.text, attachmentRead.signal);
		if (mcpPrompt?.ok === false) {
			stopAttachmentRead();
			writeRunDiagnostic(`pancode: ${mcpPrompt.error}\n`);
			await termination.shutdown(1);
			return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
		}
		const fileExpansion = await (mcpPrompt?.ok
			? Promise.resolve({
					text: mcpPrompt.text,
					images: mcpPrompt.images,
					diagnostics: [],
					referencedPaths: [],
					notes: [mcpPrompt.note],
				})
			: expandSubmitReferences(promptExpansion?.expanded ? promptExpansion.text : parsedSkillRequest.text, process.cwd(), {
					signal: attachmentRead.signal,
					...(mcpSubmit ? { mcp: mcpSubmit } : {}),
				})
		)
			.catch((err: unknown) => {
				if (!attachmentRead.signal.aborted) throw err;
				return null;
			})
			.finally(stopAttachmentRead);
		if (fileExpansion === null || attachmentRead.signal.aborted) {
			writeRunDiagnostic("pancode run: interrupted while reading file attachments; nothing was sent\n");
			await termination.shutdown(130);
			return { exitCode: 130, bootTimeMs: timer.snapshot().totalMs };
		}
		// A template's tool scope and budget narrow the run's --allow-tools, --delegate-tools and limits, never widen.
		const template = promptExpansion?.expanded ? promptExpansion.template : undefined;
		const constraints = narrowTurnConstraints(
			headless.constraints,
			template ? templateTurnConstraints(template) : undefined,
		);
		// A headless template and its flags bind once for the whole run (#423).
		chat.setToolCeiling?.([constraints]);
		const images = [...(headless.images ?? []), ...fileExpansion.images];
		const workingContextPaths = [...(headless.workingContextPaths ?? []), ...fileExpansion.referencedPaths];
		// prompt_submit hooks judge the line the operator typed, as in the TUI and ACP.
		const display = submitDisplay({
			typed: headless.prompt,
			parsedText: parsedSkillRequest.text,
			...(promptExpansion?.expanded
				? { template: { name: promptExpansion.template.name, text: promptExpansion.text } }
				: {}),
			referencedPaths: fileExpansion.referencedPaths,
			diagnostics: fileExpansion.diagnostics,
			cwd: process.cwd(),
			mcpNotes: fileExpansion.notes,
		});
		startRunOutput();
		// R-11: a main turn that ended on PanCode's own fault earns one stderr line after the run.
		let internalFault = false;
		const unsubscribeInternalFault = bus.subscribe("turn.settled", (payload, context) => {
			if (context?.agent.role === "main" && payload.terminal.cause === "internal") internalFault = true;
		});
		const code = await runHeadlessMainAgent(chat, {
			prompt: fileExpansion.text,
			...(display ? { display } : {}),
			...(constraints ? { constraints } : {}),
			...(images.length > 0 ? { images } : {}),
			...(workingContextPaths.length > 0 ? { workingContextPaths } : {}),
			...(headless.sampling ? { sampling: headless.sampling } : {}),
			...(parsedSkillRequest.pendingSkillRequests.length > 0
				? { pendingSkillRequests: parsedSkillRequest.pendingSkillRequests }
				: {}),
			mode: headless.mode ?? "text",
			...(headless.routeNotice ? { routeNotice: headless.routeNotice } : {}),
			...(headless.steerChannel
				? {
						steerChannel: headless.steerChannel,
						reload: (target: ReloadTarget) => reloadClasses.run(target, () => headlessExtensions.reloadStep()),
					}
				: {}),
			...(headless.failOnNoop === true ? { failOnNoop: true } : {}),
			...(headless.failOnVerify === true ? { failOnVerify: true } : {}),
			...(headless.outputSchema !== undefined ? { outputSchema: headless.outputSchema } : {}),
			unpricedRoutes: (reach) => unpricedRunRoutes(getCurrentSettings(), providers, reach),
			...(headless.onPermission === "fail" ? { onPermission: "fail" as const } : {}),
			...(headless.deadline !== undefined ? { deadline: headless.deadline } : {}),
			...(headless.answers !== undefined ? { answers: headless.answers } : {}),
			...(headless.verify !== undefined
				? { verify: { ...headless.verify, credited: () => cells.creditedRunChecks } }
				: {}),
			...(dispatch ? { dispatch } : {}),
			autonomyHalt: () => cells.lastAutonomyHalt,
			readEntries: activePathEntries,
			scratchRoots: getCurrentSettings().safety.scratchRoots,
			onRunGitHelpers: headlessGitHelpers.note,
			autonomy: () => autonomyWindow.report(true),
			scopeNotices: (listener) => bus.subscribe("run.scope_notice_raised", listener),
			sessionCostCeilingUsd: () => getCurrentSettings().safety.limits.sessionCostUsd,
			...(telemetry
				? {
						runUsage: async (from: string, roles = ["main", "compaction"]) => {
							// Every queued settlement is written and the live fold seeded before the calls are read (#434).
							await telemetry.settledSessionSpend();
							const view = telemetry.read?.live();
							// The run's own turn calls and the compactions it ran, folded as the read model folds them.
							return view ? runUsageFromCallRecords(view.callRecords({ roles, from }), READ_MODEL_FOLD) : null;
						},
						// The same calls, folded by the economy projection; a run carries no period fees (S11).
						runEconomy: async (from: string, roles) => {
							await telemetry.settledSessionSpend();
							return telemetry.read?.live()?.economy(roles ? { roles, from } : { from }) ?? null;
						},
						segmentUsage: async (messages) => {
							// The segment's calls are journaled and the live fold seeded before they are read (#434).
							await telemetry.settledSessionSpend();
							const view = telemetry.read?.live();
							return view ? segmentUsageFromView(view, messages) : null;
						},
					}
				: {}),
			...(runCostCap !== null ? { costCap: { maxUsd: runCostCap.maxUsd, unpricedRoutes } } : {}),
			getSessionHeader: () => printJsonSessionHeader(session?.current() ?? null, getCurrentSettings().chat),
		});
		unsubscribeInternalFault();
		if (internalFault) {
			try {
				const { HEADLESS_OFFER_LINE, takeHeadlessOffer } = await import("../../domains/report/index.js");
				const offered = takeHeadlessOffer({
					stateDir: pancodeStateDir(),
					sessionId: session?.current()?.id ?? null,
					offers: getCurrentSettings().report?.offers ?? "ask",
					mode: headless.mode ?? "text",
					env: process.env,
					now: new Date(),
				});
				if (offered) process.stderr.write(`${HEADLESS_OFFER_LINE}\n`);
			} catch {
				// The offer line is a courtesy; a ledger that cannot be read or written leaves the run's exit as it was.
			}
		}
		if (code === 0) {
			const deadline = headless.deadline;
			await memoryOwner.retainTask(
				"headless",
				deadline?.expired() ? 0 : Math.min(5000, deadline?.remainingMs?.() ?? 5000),
			);
			const meta = session?.current();
			if (meta) saveTaskBankSnapshot(pancodeStateDir(), meta.id, taskMemoryBank.snapshot());
		}
		await termination.shutdown(code);
		return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
	} finally {
		unsubscribeHeadlessPermission();
		unsubscribeLoopGuardStop();
		// A run that throws skips the termination drain; the host's runtime
		// children would otherwise keep the process alive. Disposal is idempotent.
		await headlessExtensions.dispose();
	}
}
