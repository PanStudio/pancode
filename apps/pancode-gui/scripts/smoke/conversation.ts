// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import type { SmokeRun } from "./run.js";

/** The conversation: rendered markdown and diagrams, turn usage, the composer tray, the task pane, the route picker and the Task actions menu. */
export async function conversationSteps(run: SmokeRun) {
	const {
		apiWrites,
		check,
		closePane,
		composerField,
		context,
		dark,
		launch,
		openDrill,
		openPane,
		origin,
		output,
		page,
		pane,
		step,
		taskMenu,
		width,
		zoom,
	} = run;
	await step("conversation markdown and diagram", async () => {
		// The project page's New task returns to the home composer for that project; the first message
		// starts the task and opens its conversation.
		await page.goto(run.workspaceUrl);
		await page.locator("main button.primary", { hasText: "New task" }).click();
		await page.waitForURL(`${origin}/`);
		const firstField = page.getByLabel("Message PanCode", { exact: true });
		await firstField.fill("Show the fixture findings with code and a diagram.");
		// Sent from the keyboard, the next message goes in the task's own box without tabbing back to it.
		await firstField.press("Enter");
		await page.waitForURL(/\/sessions\/[^/]+$/);
		await page.waitForFunction(() => document.activeElement?.matches(".composer__field") === true);
		// The fixture first streams and then settles. Inspect its final Markdown subtree,
		// which replaces the streaming subtree before deferred diagrams are rendered.
		await page.locator(".chat-turn.is-settled .diagram").waitFor();
		// Diagrams, like highlighted code, render when they approach the transcript viewport.
		await page.locator(".chat-turn.is-settled .diagram").scrollIntoViewIfNeeded();
		await page.locator(".diagram.is-rendered svg").waitFor();
		// Highlighting waits until code nears the visible transcript; the composer is no longer
		// displaced by page scrolling, so bring that block into the one reading viewport.
		await page.locator(".code-block pre").first().scrollIntoViewIfNeeded();
		await page.locator(".token.keyword").first().waitFor();
		const diagram = await page.locator(".diagram svg").evaluate((node) => {
			const svg = node as SVGSVGElement;
			return {
				width: svg.getBoundingClientRect().width,
				height: svg.getBoundingClientRect().height,
				viewBox: svg.getAttribute("viewBox"),
				markup: svg.outerHTML,
			};
		});
		await writeFile(join(output, `diagram-${width}.json`), JSON.stringify(diagram, null, 2));
		assert.equal(
			await page.locator(".diagram svg script, .diagram svg foreignObject, .diagram svg a, .diagram svg image").count(),
			0,
		);
		assert.equal(
			await page.locator(".diagram svg").evaluate((svg) => {
				const bounds = svg.getBoundingClientRect();
				return [...svg.querySelectorAll(".node")].every((node) => {
					const rectangle = node.getBoundingClientRect();
					return (
						rectangle.left >= bounds.left - 1 &&
						rectangle.right <= bounds.right + 1 &&
						rectangle.top >= bounds.top - 1 &&
						rectangle.bottom <= bounds.bottom + 1
					);
				});
			}),
			true,
			"Every diagram node is inside the rendered viewport.",
		);
		if (width === 390) {
			const code = page.locator(".code-block pre").first();
			await code.focus();
			await page.keyboard.press("ArrowRight");
			await page.waitForFunction(() => (document.querySelector(".code-block pre")?.scrollLeft ?? 0) > 0);
			await code.evaluate((node) => {
				node.scrollLeft = 0;
				node.blur();
			});
		}
		assert.equal(await page.locator(".chat-transcript script").count(), 0);
		assert.equal(await page.locator('.chat-transcript a[href^="javascript:"]').count(), 0);
		assert.equal(await page.evaluate(() => Object.hasOwn(window, "modelMarkupExecuted")), false);
		assert.ok((await page.locator(".chat-transcript").innerText()).includes("<script>window.modelMarkupExecuted"));
		await page.locator(".chat-transcript").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await page.locator(".jump-to-latest").waitFor({ state: "detached" });
	});
	await step("turn usage", async () => {
		// Complete accounting lives with the turn outcome, not as a repeated line above the
		// composer. Its native disclosure must work from the keyboard and remain accessible open.
		assert.equal(await page.locator(".conversation__dock > .chat-usage").count(), 0);
		// The outcome line is the summary of the turn's own disclosure; each explained figure inside it is
		// a nested disclosure of its own.
		const usage = page.locator(".turn-outcome").last().locator(":scope > details");
		const usageSummary = usage.locator(":scope > summary");
		await usageSummary.focus();
		await page.keyboard.press("Enter");
		assert.equal(await usage.evaluate((element) => (element as HTMLDetailsElement).open), true);
		const tokenGroup = usage.locator(".turn-details__group", {
			has: page.getByRole("heading", { name: "Usage", exact: true }),
		});
		// Prompt is the whole prompt the provider read: input plus cache read and write.
		assert.deepEqual(await tokenGroup.locator("dt").allTextContents(), ["Input", "Output", "Reasoning", "Prompt"]);
		// An explained figure carries its explanation beside it; the figure is that disclosure's summary.
		const figures = (group: Locator) =>
			group.locator("dd").evaluateAll((cells) => cells.map((cell) => (cell.querySelector("summary") ?? cell).textContent));
		// The fixture reports usage that scales with each turn, so the figures are read back, not pinned.
		const counts = async (group: Locator) =>
			(await figures(group)).map((figure) => Number((figure ?? "").replaceAll(",", "")));
		const [input = 0, output = 0, reasoning = 0, prompt = 0] = await counts(tokenGroup);
		assert.ok([input, output, reasoning, prompt].every((value) => Number.isInteger(value) && value >= 0));
		const cacheGroup = usage.locator(".turn-details__group", {
			has: page.getByRole("heading", { name: "Cache", exact: true }),
		});
		// Cache reads and writes are the provider's fields; no hit share is derived from them.
		assert.deepEqual(await cacheGroup.locator("dt").allTextContents(), ["Read", "Written"]);
		const [cacheRead = 0, cacheWrite = 0] = await counts(cacheGroup);
		assert.equal(prompt, input + cacheRead + cacheWrite, "Prompt is not input plus cache read and write");
		await check("conversation-usage");
		await page.keyboard.press("Enter");
		assert.equal(await usage.evaluate((element) => (element as HTMLDetailsElement).open), false);
		// Opening a detail freezes the live edge on purpose; Jump to latest returns to it before the draft grows.
		await page.locator(".jump-to-latest").click();
		await page.locator(".jump-to-latest").waitFor({ state: "detached" });
	});
	await step("composer tray and layout", async () => {
		// The resting tray is compact, grows with a multiline draft, and keeps a followed
		// transcript at its live edge while that grid row changes height.
		const restingComposer = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().height);
		// Name each action's box in the failure, so a wrap on a narrow screen says which control caused it.
		const actionBoxes = await page.locator(".composer__actions > *").evaluateAll((elements) =>
			elements.map((element) => {
				const box = element.getBoundingClientRect();
				return `${element.className || element.tagName}:${Math.round(box.width)}@${Math.round(box.top)}`;
			}),
		);
		// The tray carries its heading and hint lines around a one-line field and one row of actions.
		// At 800px those lines wrap and the route actions take a row of their own; a wrapped action
		// row at any wider size would still add 44px and fail here.
		assert.ok(
			restingComposer <= (width <= 800 ? 280 : 230),
			`resting composer is ${restingComposer}px tall at ${width}px; actions ${actionBoxes.join(", ")}`,
		);
		const restingField = await composerField.evaluate((element) => element.getBoundingClientRect().height);
		await composerField.fill("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
		await page.waitForFunction(
			(before) => (document.querySelector(".composer__field")?.getBoundingClientRect().height ?? 0) > before + 20,
			restingField,
		);
		await page.waitForFunction(() => {
			const transcript = document.querySelector(".chat-transcript");
			return !!transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 32;
		});
		const grownComposer = await page.evaluate(() => {
			const composer = document.querySelector(".composer")?.getBoundingClientRect();
			const transcript = document.querySelector(".chat-transcript");
			return {
				composerBottom: composer?.bottom ?? Number.POSITIVE_INFINITY,
				bottomGap: transcript
					? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
					: Number.POSITIVE_INFINITY,
			};
		});
		assert.ok(grownComposer.composerBottom <= 1050, "a growing draft pushed the composer below the viewport");
		assert.ok(grownComposer.bottomGap <= 32, "a growing draft moved a followed transcript away from its live edge");
		// A `/name` nothing owns is flagged before it is sent; a loaded template is not.
		await composerField.fill("/tpyo fix the build");
		await page.getByText("/tpyo is not available here").waitFor();
		await check("composer-unknown-command");
		await composerField.fill("/review-pr 42");
		await page.getByText("is not available here").waitFor({ state: "detached" });
		await composerField.fill("");
		await page.waitForFunction(
			(before) =>
				(document.querySelector(".composer__field")?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY) <=
				before + 1,
			restingField,
		);
		await composerField.evaluate((element) => (element as HTMLTextAreaElement).blur());

		await check("conversation");
		const conversationLayout = await page.evaluate(() => {
			const transcript = document.querySelector(".chat-transcript");
			const composer = document.querySelector(".composer");
			const header = document.querySelector(".conversation .wb-bar");
			const main = document.querySelector("main");
			return {
				pageScrolls: (document.scrollingElement?.scrollHeight ?? 0) > innerHeight + 2,
				mainScrolls: !!main && (main.scrollTop !== 0 || main.scrollLeft !== 0),
				// The transcript owns scrolling whether or not this fixture's content happens to overflow it.
				transcriptScrolls: !!transcript && ["auto", "scroll"].includes(getComputedStyle(transcript).overflowY),
				headerVisible: !!header && header.getBoundingClientRect().top >= 0 && header.getBoundingClientRect().height > 0,
				composerVisible: !!composer && composer.getBoundingClientRect().bottom <= innerHeight,
			};
		});
		assert.deepEqual(conversationLayout, {
			pageScrolls: false,
			mainScrolls: false,
			transcriptScrolls: true,
			headerVisible: true,
			composerVisible: true,
		});
		await page.screenshot({ path: join(output, `conversation-${width}.png`), fullPage: true });
		// At 1400px a partial token sum with its gap clause, beside a status, pushed Review and Details out of the
		// bar. A throwaway page sets that case up, so the text it writes never reaches the page that goes on.
		if (width === 1600) {
			const probe = await context.newPage();
			try {
				await probe.setViewportSize({ width: 1400, height: 900 });
				await probe.goto(`${page.url()}#${await launch()}`);
				const bar = probe.locator(".conversation .wb-bar");
				const tokens = bar.locator(".wb-chip--figure summary").first();
				await tokens.waitFor();
				// A reading shows whole or wraps out of the bar whole; it is never cut.
				const measure = (status: boolean) =>
					bar.evaluate((element, withStatus) => {
						const summary = element.querySelector(".wb-chip--figure summary");
						if (summary) summary.textContent = "Tokens: ≥415,998 (1 call unknown)";
						if (withStatus) {
							const chip = document.createElement("span");
							chip.className = "wb-chip wb-chip--status";
							chip.innerHTML = "<span>Memory reviewing</span>";
							element.querySelector(".wb-bar__readings")?.before(chip);
						}
						const edge = element.getBoundingClientRect();
						const [review, details] = ['[title="Review changes"]', '[title^="Task details"]'].map((selector) => {
							const box = element.querySelector(selector)?.getBoundingClientRect();
							return !!box && box.left >= edge.left && box.right <= edge.right + 0.5;
						});
						const chip = element.querySelector(".wb-chip--figure") as HTMLElement;
						const figure = chip.getBoundingClientRect();
						const region = element.querySelector(".wb-bar__readings")?.getBoundingClientRect() ?? edge;
						const shown = figure.top < region.bottom && figure.bottom > region.top;
						const whole =
							figure.left >= region.left - 0.5 &&
							figure.right <= region.right + 0.5 &&
							figure.bottom <= region.bottom + 0.5 &&
							chip.scrollWidth <= chip.clientWidth + 1;
						return {
							barOverflows: element.scrollWidth > element.clientWidth + 1,
							reviewInside: review,
							detailsInside: details,
							figure: shown ? (whole ? "whole" : "cut") : "wrapped out",
						};
					}, status);
				const roomy = await measure(false);
				await probe.screenshot({ path: join(output, "conversation-header-1400.png") });
				assert.deepEqual(
					roomy,
					{ barOverflows: false, reviewInside: true, detailsInside: true, figure: "whole" },
					"At 1400px the header must show the whole token figure beside Review and Details",
				);
				await tokens.click();
				const panel = probe.locator(".wb-chip--figure .explain__panel").first();
				await panel.waitFor();
				const panelShown = await panel.evaluate((node) => {
					const box = node.getBoundingClientRect();
					const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
					return box.height > 0 && !!hit && node.contains(hit);
				});
				assert.ok(panelShown, "The token figure's explanation opened clipped by the bar");
				await probe.keyboard.press("Escape");
				const tight = await measure(true);
				await probe.screenshot({ path: join(output, "conversation-header-1400-status.png") });
				assert.ok(
					!tight.barOverflows && tight.reviewInside && tight.detailsInside && tight.figure !== "cut",
					`At 1400px with a status the header cut a reading or lost Review or Details: ${JSON.stringify(tight)}`,
				);
			} finally {
				await probe.close();
			}
		}
		await dark(true);
		await check("conversation-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "conversation-dark.png"), fullPage: true });
		if (width === 320) await page.screenshot({ path: join(output, "conversation-320-dark.png"), fullPage: true });
		await dark(false);
	});
	await step("task pane inspection", async () => {
		// The task pane beside a conversation is read-only inspection. Opening it and each drill-in must
		// preserve the route, unsent text and actual textarea node: a remount can silently lose selection,
		// attachments or editor state.
		const writesBeforeInspection = apiWrites.length;
		const readsBeforeInspection = run.evidenceReads;
		const contextPath = new URL(page.url()).pathname;
		const contextSessionId = contextPath.split("/").at(-1);
		assert.ok(contextSessionId);
		const draft = "Keep this unsent draft while inspecting the workspace.";
		await composerField.fill(draft);
		const originalField = await composerField.elementHandle();
		assert.ok(originalField);
		async function assertConversationPreserved() {
			assert.equal(new URL(page.url()).pathname, contextPath);
			assert.equal(new URL(page.url()).pathname.split("/").at(-1), contextSessionId);
			assert.equal(await composerField.inputValue(), draft);
			assert.equal(
				await originalField.evaluate((node) => node === document.querySelector(".composer__field")),
				true,
				"Pane inspection remounted the conversation composer",
			);
		}
		await openPane();
		await assertConversationPreserved();
		await pane.locator(".pane-steps li").first().waitFor();
		const planTree = await pane.locator(".pane-steps").ariaSnapshot();
		assert.match(planTree, /Completed:.*Read the fixture workspace/);
		assert.match(planTree, /In progress:.*Summarize the findings/);
		await check("pane-session");
		// The column lists evidence from this session's own fleet records only, never the installation's inventory.
		assert.equal(
			await pane.locator(".pane-evidence a").count(),
			0,
			"Unrelated installation bundles were presented as this task's evidence",
		);
		for (const name of ["Context", "Usage", "Tasks and decisions"]) {
			await openDrill(name);
			await pane.locator(".pane__title", { hasText: name }).waitFor();
			await assertConversationPreserved();
			await check(`pane-${name.toLowerCase()}`);
			if (width === 1600 || width === 390)
				await page.screenshot({ path: join(output, `pane-${name.toLowerCase()}-${width}.png`), fullPage: true });
			// The drill moves focus to its title. Docked, Escape steps back to the task details without
			// closing the pane. The slide-over below 1440px closes on Escape from any view, so there the
			// header's Back is the way back.
			assert.equal(
				await pane.locator(".pane__title").evaluate((node) => node === document.activeElement),
				true,
				"a drill-in did not move focus to its title",
			);
			if ((zoom === 2 ? 800 : width) >= 1440) {
				await page.keyboard.press("Escape");
				await pane.locator(".pane__title", { hasText: "Task details" }).waitFor();
				assert.equal(await pane.count(), 1, "Escape in a drill-in closed the pane");
			} else {
				await pane.getByRole("button", { name: "Back to task details", exact: true }).click();
				await pane.locator(".pane__title", { hasText: "Task details" }).waitFor();
			}
		}
		// Changes has no drill-in before a file changes; the top bar's Review control opens the view itself.
		await closePane();
		const changesToggle = page.locator(".conversation .wb-bar").getByRole("button", { name: /^Review changes/ });
		await changesToggle.click();
		await pane.locator(".pane-blank").getByText("No files changed yet.", { exact: true }).waitFor();
		await assertConversationPreserved();
		await check("pane-changes");
		assert.equal(run.evidenceReads, readsBeforeInspection, "The task pane triggered an evidence inventory read");
		await closePane();
		assert.equal(
			await changesToggle.evaluate((node) => document.activeElement === node),
			true,
			"Closing the pane did not return focus to the control that opened it",
		);
		await assertConversationPreserved();
		assert.deepEqual(apiWrites.slice(writesBeforeInspection), [], "Read-only pane inspection performed a write");
		await composerField.fill("");
		await originalField.dispose();
	});
	await step("route picker", async () => {
		// Conversation controls use ACP config options, and saved scope alone can switch connections.
		const route = page.locator(".route-picker");
		// The model name, not only the thinking level, shows that it opens a choice.
		assert.equal(await route.locator("summary .route-chip__text + .route-chip__caret").isVisible(), true);
		await route.locator("summary").click();
		await route.getByText("This conversation.", { exact: true }).waitFor();
		assert.equal(await route.getByLabel("Connection", { exact: true }).isDisabled(), true);
		await route.getByLabel("Model", { exact: true }).selectOption("fixture-small");
		await route.getByLabel("Thinking", { exact: true }).selectOption("high");
		await check("route-picker-conversation");
		await route.getByRole("button", { name: "Apply to this conversation", exact: true }).click();
		await route.locator("summary .route-chip__text").getByText("fixture-small", { exact: true }).waitFor();
		assert.match(
			(await route.locator("summary").getAttribute("title")) ?? "",
			/Connection: fixture\. Model: fixture-small\./,
		);
		await page.waitForFunction(() => !(document.querySelector(".route-picker") as HTMLDetailsElement).open);
		assert.match((await route.locator("summary").getAttribute("title")) ?? "", /Thinking: high/);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		await route.locator("summary").click();
		await route.getByText("This conversation.", { exact: true }).waitFor();
		assert.equal(await route.getByLabel("Apply to", { exact: true }).count(), 0);
		await check("route-picker");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `route-picker-${width}.png`) });
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !(document.querySelector(".route-picker") as HTMLDetailsElement).open);
		assert.equal(await route.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		// Escape closes it without saving and hands focus back to the chip.
		await route.locator("summary").click();
		await route.getByLabel("Thinking", { exact: true }).selectOption("low");
		await page.keyboard.press("Escape");
		assert.equal(await route.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
	});
	await step("task actions menu", async () => {
		// The task's own actions sit in one Task actions menu in the top bar; working freedom is the
		// composer's pill. The menu closes on Escape and hands focus back to its button.
		await taskMenu.locator("summary").click();
		await taskMenu.getByRole("menuitem", { name: "Rename task", exact: true }).waitFor();
		await taskMenu.getByRole("menuitem", { name: "Close task", exact: true }).waitFor();
		await page
			.locator(".composer")
			.getByText("Working freedom for this task", { exact: true })
			.waitFor({ state: "attached" });
		await check("session-controls");
		const menuBounds = await taskMenu.locator(".wb-menu__panel").boundingBox();
		assert.ok(
			menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= (zoom === 2 ? 800 : width),
			`Task actions are outside the viewport at ${width}px: ${JSON.stringify(menuBounds)}`,
		);
		// Twenty items outgrow a phone's height; the panel scrolls itself so Close task stays reachable.
		const viewportHeight = await page.evaluate(() => innerHeight);
		assert.ok(
			menuBounds && menuBounds.y + menuBounds.height <= viewportHeight,
			`Task actions run past the bottom of the viewport at ${width}px: ${JSON.stringify(menuBounds)}`,
		);
		await page.keyboard.press("Escape");
		assert.equal(await taskMenu.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await taskMenu.locator("summary").evaluate((element) => document.activeElement === element), true);
	});
}
