// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import type { SmokeRun } from "./run.js";

/** Refusals, retries and races: the problem toast, refused and spent launch links, a forgotten browser, fast typing, the report dialog's retry, a starting task, a rejected approval, dispatch rows and a task that is not open. */
export async function recoverySteps(run: SmokeRun) {
	const {
		browser,
		check,
		closePane,
		composerField,
		context,
		eventually,
		h,
		launch,
		navigate,
		openDialog,
		openDrill,
		origin,
		output,
		page,
		pane,
		revealSidebar,
		settled,
		statuses,
		step,
		stubHeader,
		width,
		zoom,
	} = run;
	await step("problem toast", async () => {
		// A folder that does not exist is refused with the problem's reference.
		await revealSidebar();
		await page
			.locator(".wb-sidebar")
			.getByRole("button", { name: /^Open project/ })
			.click();
		await openDialog.getByLabel("Project folder", { exact: true }).fill(join(h.home.path, "does-not-exist"));
		await openDialog.getByRole("button", { name: "Open", exact: true }).click();
		const toast = page.locator(".notice-region .notice", { hasText: "Check the input" });
		await toast.waitFor();
		assert.match(await toast.innerText(), /Check the input/);
		await check("problem-toast");
		await page.keyboard.press("Escape");
		await openDialog.waitFor({ state: "detached" });
		// The code and reference sit under the toast's Technical details disclosure.
		await toast.locator("summary", { hasText: "Technical details" }).click();
		assert.match(await toast.innerText(), /Reference: [0-9a-f-]+/);
	});
	await step("refused launch link", async () => {
		// A refused launch link must not brick the app: the shell says what happened, stops reconnecting, and a
		// pasted launch link brings the same tab back.
		// The document reads the ticket, clears it from the address bar and exchanges it at once; a reload would
		// abort that exchange and reconnect on the remembered credential, so the refusal itself is awaited.
		const exchange = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/auth/clients" && response.request().method() === "POST",
		);
		await page.goto(`${origin}/#ticket=${"s".repeat(43)}`);
		assert.equal((await exchange).status(), 401, "the refused launch ticket was not refused at the exchange");
		await page.getByRole("heading", { name: "This browser is no longer connected", exact: true }).waitFor();
		// The refused shell shows no task rail, so nothing behind the panel keeps reading.
		assert.equal(await page.locator(".wb-sidebar .wb-side").count(), 0, "a refused token still renders the task rail");
		if ((await page.locator(".notice-region .notice").count()) > 0)
			throw new Error("A refused token raised toasts on top of the reconnect panel.");
		await page.getByLabel("Launch link", { exact: true }).fill("not a link");
		await page.getByText("That text is not a launch link.", { exact: true }).waitFor();
		await check("reconnect");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `reconnect-${width}.png`) });
		await page.getByLabel("Launch link", { exact: true }).fill(`[pancode:gui] ${origin}/#${await launch()}`);
		await page.getByRole("button", { name: "Connect this browser", exact: true }).click();
		// The connected rail reports installation health once its diagnostics settle; it defers the doctor until System
		// is opened, so "Not checked" is a settled connected state too.
		await page
			.locator(".wb-sidebar .wb-status__label")
			.filter({ hasText: /^(Ready|Unverified|Not checked|\d+ issues?|\d+ warnings?)$/ })
			.waitFor({ state: "attached" });
		await page
			.getByRole("heading", { name: "This browser is no longer connected", exact: true })
			.waitFor({ state: "detached" });
	});
	await step("forget this browser", async () => {
		// Forgetting the browser signs this window out on the server before it drops the launch token, so
		// the credential it held opens nothing afterwards.
		await navigate("General");
		await page.locator("main").getByRole("heading", { name: "General", exact: true }).waitFor();
		const [signedOut] = await Promise.all([
			page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/revoke"),
			page.getByRole("button", { name: "Forget this browser", exact: true }).click(),
		]);
		assert.equal(signedOut.status(), 200);
		const forgotten = signedOut.request().headers().authorization ?? "";
		assert.match(forgotten, /^Bearer [\w-]{43}$/);
		await page.getByRole("heading", { name: "Open your launch link", exact: true }).waitFor();
		assert.equal(
			(await fetch(`${origin}/api/meta`, { headers: { Authorization: forgotten } })).status,
			401,
			"a forgotten window's credential still opens the API",
		);
		// The dialog promises a new launch link: a reload of the forgotten tab inherits nothing that reconnects it.
		await page.reload();
		await page.getByRole("heading", { name: "Open your launch link", exact: true }).waitFor();
		assert.equal(await page.locator(".wb-sidebar .wb-side").count(), 0, "a forgotten tab reconnected on reload");
	});
	await step("search boxes keep fast typing", async () => {
		// The router commits search params in a transition, so a box bound straight to the URL dropped keys
		// under load. A throttled CPU is what made it visible; each box must keep every key and Backspace.
		await page.goto(`${origin}/#${await launch()}`);
		await page.getByRole("heading", { level: 1 }).first().waitFor();
		await page.locator(".reconnect").waitFor({ state: "detached" });
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		const settledQuery = async (value: string) => {
			await page.waitForFunction((expected) => (new URL(location.href).searchParams.get("q") ?? "") === expected, value);
		};
		const typeFast = async (box: Locator, where: string) => {
			await box.waitFor();
			await box.pressSequentially("abcdefgh", { delay: 0 });
			assert.equal(await box.inputValue(), "abcdefgh", `${where} dropped a fast key`);
			for (let press = 0; press < 3; press++) await box.press("Backspace", { delay: 0 });
			assert.equal(await box.inputValue(), "abcde", `${where} lost a fast Backspace`);
			await settledQuery("abcde");
			assert.equal(await box.inputValue(), "abcde", `${where} was reset by a late URL echo`);
		};
		try {
			await page.goto(`${origin}/sessions`);
			await typeFast(page.getByRole("searchbox", { name: "Search sessions", exact: true }), "Sessions");
			await page.goto(run.workspaceUrl);
			const tasksBox = page.getByRole("searchbox", { name: "Find a session", exact: true });
			await typeFast(tasksBox, "the project task list");
			// Clear filters is an outside write: the box adopts it, and Back restores the committed search.
			await page.locator("main").getByRole("button", { name: "Clear filters", exact: true }).click();
			await settledQuery("");
			assert.equal(new URL(page.url()).searchParams.get("q"), null);
			// The box adopts an outside write a render after the URL commits; a throttled CPU widens that gap.
			await eventually(() => tasksBox.inputValue(), "", "Clear filters left text in the box");
			await page.goBack();
			await settledQuery("abcde");
			await eventually(() => tasksBox.inputValue(), "abcde", "Back did not restore the earlier search");
			await page.goto(`${origin}/hub?collection=skills`);
			const hubBox = page.getByRole("searchbox", { name: "Search skills", exact: true });
			await hubBox.waitFor();
			assert.ok((await hubBox.getAttribute("placeholder"))?.trim(), "the hub search has no placeholder");
			// Focus first: at 200% the box starts below the fold, and the press would scroll it into view.
			await hubBox.focus();
			const before = await hubBox.boundingBox();
			await hubBox.press("a");
			await settledQuery("a");
			const after = await hubBox.boundingBox();
			assert.ok(before && after, "the hub search box has no box");
			for (const key of ["x", "y", "width", "height"] as const)
				assert.ok(Math.abs(before[key] - after[key]) <= 0.5, `typing moved the hub search box (${key})`);
			// The native × is the row's one clear control; "Clear search" lives only in the empty state.
			assert.equal(
				await page
					.locator("main label.settings-filter")
					.evaluate(
						(label) =>
							[...(label.parentElement?.children ?? [])].filter(
								(node) => node.tagName === "BUTTON" && node.textContent?.trim() === "Clear search",
							).length,
					),
				0,
				"the hub search row still carries a Clear search button",
			);
			await hubBox.fill("");
			await settledQuery("");
			await typeFast(hubBox, "Hub");
		} finally {
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
			await cdp.detach();
		}
	});
	await step("report dialog prefetch and retry", async () => {
		// Help warms the report chunk, so the dialog's first frame is the dialog; a failed plan says so and retries.
		await page.goto(run.noticeSessionUrl);
		await composerField.waitFor();
		await page.keyboard.press("Control+/");
		await page.getByRole("heading", { name: "Shortcuts & help", exact: true }).waitFor();
		await page.waitForFunction(() =>
			performance.getEntriesByType("resource").some((entry) => /\/ReportDialog[-.][^/]*\.js$/.test(entry.name)),
		);
		const planned = page.waitForResponse(
			(response) =>
				/\/api\/workspaces\/[^/]+\/reports\/plan$/.test(new URL(response.url()).pathname) &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Report a problem", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Report a problem", exact: true });
		await dialog.waitFor();
		assert.notEqual((await planned).status(), 405, "the report plan route is not served");
		const preview = dialog.locator(".report-dialog__preview");
		await page.waitForFunction(
			() => (document.querySelector(".report-dialog__preview")?.textContent ?? "").trim().length > 0,
		);
		assert.doesNotMatch(await preview.innerText(), /No preview yet/);
		// Report opens over Help: Esc closes Report alone and returns to the button that opened it (R2-18).
		const helpDialog = page.getByRole("dialog", { name: "Shortcuts & help", exact: true });
		assert.equal(await helpDialog.count(), 1, "opening Report closed Help");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		assert.equal(await helpDialog.count(), 1, "Esc on Report also closed Help");
		await eventually(
			() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""),
			"Report a problem",
			"Esc on Report did not return focus to Help's Report button",
		);
		await page.keyboard.press("Escape");
		await helpDialog.waitFor({ state: "detached" });
		let planPosts = 0;
		const planRoute = "**/api/workspaces/*/reports/plan";
		await page.route(planRoute, async (route) => {
			planPosts++;
			await route.fulfill({
				status: 500,
				contentType: "application/problem+json",
				headers: { [stubHeader]: "1" },
				body: JSON.stringify({
					type: "urn:pancode:problem:internal",
					title: "Internal error",
					status: 500,
					code: "internal",
					detail: "Stubbed plan failure.",
					instance: "browser-smoke",
				}),
			});
		});
		try {
			await page.keyboard.press("Control+/");
			await page.getByRole("button", { name: "Report a problem", exact: true }).click();
			await dialog.waitFor();
			const failed = dialog.locator(".report-dialog__failed");
			await failed.getByText("PanCode could not prepare the report", { exact: true }).waitFor();
			assert.equal(await dialog.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
			const before = planPosts;
			await failed.getByRole("button", { name: "Try again", exact: true }).click();
			for (let wait = 0; wait < 50 && planPosts === before; wait++) await page.waitForTimeout(100);
			await failed.getByText("PanCode could not prepare the report", { exact: true }).waitFor();
			assert.equal(planPosts, before + 1, "Try again did not re-POST the plan exactly once");
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "detached" });
			await page.keyboard.press("Escape");
			await helpDialog.waitFor({ state: "detached" });
		} finally {
			// The stub marks its 500s, so the response listener never records them, however late they land.
			await page.unroute(planRoute);
		}
	});
	await step("start keeps the request on screen", async () => {
		// From Ctrl+Enter until the first turn renders, the operator's words never leave the screen. The Home
		// field still holds them while the task starts, so a sample reads field values as well as text.
		await page.goto(run.workspaceUrl);
		await page.locator("main button.primary", { hasText: "New session" }).click();
		await page.waitForURL(`${origin}/`);
		await composerField.fill("[hold] start probe");
		await page.evaluate(() => {
			const probe = globalThis as unknown as { __startSamples: string[]; __startDone: boolean };
			probe.__startSamples = [];
			probe.__startDone = false;
			const observer = new MutationObserver(() => {
				if (probe.__startDone) return;
				const main = document.querySelector("main");
				const fields = [...(main?.querySelectorAll("textarea, input") ?? [])]
					.map((field) => (field as HTMLInputElement).value)
					.join(" ");
				probe.__startSamples.push(`${main?.innerText ?? ""} ${fields}`.trim());
				if (document.querySelector(".chat-turn")) {
					probe.__startDone = true;
					observer.disconnect();
				}
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
		});
		await composerField.press("Control+Enter");
		await page.waitForFunction(() => (globalThis as unknown as { __startDone: boolean }).__startDone);
		const samples = await page.evaluate(() => (globalThis as unknown as { __startSamples: string[] }).__startSamples);
		assert.ok(samples.length > 0, "nothing was sampled while the task started");
		assert.deepEqual(
			samples.filter((sample) => sample === "" || !sample.includes("start probe")),
			[],
			"the request left the screen while the task started",
		);
		const stop = page.getByRole("button", { name: "Stop turn", exact: true });
		if (await stop.count()) await stop.click();
		await settled();
	});
	await step("approval countdown, record and rejection", async () => {
		await composerField.fill("[approval] Write the probe file.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.locator(".approval-strip__left").waitFor();
		await page
			.locator(".approval-card__facts li", { hasText: "No answer in" })
			.filter({ visible: true })
			.first()
			.waitFor({ state: "attached" });
		// The banner and the card read one shared second, so no frame shows them a second apart.
		const pairs = await page.evaluate(async () => {
			const out: (string | null)[][] = [];
			for (let sample = 0; sample < 5; sample++) {
				const strip = document.querySelector(".approval-strip__left")?.textContent ?? "";
				const card =
					[...document.querySelectorAll(".approval-card__facts li")]
						.map((node) => node.textContent ?? "")
						.find((text) => text.startsWith("No answer in")) ?? "";
				// The strip reads "stops in 9m 46s"; the card "No answer in 9m 46s (at 20:46) stops this turn".
				out.push([/stops in (.+)$/.exec(strip)?.[1] ?? null, /^No answer in (.+?) \(at /.exec(card)?.[1] ?? null]);
				await new Promise((resolve) => requestAnimationFrame(resolve));
			}
			return out;
		});
		for (const [banner, card] of pairs) {
			assert.ok(banner && card, "a countdown was missing from the banner or the card");
			assert.equal(banner, card, "the banner and the card disagree on the time left");
		}
		await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
		await page.getByText("Tool executed.", { exact: true }).last().waitFor();
		// A settled group folds; open it the way an operator would, then read the record at the call's row.
		const lastGroup = page.locator(".chat-turn").last().locator("details.activity").last();
		if (!(await lastGroup.evaluate((node) => (node as HTMLDetailsElement).open)))
			await lastGroup.locator(":scope > summary").click();
		const recordRow = lastGroup.locator(".activity__rows > li", {
			has: page.locator(".approval-record", { hasText: "Allowed once by the operator." }),
		});
		await recordRow.waitFor();
		assert.ok((await recordRow.locator(".tool-card").count()) > 0, "the decision record is not at its call's row");
		await composerField.fill("[approval] Write the probe file once more.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Reject", exact: true }).first().click();
		await page.getByText("Permission rejected.", { exact: true }).last().waitFor();
		await settled();
		const outcome = page.locator(".chat-turn").last().locator(".turn-outcome");
		await outcome.waitFor();
		assert.notEqual(await outcome.getAttribute("data-tone"), "success", "a turn whose change was rejected reads Done");
		const struck = page.locator(".chat-turn").last().locator(".diff.is-rejected .diff__row.is-add .diff__text").first();
		await struck.waitFor();
		assert.match(
			await struck.evaluate((node) => getComputedStyle(node).textDecorationLine),
			/line-through/,
			"a rejected change still reads as an edit",
		);
	});
	await step("plan dispatch rows name every run", async () => {
		await composerField.fill("[plan] Survey the samples and draft a report.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.locator(".approval-card", { hasText: "Dispatch plan · 2 runs · in parallel" }).first().waitFor();
		await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
		await page.getByText("The plan is running.", { exact: true }).last().waitFor();
		const lastGroup = page.locator(".chat-turn").last().locator("details.activity").last();
		if (!(await lastGroup.evaluate((node) => (node as HTMLDetailsElement).open)))
			await lastGroup.locator(":scope > summary").click();
		// A batch's card heads with its task count (pinned in tests/chat-tools.test.ts) and, opened, names each
		// run as "N · agent" with its task.
		const row = lastGroup
			.locator(".tool-card", { has: page.locator(".tool-card__headline", { hasText: /^2 tasks$/ }) })
			.first();
		await row.waitFor();
		if (!(await row.evaluate((node) => (node as HTMLDetailsElement).open))) await row.locator(":scope > summary").click();
		const runs = [
			["scout", "Survey the soil samples"],
			["writer", "Draft the comparison report"],
		] as const;
		for (const [index, [agent, task]] of runs.entries()) {
			const fact = row.locator(".tool-card__fact", {
				has: page.locator(".tool-card__fact-label", { hasText: `${index + 1} · ${agent}` }),
			});
			await fact.waitFor();
			assert.equal((await fact.locator(".tool-card__fact-value").innerText()).trim(), task);
		}
		// The allowed plan's runs reach the Agents drill, one node per task.
		await openDrill("Agents");
		for (const [agent, task] of runs) {
			const node = pane.locator(".worker-graph .agents-node", {
				has: page.locator(".agents-node__task", { hasText: task }),
			});
			await node.first().waitFor();
			assert.equal((await node.first().locator(".agents-node__agent").innerText()).trim(), agent);
		}
		await closePane();
	});
	await step("launch link opened twice", async () => {
		// A launch link works once. The second opening names that, offers this origin's link shape, and centres.
		const link = `${origin}/#${await launch()}`;
		await page.goto(link);
		await page.getByRole("heading", { level: 1 }).first().waitFor();
		await page.locator(".reconnect").waitFor({ state: "detached" });
		const other = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		try {
			await other.route("**/*", async (route) => {
				if (new URL(route.request().url()).origin === origin) await route.continue();
				else await route.abort();
			});
			const second = await other.newPage();
			await second.goto(link);
			await second.getByText("already used or has expired").waitFor();
			const placeholder = await second.getByLabel("Launch link", { exact: true }).getAttribute("placeholder");
			assert.ok(placeholder?.startsWith(await second.evaluate(() => location.origin)), `placeholder ${placeholder}`);
			// A new install paints the brand's graphite ground even when the device asks for light.
			assert.equal(await second.locator("html").getAttribute("data-theme"), "dark");
			assert.equal(await second.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(14, 17, 19)");
			const gaps = await second.evaluate(() => {
				const card = document.querySelector(".reconnect")?.getBoundingClientRect();
				const main = document.querySelector("main")?.getBoundingClientRect();
				return card && main ? { left: card.left - main.left, right: main.right - card.right } : null;
			});
			assert.ok(gaps, "the reconnect card or main is missing");
			assert.ok(Math.abs(gaps.left - gaps.right) <= 2, `the reconnect card is off centre: ${JSON.stringify(gaps)}`);
		} finally {
			await other.close();
		}
	});
	await step("not-open heading outranks its text", async () => {
		const missing = `not-open-probe-${width}-${zoom}`;
		await page.goto(`${origin}/sessions/${missing}`);
		const state = page.locator(".task-state");
		await state.getByRole("heading", { name: "This session is not open", exact: true }).waitFor();
		const sizes = await state.evaluate((node) => ({
			heading: Number.parseFloat(getComputedStyle(node.querySelector("h1") as Element).fontSize),
			text: Number.parseFloat(getComputedStyle(node.querySelector("p") as Element).fontSize),
		}));
		assert.ok(sizes.heading > sizes.text, `the not-open heading reads smaller than its text: ${JSON.stringify(sizes)}`);
		// Looking up a task that does not exist is this step's own question, not a server fault.
		for (let index = statuses.length - 1; index >= 0; index--)
			if (statuses[index]?.path.includes(missing)) statuses.splice(index, 1);
	});
}
