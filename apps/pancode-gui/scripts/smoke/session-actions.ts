// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { join } from "node:path";
import { seedGoldenSession } from "../../tests/harness/telemetry-fixture.js";
import type { SmokeRun } from "./run.js";

/** What a session does from its composer: slash commands, the board, attachments, approvals, dispatch and fleet steering, streaming, playbooks, extensions, asides, context, branches, handoff, a viewer window and closing the task. */
export async function sessionActionSteps(run: SmokeRun) {
	const {
		check,
		chipOrSlash,
		closeDialog,
		closePane,
		composerField,
		context,
		dark,
		errors,
		eventually,
		h,
		launch,
		openDrill,
		output,
		page,
		pane,
		settled,
		slashAction,
		slashList,
		slashPane,
		step,
		taskMenu,
		width,
	} = run;
	await step("slash commands", async () => {
		// Session commands run from the composer's slash palette. `/` lists what this session serves.
		await composerField.fill("/");
		await slashList
			.getByRole("option", { name: /^\/doctor/ })
			.first()
			.waitFor();
		await slashList.getByRole("option", { name: /^\/tree/ }).waitFor();
		await slashList
			.getByRole("option", { name: /^\/context/ })
			.first()
			.waitFor();
		const firstSuggestion = await composerField.getAttribute("aria-activedescendant");
		assert.ok(firstSuggestion);
		await composerField.press("ArrowDown");
		const nextSuggestion = await composerField.getAttribute("aria-activedescendant");
		assert.ok(nextSuggestion);
		assert.notEqual(nextSuggestion, firstSuggestion, "plain arrows did not move the active suggestion");
		assert.equal(await composerField.evaluate((element) => document.activeElement === element), true);
		await check("slash-palette");
		await composerField.press("Shift+ArrowUp");
		assert.deepEqual(
			await composerField.evaluate((element) => {
				const field = element as HTMLTextAreaElement;
				return [field.selectionStart, field.selectionEnd];
			}),
			[0, 1],
			"Shift+ArrowUp did not select text while the slash palette was open",
		);
		await page.keyboard.press("Escape");
		await slashList.waitFor({ state: "detached" });
		// A typed command line is parsed against the catalog and previewed; nothing runs until Enter.
		await composerField.fill("/doctor deep");
		await page.locator(".slash-palette--line code", { hasText: "/doctor deep" }).first().waitFor();
		assert.equal(await page.locator(".slash-result").count(), 0, "a previewed command ran before Enter");
		await composerField.press("Enter");
		const slashResult = page.locator(".slash-result");
		await slashResult.locator("pre", { hasText: "Deep checks completed." }).waitFor();
		assert.equal(await composerField.inputValue(), "", "a command line that ran stayed in the composer");
		await composerField.fill("/context compact Summarize the project");
		await page
			.locator(".slash-palette--line code", { hasText: "/context compact Summarize the project" })
			.first()
			.waitFor();
		await composerField.press("Enter");
		await slashResult.locator("pre", { hasText: "Context action: compact Summarize the project" }).waitFor();
		await check("session-commands");
		if (width === 1600) await page.screenshot({ path: join(output, "session-commands.png"), fullPage: true });
		await slashResult.getByRole("button", { name: "Dismiss", exact: true }).click();
	});
	await step("session board", async () => {
		// The session board: the operator's tasks change through the tasks command, the plan and decisions only read.
		// `/tasks` opens it beside the conversation.
		await slashPane("tasks");
		const board = page.locator(".pane:not([hidden]) .board-panel");
		await board.getByText("Read the fixture workspace", { exact: true }).waitFor();
		assert.equal(await composerField.inputValue(), "", "a pane jump stayed in the composer");
		await board.getByText("Markdown with one table", { exact: false }).waitFor();
		await board.getByText("You have not added a task.", { exact: true }).waitFor();
		await board.getByLabel("Add a task", { exact: true }).fill("Draft the summary");
		await board.getByRole("button", { name: "Add", exact: true }).click();
		await board.getByRole("button", { name: "Mark done: Draft the summary", exact: true }).click();
		await board.locator(".status-mark", { hasText: "Done" }).waitFor();
		await board.getByLabel("Add a task", { exact: true }).fill("Survey the project");
		await board.getByRole("button", { name: "Add", exact: true }).click();
		await board.getByRole("button", { name: "Hand to PanCode: Survey the project", exact: true }).click();
		await board.locator(".status-mark", { hasText: "Handed to PanCode" }).waitFor();
		await page.locator(".chat-request", { hasText: "/tasks hand u2" }).waitFor();
		await page.getByText("Working on the handed task", { exact: true }).waitFor();
		await page.waitForFunction(
			() => document.activeElement?.getAttribute("aria-label") === "Mark done: Survey the project",
		);
		await page.getByRole("button", { name: "Send", exact: true }).waitFor({ state: "attached" });
		// A decision is corrected in place: it is superseded and the new direction is sent as a request.
		await board.getByRole("button", { name: "Correct: Report format", exact: true }).click();
		await board.getByLabel("New direction", { exact: true }).fill("HTML with one table");
		await board.getByRole("button", { name: "Supersede and tell Panos", exact: true }).click();
		await board.getByText("Superseded. The new direction was sent to PanCode as a request.", { exact: true }).waitFor();
		await page.locator(".chat-request", { hasText: "is superseded by the operator" }).waitFor();
		await board
			.getByRole("button", {
				name: "Propose for every project: Sample B reads 4.2 on the field instrument.",
				exact: true,
			})
			.click();
		await board
			.getByText("Every project broadens where this lesson applies. Press again to propose it everywhere.", {
				exact: true,
			})
			.waitFor();
		await board
			.getByRole("button", {
				name: "Propose for every project: Sample B reads 4.2 on the field instrument.",
				exact: true,
			})
			.click();
		await board.getByText(/^Proposed memory-k1-global\. Review it/).waitFor();
		await check("session-board-writes");
		if (width === 1600 || width === 390) {
			await board.locator("h3", { hasText: "What PanCode learned this session" }).scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `session-board-writes-${width}.png`) });
		}
		await check("session-board-hand");
		await check("session-board");
		if (width === 1600) await page.screenshot({ path: join(output, "session-board.png"), fullPage: true });
		await closePane();
	});
	await step("attachments", async () => {
		// An image and a text file ride a request when the agent announces image prompts and embedded
		// context: attach both, see them listed, send, see each counted. A binary is refused by name.
		// The composer's Attach control names what this session accepts in its title.
		const attachButton = page.locator(".composer").getByRole("button", { name: "Attach", exact: true });
		await attachButton.waitFor();
		assert.equal(await attachButton.getAttribute("title"), "Attach files");
		const picker = page.locator('.composer input[type="file"]');
		await picker.setInputFiles({
			name: "fixture.png",
			mimeType: "image/png",
			buffer: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			),
		});
		await picker.setInputFiles({
			name: "field-notes.md",
			mimeType: "text/markdown",
			buffer: Buffer.from("sample A: 4.2\n"),
		});
		const attachments = page.getByRole("list", { name: "Attachments to send with this request" });
		await attachments.locator(".composer__attachment-name", { hasText: "fixture.png" }).waitFor();
		await attachments.locator(".composer__attachment-name", { hasText: "field-notes.md" }).waitFor();
		await picker.setInputFiles({
			name: "archive.zip",
			mimeType: "application/zip",
			buffer: Buffer.from([0x50, 0x4b, 0x00, 0x03]),
		});
		await page.locator(".composer__notice", { hasText: "archive.zip is not a text file." }).waitFor();
		await check("composer-attachment");
		await page.getByLabel("Message PanCode", { exact: true }).fill("Describe the attached image and notes.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByText("Received 1 image with the request.", { exact: true }).waitFor();
		await page.getByText("Received 1 file with the request.", { exact: true }).waitFor();
		await page.locator(".chat-request__images", { hasText: "1 image attached" }).waitFor();
		await page.locator(".chat-request__images", { hasText: "1 file attached" }).waitFor();
		assert.equal(await attachments.count(), 0);
	});
	await step("approvals", async () => {
		await page.getByLabel("Message PanCode", { exact: true }).fill("[approval] Write the fixture file.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Allow once", exact: true }).first().waitFor();
		await check("permission");
		await dark(true);
		await check("permission-dark");
		await dark(false);
		await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
		await page.getByText("Tool executed.", { exact: true }).waitFor();
		// A settled group collapses, so open it the way an operator would before reading the card.
		await page.locator(".activity__summary").last().click();
		const applied = page.locator(".diff.is-applied").last();
		await applied.waitFor();
		assert.match(await applied.innerText(), /applied/i);
		assert.match(await applied.innerText(), /approved/);
		// A refusal settles as a FAILED call. The card must keep the refused change on screen and
		// say who turned it down, which a bare status cannot.
		await page.getByLabel("Message PanCode", { exact: true }).fill("[approval] Write it again.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Reject", exact: true }).first().click();
		await page.getByText("Permission rejected.", { exact: true }).waitFor();
		const refused = page.locator(".diff.is-rejected").last();
		await refused.waitFor();
		assert.match(await refused.innerText(), /not applied · rejected/i);
		assert.match(await refused.innerText(), /Nothing was written/);
		assert.match(await refused.innerText(), /approved/, "The refused content stays readable.");
		await check("permission-rejected");
		if (width === 1600) await page.screenshot({ path: join(output, "permission-rejected.png"), fullPage: true });
		// Changes lists what the task's recorded edit calls changed. The approved write is counted with its
		// diff; the refused one changed nothing the transcript can vouch for, so it is not listed.
		await openDrill("Changes");
		const recordedFile = pane.locator(".change-file", { has: page.locator("strong", { hasText: "fixture.txt" }) });
		await recordedFile.getByRole("button", { expanded: false }).click();
		const recordedDiffs = recordedFile.locator(".change-file__diffs");
		await recordedDiffs.locator(".diff.is-applied").waitFor();
		assert.match(await recordedDiffs.locator(".diff.is-applied").innerText(), /applied/i);
		assert.equal(await recordedDiffs.locator(".diff").count(), 1, "a refused write was listed as a change");
		assert.equal(await pane.locator(".diff.is-rejected").count(), 0, "a refused write was listed as a change");
		await check("artifacts-recorded-file");
		if (width === 320 || width === 1600)
			await page.screenshot({ path: join(output, `artifacts-recorded-file-${width}.png`), fullPage: true });
		await closePane();
	});
	await step("plan dispatch", async () => {
		// A plan-scale dispatch: the card names every run and the hash the runs will seal.
		await page.getByLabel("Message PanCode", { exact: true }).fill("[plan] Survey the samples and draft a report.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const planCard = page.locator(".approval-card", { hasText: "Dispatch plan · 2 runs · in parallel" }).first();
		await planCard.waitFor();
		assert.match(await planCard.innerText(), /Draft the comparison report/);
		assert.match(await planCard.innerText(), /kept for review/);
		assert.match(await planCard.innerText(), /3f2a9c1e04b7/);
		await check("permission-plan");
		if (width === 1600 || width === 390) {
			await planCard.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `permission-plan-${width}.png`) });
		}
		await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
		await page.getByText("The plan is running.", { exact: true }).waitFor();
	});
	await step("fleet steering", async () => {
		// Dispatch steering. The fixture holds one live worker until it is stopped, so both write
		// paths on a run are pressed for real: guidance is queued, then the run is stopped.
		await page.getByLabel("Message PanCode", { exact: true }).fill("[fleet] Survey the fixture.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		// A running worker is steered from the strip at the transcript's live edge, not from a menu.
		const workers = page.getByRole("region", { name: "1 worker running", exact: true });
		await workers.getByRole("button", { name: "Guide scout", exact: true }).click();
		await page.getByLabel("Guidance for scout", { exact: true }).fill("Only read the README.");
		await page.getByRole("button", { name: "Send guidance", exact: true }).click();
		await page.getByText("Guidance queued. The worker reads it at its next step.", { exact: true }).waitFor();
		assert.equal(
			await workers
				.getByRole("button", { name: "Guide scout", exact: true })
				.evaluate((node) => node === document.activeElement),
			true,
			"sending guidance returns focus to Guide",
		);
		// The runtime keeps the delegation open for the worker's life, so its group stays open too. The
		// row names the agent once and keeps its state word whole, which clipped at 390px while the agent
		// was repeated beside it.
		const delegation = page.locator(".tool-card.is-dispatch").last();
		await delegation.getByText("Running", { exact: true }).waitFor();
		assert.equal(
			await delegation.locator(".tool-card__head").evaluate((head) => {
				const state = head.querySelector(".tool-card__state");
				const bounds = head.getBoundingClientRect();
				const box = state?.getBoundingClientRect();
				return !!state && !!box && box.right <= bounds.right + 1 && state.scrollWidth <= state.clientWidth + 1;
			}),
			true,
			`the delegation's state word is clipped at ${width}px`,
		);
		await check("fleet-steer");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `fleet-steer-${width}.png`), fullPage: true });
		// The pane's Agents drill keeps the whole fleet history, the running row included.
		await openDrill("Agents");
		await pane.locator(".worker-graph").getByText("Survey the fixture", { exact: true }).first().waitFor();
		await closePane();
		// Mid-turn steering from the composer: queue a message for after the turn, see it listed,
		// take it back into the field, then hear the engine's refusal to interrupt as a sentence.
		await page.getByLabel("Message PanCode", { exact: true }).fill("Then summarise it.");
		// The delivery switch sits beside Send once there is a message to deliver.
		await page.locator(".composer__delivery").getByRole("button", { name: "After this turn", exact: true }).click();
		await page.locator(".composer__submit").click();
		await page.locator(".composer__queue-row").getByText("Then summarise it.", { exact: true }).waitFor();
		await check("composer-queue");
		if (width === 1600) await page.screenshot({ path: join(output, "composer-queue.png"), fullPage: true });
		// From rest, as a pointer user arrives: the press itself focuses the composer, and the control must not move under it.
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.getByRole("button", { name: "Take it back", exact: true }).click();
		await page.waitForFunction(
			() => (document.querySelector(".composer__field") as HTMLTextAreaElement | null)?.value === "Then summarise it.",
		);
		await page.getByLabel("Message PanCode", { exact: true }).fill("");
		await page.locator(".composer__options > summary").click();
		await page.getByRole("button", { name: "Interrupt", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.getByText("A dispatched worker is attached; stop the turn instead.").waitFor();
		// Stop takes two presses, and the question puts focus on the answer that keeps the work.
		await workers.getByRole("button", { name: "Stop scout", exact: true }).click();
		assert.equal(
			await page
				.getByRole("button", { name: "Keep running", exact: true })
				.evaluate((node) => node === document.activeElement),
			true,
		);
		await check("fleet-stop");
		await page.getByRole("button", { name: "Stop run", exact: true }).click();
		await page.getByText("The worker was stopped.", { exact: true }).waitFor();
		assert.equal(await page.getByRole("button", { name: "Guide scout", exact: true }).count(), 0);
		assert.equal(await page.locator(".live-workers").count(), 0, "a settled run leaves the live strip");
	});
	await step("streaming and cancel", async () => {
		// Streamed deltas never render the composer: its props are scalars and a route memoized on
		// settings and health. Count across the workload stream, through Markdown, code, tool bursts and a
		// failed call. The send settling and the turn ending are the composer's own state, so the window opens
		// on the first commit after it stops saying Sending and closes on the last commit that still offers
		// Stop. The page reads both edges as it commits them, so a slow runner's polling cannot widen it.
		type ComposerWindow = {
			start?: { renders: number; headings: number };
			last?: { renders: number; headings: number };
			ended?: boolean;
			missed?: string;
		};
		await page.evaluate(() => {
			const scope = globalThis as unknown as {
				__pancodeRenderCounts: Record<string, number>;
				__composerWindow?: ComposerWindow;
			};
			const edges: ComposerWindow = {};
			scope.__composerWindow = edges;
			const earlier = new Set(document.querySelectorAll(".chat-turn"));
			const observer = new MutationObserver(() => {
				const turn = [...document.querySelectorAll(".chat-turn")].at(-1);
				const headings = turn?.querySelectorAll(".md-heading").length ?? 0;
				if (turn === undefined || earlier.has(turn) || headings === 0) return;
				const renders = scope.__pancodeRenderCounts.composer ?? 0;
				const running = document.querySelector(".composer__stop") !== null;
				if (edges.start === undefined) {
					if (!running) edges.missed = "the turn ended before its send settled";
					else if (document.querySelector(".composer__delivery-note strong")?.textContent !== "Sending")
						edges.start = { renders, headings };
				} else if (running) edges.last = { renders, headings };
				else edges.ended = true;
				if (edges.ended || edges.missed !== undefined) observer.disconnect();
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
		});
		await page.getByLabel("Message PanCode", { exact: true }).fill("[workload] Audit the convergence notes.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const measured = await page
			.waitForFunction(() => {
				const edges = (globalThis as unknown as { __composerWindow?: ComposerWindow }).__composerWindow;
				return edges?.ended || edges?.missed !== undefined ? edges : null;
			})
			.then((handle) => handle.jsonValue() as Promise<ComposerWindow>);
		assert.equal(measured.missed, undefined, measured.missed);
		const { start, last } = measured;
		assert.ok(start && last && last.headings > start.headings, "no heading streamed between the send and the turn end");
		assert.equal(last.renders, start.renders, "a streamed delta rendered the composer");
		await settled();
		await page.getByLabel("Message PanCode", { exact: true }).fill("[stream-held] Show progress until cancelled.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.locator('.wb-chip--status[data-tone="working"]').waitFor();
		// A scripted move up of less than a viewport while the turn runs (find-in-page, assistive
		// technology) leaves the live edge like a reader's scroll; only a browser clamp is pinned back.
		// The move waits out the send's hold, while the dock's reflow still counts as a clamp; the held
		// stream runs until Stop turn, so the move always lands mid-turn.
		const transcript = page.locator(".chat-transcript");
		await page.waitForFunction(() => {
			const element = document.querySelector<HTMLElement>(".chat-transcript");
			return (
				!!element &&
				element.dataset.followHold === undefined &&
				element.scrollHeight - element.scrollTop - element.clientHeight <= 32
			);
		});
		const movedTo = await transcript.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight / 2);
			return element.scrollTop;
		});
		await page.locator(".jump-to-latest").waitFor();
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		assert.ok(
			Math.abs((await transcript.evaluate((element) => element.scrollTop)) - movedTo) <= 2,
			"a scripted scroll during a running turn was pinned back to the live edge",
		);
		await page.locator(".jump-to-latest").click();
		await page.locator(".jump-to-latest").waitFor({ state: "detached" });
		await page.getByRole("button", { name: "Stop turn", exact: true }).click();
		await settled();
		await check("cancelled");
	});
	await step("playbook run", async () => {
		// A playbook: preview compiles and starts nothing; the run starts the plan shown.
		const fleetDialog = await slashAction("fleet run", "Run a playbook", "Run a playbook");
		const fleetPanel = fleetDialog;
		await fleetPanel.getByLabel("Playbook name", { exact: true }).fill("survey");
		await fleetPanel.getByLabel("Variables, one name=value per line", { exact: true }).fill("site=plot-7");
		await fleetPanel.getByRole("button", { name: "Preview the plan", exact: true }).click();
		await fleetPanel.getByRole("heading", { name: "Fleet survey: 2 steps in 2 waves", exact: true }).waitFor();
		assert.match(await fleetPanel.innerText(), /Writes reports\//);
		await check("fleet-run-preview");
		if (width === 1600 || width === 390) {
			await fleetPanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `fleet-run-preview-${width}.png`) });
		}
		await fleetPanel.getByRole("button", { name: "Run this plan", exact: true }).click();
		await page.locator(".notice-region .notice", { hasText: "Fleet survey started" }).waitFor();
		if (await fleetDialog.count()) await closeDialog(fleetDialog);
		await page.getByRole("button", { name: "Dismiss Fleet survey started", exact: true }).click();
	});
	await step("extensions", async () => {
		// Extensions: what this conversation loaded, and a reload that says which generation is live.
		const extensionsDialog = await slashAction("extensions", "Extensions", "Tools and add-ons");
		const extensionsPanel = extensionsDialog.locator(".extensions-panel");
		await extensionsPanel.getByText("survey-tools 1.2.0 · project scope", { exact: true }).waitFor();
		// Reload sits under the panel's Apply installed changes disclosure.
		await extensionsPanel.locator("summary", { hasText: "Apply installed changes" }).click();
		await extensionsPanel.getByRole("button", { name: "Reload extensions", exact: true }).click();
		await extensionsPanel.getByText(/^Generation \d+ is live \(no changes\); 2 hooks registered\.$/).waitFor();
		await check("extensions");
		await closeDialog(extensionsDialog);
	});
	await step("conversation usage", async () => {
		// Usage: the conversation's spend in the agent's own words, and each provider's windows. The top
		// bar's spend chip opens it.
		await chipOrSlash(/^[\d,]+ tokens.*\. Open usage\.$/, "usage");
		const usagePanel = pane.locator(".usage-panel");
		// Rows are the read model's cost groups by target/model (#434), displays carried through unreworded: the
		// estimated, partly unpriced cost keeps its "~" and "+?" provenance marks.
		const modelRow = usagePanel.locator(".usage-panel__models > li", {
			has: page.locator(".usage-panel__route", { hasText: /^fixture\/fixture-model$/ }),
		});
		await modelRow.locator(".usage-panel__cost", { hasText: "~$0.25 +?" }).waitFor();
		// The provider windows sit under the panel's Provider quota disclosure.
		await usagePanel.locator("summary", { hasText: /^Provider quota · 1 plan$/ }).click();
		const fiveHour = usagePanel.getByRole("meter", { name: "5h used", exact: true });
		await fiveHour.waitFor();
		assert.equal(await fiveHour.getAttribute("aria-valuetext"), "71.4% used");
		await check("usage");
		if (width === 1600 || width === 390) {
			await usagePanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `usage-${width}.png`) });
		}
		await closePane();
	});
	await step("side question and drafts", async () => {
		// Beside the conversation: a side question and drafts answer in place and add no turn.
		const turnsBefore = await page.locator(".chat-request").count();
		const questionDialog = await slashAction("btw", "Side question", "Side question");
		const aside = questionDialog.locator(".aside-panel");
		await aside.getByLabel("Side question", { exact: true }).fill("Which file holds the readings?");
		await aside.getByRole("button", { name: "Ask", exact: true }).click();
		await aside.getByText("The readings are in README.md.", { exact: true }).waitFor();
		await check("aside-question");
		await closeDialog(questionDialog);
		const draftsDialog = await slashAction("draft", "Drafts", "Compare approaches");
		const drafts = draftsDialog.locator(".aside-panel");
		await drafts.getByLabel("Request to draft", { exact: true }).fill("How should the report show readings?");
		await drafts.getByLabel("Drafts", { exact: true }).selectOption("2");
		await drafts.getByRole("button", { name: "Draft", exact: true }).click();
		await drafts.getByText("fixture/judge picked A in 12 ms.", { exact: true }).waitFor();
		await check("aside");
		if (width === 1600 || width === 390) {
			await drafts.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `aside-${width}.png`) });
		}
		assert.equal(await page.locator(".chat-request").count(), turnsBefore, "an aside added a turn");
		await drafts.getByRole("button", { name: "Put in composer", exact: true }).first().click();
		assert.equal(
			await page.getByLabel("Message PanCode", { exact: true }).inputValue(),
			"Show the readings in one table with a unit column.",
		);
		await closeDialog(draftsDialog);
		await page.getByLabel("Message PanCode", { exact: true }).fill("");
	});
	await step("context window and timeline", async () => {
		// The context window: PanCode's own accounting, worded and never recomputed. The top bar's
		// context ring opens it. Its figures are the read model's, folded from the session's journal (#434), and the
		// fixture agent journals nothing: the golden journal is seeded under this session's id, closed by the context
		// snapshot a real turn journals for the ledger the fixture reports. The timeline below reads the same journal.
		seedGoldenSession(join(h.home.path, "state"), new URL(page.url()).pathname.split("/").at(-1) ?? "", {
			context: { window: 131_072, used: 20_480, reserve: 16_384, free: 94_208, system: 4096, messages: 16_384 },
		});
		await chipOrSlash(/Open the context window\.$/, "context");
		const contextPanel = pane.locator(".context-panel");
		// The lead reads used, then window and share, each an explainable figure (#434).
		// The lead is the journal's figure, seeded above; the meter is the engine's live ledger, which the fixture
		// grows with each answered turn from its opening 20,480 tokens (R2-4).
		await contextPanel.locator(".context-panel__figure strong", { hasText: "20,480" }).waitFor();
		assert.equal(
			(await contextPanel.locator(".context-panel__figure").innerText()).replace(/\s+/g, " ").trim(),
			"20,480 of 131,072 tokens · 15.6%",
		);
		await eventually(
			async () =>
				Number(await contextPanel.locator(".context-panel__meter [role=meter]").getAttribute("aria-valuenow")) > 15.625,
			true,
			"the context meter did not grow past the fixture's opening 15.6% with the answered turns",
		);
		await contextPanel.getByText("Total anchored to provider-reported usage.", { exact: true }).waitFor();
		await contextPanel.getByRole("rowheader", { name: "Conversation", exact: true }).waitFor();
		await check("context-window");
		if (width === 1600 || width === 390) {
			await contextPanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `context-window-${width}.png`) });
		}
		// The session timeline: the journal seeded above, newest first, every figure in the server's words (#434 §11.3).
		await pane.getByLabel("Inspect task", { exact: true }).selectOption("timeline");
		const timelinePanel = pane.locator(".timeline-panel");
		const timelineCall = timelinePanel.locator(".timeline-panel__rows > li", { hasText: / call · / }).first();
		await timelineCall.waitFor();
		await timelinePanel.getByRole("combobox", { name: /^Entry kind/ }).selectOption("Model call");
		assert.equal(
			await timelinePanel.locator(".timeline-panel__rows > li", { hasNotText: / call · / }).count(),
			0,
			"the kind filter left another kind in the timeline",
		);
		const callTokens = timelineCall.locator("details.explain").first();
		await callTokens.locator("summary").click();
		await callTokens.locator(".explain__panel dt", { hasText: /^Coverage$/ }).waitFor();
		await check("session-timeline");
		if (width === 1600 || width === 390) {
			await timelinePanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `session-timeline-${width}.png`) });
		}
		await callTokens.locator("summary").click();
		await closePane();
	});
	await step("branches", async () => {
		// Branches: continuing from an earlier reply replays only that branch; forking moves the
		// conversation to a new session and says the project's files were left alone.
		const branchesDialog = await slashAction("tree", "Branches", "Conversation history");
		const branches = branchesDialog.locator(".branch-panel");
		await branches.getByText("The next request continues here", { exact: false }).waitFor();
		await check("branches");
		if (width === 1600 || width === 390) {
			await branches.locator("ol").scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `branches-${width}.png`) });
		}
		await branches
			.getByRole("button", { name: "Continue from this reply: The second sample reads 4.2", exact: true })
			.click();
		await page.locator(".chat-request", { hasText: "Measure the second sample" }).waitFor();
		assert.equal(
			await page.locator(".chat-request", { hasText: "[stream-held] Show progress until cancelled." }).count(),
			0,
			"the branch left behind is not replayed",
		);
		// The pressed row becomes the disabled tip, so focus lands on the panel's heading, not the page.
		await page.waitForFunction(
			() => document.activeElement?.tagName === "H3" && !!document.activeElement.closest(".branch-panel"),
			undefined,
			{ timeout: 5000 },
		);
		const parentUrl = page.url();
		await branches
			.locator("li", { hasText: "The second sample reads 4.2" })
			.getByText("The next request continues here", { exact: false })
			.waitFor();
		await branches
			.getByRole("button", { name: "Fork a new conversation from this reply: Earlier reply", exact: true })
			.click();
		await page.waitForURL((url) => url.href !== parentUrl && url.pathname.startsWith("/sessions/"));
		await page.locator(".notice-region .notice", { hasText: "Workspace files were not rewound" }).waitFor();
		await page.locator(".chat-request", { hasText: "Earlier prompt" }).waitFor();
		assert.equal(await page.locator(".chat-request", { hasText: "Measure the second sample" }).count(), 0);
		if (await branchesDialog.count()) await closeDialog(branchesDialog);
		await check("session-forked");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `session-forked-${width}.png`), fullPage: true });
		for (const title of [/^Dismiss Continuing from/, /^Dismiss Conversation forked$/]) {
			const dismiss = page.getByRole("button", { name: title });
			if (await dismiss.count()) await dismiss.click();
		}
	});
	await step("handoff", async () => {
		// Handoff: a draft is reviewed and edited before anything is written; starting the new
		// conversation moves there.
		const handoffDialog = await slashAction("handoff", "Hand off to a new conversation", "Continue in a new session");
		const handoff = handoffDialog.locator(".handoff-panel");
		await handoff
			.getByLabel("What should the next conversation accomplish?", { exact: true })
			.fill("Finish the survey report");
		await handoff.getByRole("button", { name: "Draw up the handoff", exact: true }).click();
		const reviewField = handoff.getByLabel("Handoff document", { exact: true });
		await reviewField.waitFor();
		assert.match(await reviewField.inputValue(), /Goal: Finish the survey report/);
		await reviewField.fill(`${await reviewField.inputValue()}\nReviewed in the smoke.\n`);
		await check("handoff-review");
		if (width === 1600 || width === 390) {
			await handoff.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `handoff-review-${width}.png`) });
		}
		const forkedUrl = page.url();
		await handoff.getByRole("button", { name: "Start the new conversation", exact: true }).click();
		await page.waitForURL((url) => url.href !== forkedUrl && url.pathname.startsWith("/sessions/"));
		await page.locator(".notice-region .notice", { hasText: "Handed off" }).waitFor();
		await handoffDialog.waitFor({ state: "detached" });
		await check("handed-off");
		await page.getByRole("button", { name: "Dismiss Handed off", exact: true }).click();
	});
	await step("viewer window", async () => {
		// A second window on the same task only views it: its message box takes nothing the server would
		// refuse, and says who drives the task until that window takes control.
		await settled();
		const viewer = await context.newPage();
		run.failedPage = viewer;
		viewer.on("pageerror", (error) => errors.push(error.message));
		await viewer.goto(`${page.url()}#${await launch()}`);
		const viewerNote = viewer.locator(".composer__delivery-note");
		const viewing = (note: typeof viewerNote) => note.locator("strong", { hasText: /^Viewing$/ });
		await viewing(viewerNote).waitFor();
		assert.match(
			await viewerNote.innerText(),
			/^Viewing\s+Browser window( \d+)? controls this session\.\s+Take control$/,
		);
		const viewerField = viewer.getByLabel("Message PanCode", { exact: true });
		assert.ok(await viewerField.isDisabled(), "a viewing window's message box takes input the server refuses");
		assert.ok(await viewer.locator(".composer__submit").isDisabled(), "a viewing window offers Send");
		assert.ok(await viewer.getByRole("button", { name: "Actions", exact: true }).isDisabled());
		// One way to take control, in the message box; the banner above the transcript only explains.
		assert.equal(await viewer.getByRole("button", { name: "Take control", exact: true }).count(), 1);
		await check("viewer", viewer);
		if (width === 1600) await viewer.screenshot({ path: join(output, `viewer-${width}.png`) });
		await viewerNote.getByRole("button", { name: "Take control", exact: true }).click();
		await viewing(viewerNote).waitFor({ state: "detached" });
		assert.ok(await viewerField.isEnabled(), "taking control left the message box disabled");
		// The first window is told, and its own message box now waits for it to take control back.
		const pageNote = page.locator(".composer__delivery-note");
		await page.locator(".notice-region .notice", { hasText: "took control of a task" }).waitFor();
		await viewing(pageNote).waitFor();
		assert.ok(await page.getByLabel("Message PanCode", { exact: true }).isDisabled());
		await pageNote.getByRole("button", { name: "Take control", exact: true }).click();
		await viewing(pageNote).waitFor({ state: "detached" });
		await viewing(viewerNote).waitFor();
		await page.getByRole("button", { name: /^Dismiss .+ took control of a task$/ }).click();
		await viewer.close();
		run.failedPage = page;
	});
	await step("close task", async () => {
		// Close lives in the top bar's Task actions menu, away from the composer's Stop.
		await settled();
		await taskMenu.locator("summary").click();
		await taskMenu.getByRole("menuitem", { name: "Close session", exact: true }).click();
		// Closing is a session control request; it is confirmed before it is sent.
		await page
			.getByRole("dialog", { name: "Close this session?", exact: true })
			.getByRole("button", { name: "Close session", exact: true })
			.click();
		await page.locator('.wb-chip--status[data-tone="quiet"]', { hasText: "Closed" }).waitFor();
		await page.getByText("This session is closed.", { exact: true }).waitFor();
		await check("closed");
	});
}
