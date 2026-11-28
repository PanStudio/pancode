// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Route } from "playwright-core";
import type { SettingsControls } from "../../contracts/settings-controls.js";
import type { SmokeRun } from "./run.js";

/** Opening a workspace, then the pages set against it: settings, the approval banner over its notice task, models and connections, usage, the hub, and system and interop. */
export async function workspaceSteps(run: SmokeRun) {
	const {
		check,
		context,
		dark,
		errors,
		findSetting,
		h,
		launch,
		leaveSettings,
		navigate,
		openDialog,
		origin,
		output,
		page,
		revealSidebar,
		runIndex,
		setting,
		step,
		width,
		zoom,
	} = run;
	await step("open a workspace", async () => {
		// A project opens from the rail's Open workspace dialog onto its own page, which lists its
		// tasks and offers New task. New task returns to the home composer for that project, and the
		// conversation begins with its first message.
		await leaveSettings();
		await revealSidebar();
		await page
			.locator(".wb-sidebar")
			.getByRole("button", { name: /^Open project/ })
			.click();
		await openDialog.getByLabel("Project folder", { exact: true }).fill(h.home.path);
		await openDialog.getByRole("button", { name: "Open", exact: true }).click();
		await page.waitForURL(/\/workspaces\/[^/]+\/sessions$/);
		await page.locator("main button.primary", { hasText: "New session" }).click();
		await page.waitForURL(`${origin}/`);
		await page.getByLabel("Message PanCode", { exact: true }).fill("Summarize this project.");
		await page.getByRole("button", { name: "Start session", exact: true }).click();
		await page.waitForURL(/\/sessions\/[^/]+$/);
		await page.getByLabel("Message PanCode", { exact: true }).waitFor();
		run.noticeSessionUrl = page.url();
		// The bar also holds the transcript detail picker, so the task's menu is found by its name.
		await page.locator('.conversation .wb-bar .wb-menu:has(> summary[aria-label="Session actions"]) summary').click();
		await page.getByRole("menuitem", { name: /^All sessions in / }).click();
		await page.waitForURL(/\/workspaces\/[^/]+\/sessions$/);
		await page.locator("main button.primary", { hasText: "New session" }).waitFor();
		await page
			.locator("main")
			.getByRole("heading", { name: /^Your work in / })
			.waitFor();
		await check("sessions");
		run.workspaceUrl = page.url();
	});
	await step("settings save beside a notice", async () => {
		// Unavailable saved history is explained inline beside the tasks, not as a toast. A folder that
		// does not exist raises the problem toast that stays up while the settings are written below.
		await revealSidebar();
		await page
			.locator(".wb-sidebar")
			.getByRole("button", { name: /^Open project/ })
			.click();
		await openDialog.getByLabel("Project folder", { exact: true }).fill(join(h.home.path, "does-not-exist"));
		await openDialog.getByRole("button", { name: "Open", exact: true }).click();
		const problemNotice = page.locator(".notice", { hasText: "Check the input" }).last();
		await problemNotice.waitFor();
		await page.keyboard.press("Escape");
		await openDialog.waitFor({ state: "detached" });
		await navigate("All settings");
		// The write surface: a select saves through the engine, a project-set value refuses, a destructive
		// change needs its named confirmation. All settings' search reaches every control by its path.
		await findSetting.fill("chat.thinkingLevel");
		const thinking = setting("chat.thinkingLevel");
		const level = (await thinking.getByRole("combobox").inputValue()) === "low" ? "high" : "low";
		await thinking.getByRole("combobox").selectOption(level);
		const saveThinking = thinking.getByRole("button", { name: "Save", exact: true });
		await saveThinking.scrollIntoViewIfNeeded();
		assert.equal(await problemNotice.isVisible(), true, "the notice is present while Save is used");
		const noticeBounds = await page.locator(".notice-region").boundingBox();
		const saveBounds = await saveThinking.boundingBox();
		assert.ok(noticeBounds && saveBounds);
		assert.ok(
			saveBounds.y + saveBounds.height <= noticeBounds.y ||
				noticeBounds.y + noticeBounds.height <= saveBounds.y ||
				saveBounds.x + saveBounds.width <= noticeBounds.x ||
				noticeBounds.x + noticeBounds.width <= saveBounds.x,
			`notifications must not cover Save at ${width}px: save ${JSON.stringify(saveBounds)}, notices ${JSON.stringify(noticeBounds)}`,
		);
		assert.equal(
			await saveThinking.evaluate((button) => {
				const rect = button.getBoundingClientRect();
				return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
			}),
			true,
			"Save receives pointer input while the notification is visible",
		);
		if (width === 390 || width === 400)
			await page.screenshot({ path: join(output, `notice-save-${width}.png`), fullPage: true });
		await saveThinking.click({ timeout: 1_000 });
		assert.equal(await problemNotice.isVisible(), true, "Save does not wait for notification dismissal");
		await thinking.getByRole("status").getByText("Used by the next relevant request").waitFor();
		await problemNotice.locator(".notice__heading button").first().click();
		await problemNotice.waitFor({ state: "detached" });
		await check("settings-saved");
	});
	await step("approval banner with notices", async () => {
		// A loaded approval can precede its tool-call history. Exercise the full banner beside a
		// growing draft and a full notice row, including the short viewport where the task must scroll.
		const noticeSessionId = new URL(run.noticeSessionUrl).pathname.split("/").at(-1);
		assert.ok(noticeSessionId);
		const noticePage = await context.newPage();
		noticePage.on("pageerror", (error) => errors.push(error.message));
		// The conversation defers its inspectors until their pane opens, so the stack is filled by the
		// reads the shell still makes beside it: the rail's health and saved-history reads.
		const refuse = (route: Route) =>
			route.fulfill({
				status: 503,
				json: {
					type: "urn:pancode:problem:unavailable",
					title: "Notice layout check",
					status: 503,
					code: "unavailable",
					// Notices fold by visible text, so each refused read names its path to stay its own notice.
					detail: `${new URL(route.request().url()).pathname}: ${"The request could not complete. ".repeat(8)}`,
					instance: new URL(route.request().url()).pathname,
				},
			});
		await noticePage.route("**/api/system", refuse);
		await noticePage.route("**/api/workspaces/*/sessions", (route) =>
			route.request().method() === "GET" ? refuse(route) : route.continue(),
		);
		await noticePage.route(`**/api/sessions/${noticeSessionId}{,/**}`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			// Opening a task first asks whether this server holds it. That read is the task's own load,
			// not a read beside it, so it is answered for real: refusing it leaves the page with no task.
			if (path === `/api/sessions/${noticeSessionId}/presence`) await route.continue();
			else if (path === `/api/sessions/${noticeSessionId}`) {
				await route.fulfill({
					json: {
						...h.supervisor.get(noticeSessionId),
						permissions: [
							{
								id: "notice-approval",
								turnId: "notice-turn",
								toolCallId: "notice-call",
								title: "Run a command",
								kind: "execute",
								requestedAt: new Date().toISOString(),
								escalateAt: "2099-01-01T00:00:00Z",
								expiresAt: "2099-01-02T00:00:00Z",
								status: "pending",
								canStopTurn: false,
							},
						],
					},
				});
			} else await refuse(route);
		});
		try {
			await noticePage.goto(`${run.noticeSessionUrl}#${await launch()}`);
			const draft = noticePage.getByLabel("Message PanCode", { exact: true });
			await draft.fill("A draft line\n".repeat(12));
			await noticePage.locator(".approval-banner:not(.approval-banner--strip)").waitFor();
			await noticePage.getByRole("button", { name: "Dismiss all", exact: true }).waitFor();
			for (const height of zoom === 2 ? [await noticePage.evaluate(() => innerHeight)] : [900, 450]) {
				if (zoom !== 2) await noticePage.setViewportSize({ width, height });
				const receivesPointer = (control: Locator) =>
					control.evaluate((element) => {
						const rect = element.getBoundingClientRect();
						return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
					});
				for (const name of ["Reject", "Allow once"]) {
					const answer = noticePage.locator(".conversation__approval").getByRole("button", { name, exact: true });
					await answer.scrollIntoViewIfNeeded();
					assert.equal(await receivesPointer(answer), true, `${name} stays reachable with notices at ${width}×${height}`);
					await answer.click({ trial: true, timeout: 1_000 });
				}
				const transcript = noticePage.locator(".chat-transcript");
				await transcript.scrollIntoViewIfNeeded();
				const transcriptBounds = await transcript.boundingBox();
				assert.ok(transcriptBounds && transcriptBounds.height >= 64, "the transcript keeps a readable scrolling viewport");
				assert.equal(await receivesPointer(transcript), true, "the transcript stays reachable beside approval and draft");
				const submit = noticePage.locator(".composer__submit");
				await submit.scrollIntoViewIfNeeded();
				assert.equal(await receivesPointer(submit), true, "the composer controls stay reachable with notices");
				const noticeList = noticePage.locator(".notice-region__list");
				assert.equal(await noticeList.evaluate((list) => list.scrollHeight > list.clientHeight), true);
				await noticeList.evaluate((list) => {
					list.scrollTop = 100;
				});
				const dismiss = noticePage.locator(".notice__heading button").first();
				await dismiss.focus();
				assert.equal(await dismiss.evaluate((button) => button === document.activeElement), true);
				assert.equal(await receivesPointer(dismiss), true, "the focused individual Dismiss stays above the notice list");
				await dismiss.click({ trial: true, timeout: 1_000 });
				await check(`notice-approval-${height}`, noticePage);
				await noticePage.screenshot({ path: join(output, `notice-approval-${width}-${height}.png`) });
			}
		} finally {
			await noticePage.close();
		}
	});
	await step("settings controls", async () => {
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `settings-controls-${width}.png`), fullPage: true });
		await findSetting.fill("fleet.concurrency");
		await setting("fleet.concurrency").getByText("Set by the project layer").waitFor();
		if (await setting("fleet.concurrency").getByRole("combobox").count())
			throw new Error("A project-set value still offers an editor.");
		await findSetting.fill("fleet.history.maxRuns");
		const history = setting("fleet.history.maxRuns");
		await history.getByRole("spinbutton").fill(String(900 - runIndex * 100));
		if (!(await history.getByRole("button", { name: "Save", exact: true }).isDisabled()))
			throw new Error("A destructive setting saved without its confirmation.");
		await history.getByRole("checkbox").check();
		await check("settings-confirm");
		if (width === 1600) await page.screenshot({ path: join(output, "settings-confirm.png"), fullPage: true });
		await history.getByRole("button", { name: "Save", exact: true }).click();
		await history.getByRole("status").waitFor();
		await findSetting.fill("no-such-setting-anywhere");
		await page.getByText("No settings match your search.", { exact: true }).waitFor();
		await dark(true);
		await findSetting.fill("retry");
		await check("settings-controls-dark");
		await dark(false);
		await page
			.locator("main")
			.getByRole("link", { name: /^Effective values/ })
			.click();
		await page.getByLabel(/^Filter settings/).fill("chat.model");
		await page.getByText("fixture-local-model", { exact: true }).waitFor();
		await check("settings-inspection");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `settings-${width}.png`) });
		await dark(true);
		await check("settings-inspection-dark");
		await dark(false);
		await page.getByRole("link", { name: "Sources & timing", exact: true }).click();
		// Each source category is a disclosure; the hook is listed inside the closed Hooks one.
		await page
			.locator("main")
			.getByRole("heading", { name: "fixture-hook", exact: true, includeHidden: true })
			.waitFor({ state: "attached" });
		await page.locator("main").getByRole("heading", { name: "From source to behavior", exact: true }).waitFor();
		await check("config-graph");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `config-graph-${width}.png`), fullPage: true });
		await dark(true);
		await check("config-graph-dark");
		await dark(false);
	});
	await step("models and connections", async () => {
		// Adding a connection is the guided setup's job; it opens from Models and closes back there.
		await navigate("Models");
		const controlsPath = "**/api/settings/controls?*";
		await page.route(controlsPath, async (route) => {
			const response = await route.fetch();
			const report = (await response.json()) as SettingsControls;
			await route.fulfill({
				json: {
					...report,
					controls: report.controls.map((control) =>
						control.path === "chat.target"
							? { ...control, value: "fixture" }
							: control.path === "chat.model"
								? { ...control, access: "writable" }
								: control,
					),
				},
			});
		});
		await page.reload();
		const catalogSelect = page.locator(".model-select select").first();
		await catalogSelect.waitFor();
		const modelId = await catalogSelect.getAttribute("id");
		const modelField = page.locator(".model-select").filter({ has: page.locator(`[id="${modelId}"]`) });
		await modelField.locator("select").selectOption({ label: "Advanced: unverified model id…" });
		await modelField.getByRole("button", { name: "Choose from the list", exact: true }).click();
		assert.equal(await modelField.locator("select").evaluate((element) => element === document.activeElement), true);
		await page.unroute(controlsPath);
		await page.reload();
		await page
			.locator("main")
			.getByRole("link", { name: /^Add a connection/ })
			.click();
		await page.getByRole("heading", { name: "What do you have?", exact: true }).waitFor();
		await check("targets-onboarding");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `targets-onboarding-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/settings/models");
		await page
			.locator("main")
			.getByRole("link", { name: /^Connections/ })
			.click();
		await page.getByRole("article", { name: "fixture", exact: true }).waitFor();
		await check("targets");
		await page
			.getByRole("article", { name: "fixture", exact: true })
			.getByRole("button", { name: "Use for chat & fleet", exact: true })
			.click();
		await page.locator("main").getByRole("heading", { name: "Use for chat & fleet · done", exact: true }).waitFor();
		await dark(true);
		await check("targets-dark");
		await dark(false);
		await page.getByRole("link", { name: "Fleet routes", exact: true }).click();
		// The routing inventory shows one of profiles, agent bindings and cached models at a time.
		await page
			.getByRole("navigation", { name: "Routing inventory", exact: true })
			.getByRole("button", { name: /^Agent routes ·/ })
			.click();
		await page
			.locator("main")
			.getByRole("heading", { name: /^Agent routes ·/ })
			.waitFor();
		await check("routing");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `routing-${width}.png`), fullPage: true });
		await dark(true);
		await check("routing-dark");
	});
	await step("usage", async () => {
		await page.goto(`${origin}/usage`);
		await page.locator("main").getByRole("heading", { name: "Inside the token record", exact: true }).waitFor();
		// The five bars compare fields with one another, which is the one thing a reader can get
		// wrong by looking; the caveat is part of the panel, not a footnote that can drift away.
		await page.getByText("they are not additive percentages", { exact: false }).waitFor();
		await check("usage-dark");
		await dark(false);
		await check("usage");
		// A repository figure explains to the window `usage report` folded, rebuilt ending now (#434 §11.4).
		const windowTokens = page
			.locator("main .usage-totals article", { hasText: "Recorded tokens" })
			.locator("details.explain");
		await windowTokens.locator("summary").click();
		const windowExplanation = windowTokens.locator(".explain__panel");
		await windowExplanation.locator("dt", { hasText: /^Coverage$/ }).waitFor();
		assert.equal(
			(await windowExplanation.locator("dd").first().innerText()).trim(),
			(await windowTokens.locator("summary").innerText()).trim(),
			"the window's explanation states the figure it explains",
		);
		await check("usage-explain");
		await page.keyboard.press("Escape");
		// Each recorded route has a dense row whose figures explain themselves; the grouping switches to targets.
		const usageModelRow = page
			.getByRole("region", { name: "Recorded usage by model", exact: true })
			.locator("tbody tr", { has: page.locator("th", { hasText: /fixture-model$/ }) });
		const modelTokens = usageModelRow.locator("td").nth(5).locator("details.explain");
		await modelTokens.locator("summary").click();
		await modelTokens.locator(".explain__panel dt", { hasText: /^Coverage$/ }).waitFor();
		await check("usage-model-row");
		await modelTokens.locator("summary").click();
		await page.locator("main").getByRole("button", { name: "Per target", exact: true }).click();
		await page
			.getByRole("region", { name: "Recorded usage by target", exact: true })
			.locator("tbody tr", { has: page.locator("th", { hasText: /fixture/ }) })
			.first()
			.waitFor();
		await check("usage-target-rows");
		await page.locator("main").getByRole("button", { name: "Per model", exact: true }).click();
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `usage-${width}.png`), fullPage: true });
	});
	await step("hub", async () => {
		await navigate("Hub");
		// The catalog is the landing collection: plan, review, apply, then remove, all against the bundled index.
		const offer = page.locator("main").getByRole("listitem", { name: "skill:map-codebase", exact: true });
		await offer.waitFor();
		await check("hub-catalog");
		await offer.getByRole("button", { name: "Install skill:map-codebase for me", exact: true }).click();
		const review = page.getByRole("dialog", { name: "Install skill:map-codebase", exact: true });
		await review.getByText("This is exactly what will be applied. Nothing has been written yet.").waitFor();
		await review.getByText("Staged and verified").waitFor();
		await check("hub-plan");
		await review.getByRole("button", { name: "Apply this change", exact: true }).click();
		await review.getByText("The files are on disk and the install record matches.").waitFor();
		// The change reaches open conversations by reload; with none open the note says so.
		const refreshNote = review.locator(".hub-session-note");
		await refreshNote.waitFor();
		assert.doesNotMatch(await refreshNote.innerText(), /did not reload/);
		await check("hub-applied");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `hub-applied-${width}.png`) });
		await review.getByRole("button", { name: "Done", exact: true }).click();
		await offer.locator(".status-mark", { hasText: "Active" }).waitFor();
		// A second user install is no longer offered; the project scope still is.
		if (await offer.getByRole("button", { name: "Install skill:map-codebase for me", exact: true }).count())
			throw new Error("An installed user copy still offers a user install.");
		await offer.getByRole("button", { name: "Install skill:map-codebase in this project", exact: true }).waitFor();
		await page
			.locator("main")
			.getByRole("button", { name: /^Installed only · [1-9]/ })
			.click();
		await check("hub-installed");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `hub-installed-${width}.png`), fullPage: true });
		await dark(true);
		await check("hub-installed-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "hub-installed-dark.png"), fullPage: true });
		await dark(false);
		await offer.getByRole("button", { name: "Remove the user copy of skill:map-codebase", exact: true }).click();
		const removal = page.getByRole("dialog", { name: "Remove skill:map-codebase", exact: true });
		await removal.getByRole("button", { name: "Apply this change", exact: true }).click();
		await removal.getByText("The files and the install record are gone.").waitFor();
		await removal.getByRole("button", { name: "Done", exact: true }).click();
		await offer.waitFor({ state: "detached" });
		await page.locator("main").getByRole("listitem", { name: "extension:fixture-extension", exact: true }).waitFor();
		assert.equal(await page.locator("main .hub-packages > li").count(), 1);
		await page
			.locator("main")
			.getByRole("tablist", { name: "Hub collections" })
			.getByRole("tab", { name: /^Skills · [1-9]/ })
			.click();
		await page.locator("main").getByRole("heading", { name: "fixture-skill", exact: true }).waitFor();
		await check("hub-skills");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `hub-skills-${width}.png`), fullPage: true });
		// The collections are one tab stop: an arrow key moves the selection and the focus together.
		await page
			.locator("main")
			.getByRole("tab", { name: /^Skills · / })
			.press("ArrowLeft");
		const agentsTab = page.locator("main").getByRole("tab", { name: /^Agents · / });
		await agentsTab.and(page.locator('[aria-selected="true"]')).waitFor();
		if ((await agentsTab.getAttribute("aria-selected")) !== "true")
			throw new Error("ArrowLeft from Skills did not select the Agents tab.");
		if (!(await agentsTab.evaluate((node) => node === document.activeElement)))
			throw new Error("ArrowLeft moved the selection without moving focus.");
		const agentDetails = page.locator("main .hub-resource__details").first();
		await agentDetails.locator(":scope > summary").click();
		await agentDetails.getByText("Tool-call budget", { exact: true }).waitFor();
		await check("hub-agent-details");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `hub-agents-${width}.png`), fullPage: true });
		for (const collection of ["Agents", "Prompts", "Playbooks", "Extensions", "Verifiers"]) {
			await page
				.locator("main")
				.getByRole("tab", { name: new RegExp(`^${collection} · [1-9]`) })
				.click();
			const resource = page.locator("main .hub-resource").first();
			await resource.waitFor();
			const details = resource.locator(".hub-resource__details");
			if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
				await details.locator(":scope > summary").click();
			await check(`hub-${collection.toLowerCase()}`);
		}
		await dark(true);
		await check("hub-dark");
	});
	await step("system and interop", async () => {
		await navigate("System");
		await page.locator("main summary", { hasText: "PanCode folders" }).waitFor();
		await check("system-dark");
		await page.locator("main").getByRole("link", { name: "Other coding agents", exact: true }).click();
		await page.locator("main").getByRole("heading", { name: "Codex", exact: true }).waitFor();
		await check("interop-dark");
		await dark(false);
		await page.getByText("Would be offered", { exact: true }).waitFor();
		// Opening the page ran nothing. The probe is an explicit act, and the page survives it.
		await page.getByRole("button", { name: "Detect again and probe versions", exact: true }).click();
		await page.getByRole("button", { name: "Detect again and probe versions", exact: true }).waitFor();
		await check("interop");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `interop-${width}.png`), fullPage: true });
	});
}
