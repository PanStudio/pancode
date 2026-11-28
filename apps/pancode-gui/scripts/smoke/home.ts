// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import assert from "node:assert/strict";
import { join } from "node:path";
import { SETTINGS_SECTIONS } from "../../client/shell/shell-model.js";
import type { SmokeRun } from "./run.js";

/** Launch, the home page and its preferences, the theme and toolchain, and the record pages reached from home: trace runs, fleet history, evidence and help. */
export async function homeSteps(run: SmokeRun) {
	const {
		check,
		dark,
		launch,
		leaveSettings,
		navigate,
		origin,
		output,
		page,
		phone,
		step,
		width,
		zoom,
		zoomMeasurements,
	} = run;
	await step("launch", async () => {
		await page.goto(`${origin}/#${await launch()}`);
		await page.getByRole("heading", { level: 1 }).waitFor();
		if (zoom === 2) {
			const measurement = await page.evaluate(() => ({
				outerWidth,
				innerWidth,
				devicePixelRatio,
				visualScale: visualViewport?.scale ?? 0,
			}));
			zoomMeasurements.push(measurement);
			assert.deepEqual(measurement, { outerWidth: 1600, innerWidth: 800, devicePixelRatio: 2, visualScale: 1 });
			assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).zoom), "1");
			await page.bringToFront();
		}
	});
	await step("home and preferences", async () => {
		// The new-task field takes focus on a fine pointer, so the skip link is the first stop on a page
		// that opens without a focused field.
		await page.goto(`${origin}/settings/general`);
		await page.locator("main").getByRole("heading", { name: "General", exact: true }).waitFor();
		await page.keyboard.press("Tab");
		assert.equal(await page.locator(".skip-link").evaluate((element) => document.activeElement === element), true);
		await page.keyboard.press("Enter");
		assert.equal(await page.locator("#main").evaluate((element) => document.activeElement === element), true);
		await page.goto(`${origin}/`);
		await page.getByRole("heading", { level: 1 }).waitFor();
		assert.equal(await page.locator("footer").count(), 0);
		const header = await page.locator(".wb-bar").boundingBox();
		assert.ok(header && header.height <= 60);
		// The brand is the drawn PanCode mark, an inline SVG that animates while a task works.
		const brand = await page.locator(".wb-brand svg").first().boundingBox();
		assert.ok(brand !== null && brand.width > 0, "the brand mark is drawn");
		assert.equal(await page.evaluate(() => localStorage.getItem("pancode-gui-theme")), "system");
		await page.emulateMedia({ colorScheme: "dark" });
		assert.equal(await page.locator("html").getAttribute("data-theme"), null);
		assert.equal(await page.evaluate(() => localStorage.getItem("pancode-gui-theme")), "system");
		await check("home-system-dark");
		await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
		await page.waitForFunction(() => {
			const button = document.querySelector("button");
			return (
				button &&
				getComputedStyle(button)
					.transitionDuration.split(",")
					.some((value) => parseFloat(value) > 0.001)
			);
		});
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.waitForFunction(() => {
			const button = document.querySelector("button");
			return (
				button &&
				getComputedStyle(button)
					.transitionDuration.split(",")
					.every((value) => parseFloat(value) <= 0.000001)
			);
		});
		assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
		// The light flip above ran with motion on; a colour transition already running outlives the reduce.
		await page.evaluate(() =>
			Promise.allSettled(
				document
					.getAnimations()
					.filter((animation) => animation instanceof CSSTransition)
					.map((animation) => animation.finished),
			),
		);
		await check("home-live-preferences");
		await check("home");
		if (width === 1600) await page.screenshot({ path: join(output, "home.png"), fullPage: true });
		if (width === 320) await page.screenshot({ path: join(output, "320-home-light.png"), fullPage: true });
		if (phone) {
			const opener = page.locator(".wb-bar").getByRole("button", { name: "Show sidebar", exact: true });
			await opener.click();
			await page.locator('.wb[data-drawer="open"]').waitFor();
			await check("navigation");
			// Escape closes the drawer and hands focus back to the button that opened it.
			await page.keyboard.press("Escape");
			await page.locator('.wb[data-drawer="closed"]').waitFor({ state: "attached" });
			assert.equal(await opener.evaluate((node) => document.activeElement === node), true);
		}
	});
	await step("theme choice and programs", async () => {
		// Install, the browser's connection and the theme moved from the masthead to General settings.
		await navigate("General");
		await page.locator("main").getByRole("heading", { name: "General", exact: true }).waitFor();
		await page.getByRole("button", { name: "Forget this browser" }).waitFor();
		await check("app-preferences");
		// An explicit choice wins over the device and is remembered, System included.
		await page.getByRole("radio", { name: /^Dark/ }).check({ force: true });
		await page.locator(':root[data-theme="dark"]').waitFor();
		assert.equal(await page.evaluate(() => localStorage.getItem("pancode-gui-theme")), "dark");
		await check("app-preferences-dark");
		await leaveSettings();
		await check("home-dark");
		await page.screenshot({ path: join(output, `${width}-home-dark.png`), fullPage: true });
		await navigate("General");
		await page.getByRole("radio", { name: /^System/ }).check({ force: true });
		await page.locator(":root:not([data-theme])").waitFor();
		assert.equal(await page.evaluate(() => localStorage.getItem("pancode-gui-theme")), "system");
		await navigate("Programs");
		await page.getByRole("article", { name: "herdr", exact: true }).waitFor();
		await check("programs");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `programs-${width}.png`), fullPage: true });
	});
	await step("stale bundle notice", async () => {
		// A window whose bundle was built for another version than the server's says so and offers a reload, which it
		// never does on its own.
		await page.route("**/api/meta", async (route) => {
			const response = await route.fetch();
			await route.fulfill({ response, json: { ...(await response.json()), pancode: "0.0.0-stale" } });
		});
		await page.reload();
		const staleNotice = page.locator(".app-update-notice", { hasText: "the server runs 0.0.0-stale." });
		await staleNotice.getByRole("button", { name: "Reload this window", exact: true }).waitFor();
		await check("stale-bundle");
		await page.unroute("**/api/meta");
		await page.reload();
		await page.locator("main").getByRole("article", { name: "herdr", exact: true }).waitFor();
		assert.equal(await staleNotice.count(), 0, "a matching server still shows the stale-bundle notice");
	});
	await step("trace run", async () => {
		await navigate("Traces");
		await page.locator('main a[href^="/traces/run-0000"]').waitFor();
		await check("traces");
		await page.locator('main a[href^="/traces/run-0000"]').click();
		await page.locator("main").getByRole("heading", { name: "Inspect fixture 0", exact: true }).waitFor();
		// The replay steps through the run journal: the worker process, the run feed and the call (#434).
		await page.getByText("Tool finished: read", { exact: true }).first().waitFor({ state: "attached" });
		await page.getByText("worker call · settled", { exact: true }).first().waitFor({ state: "attached" });
		await page.getByRole("tab", { name: /^Execution · 1 call$/ }).click();
		await page.locator("main .trace-lane .trace-stage").first().waitFor({ state: "attached" });
		// The run's spend by token kind, then by the model each call settled on, every figure explained (#434 §11.3).
		const spend = page.locator("main section", {
			has: page.getByRole("heading", { name: "Tokens and spend", exact: true }),
		});
		const modelCost = spend.locator(".trace-model-spend > li").first().locator("details.explain").last();
		await modelCost.locator("summary").click();
		await modelCost.locator(".explain__panel dt", { hasText: /^Coverage$/ }).waitFor();
		await check("trace-run-spend");
		await modelCost.locator("summary").click();
		await page.getByRole("tab", { name: /^Replay/ }).click();
		// The cost cell is the server's render; a row may read partial or unmeasured, so only
		// its presence is checked here.
		const costCell = page
			.locator("main .trace-totals li", { has: page.locator("span", { hasText: /^Cost$/ }) })
			.locator("strong");
		await costCell.waitFor();
		assert.notEqual((await costCell.innerText()).trim(), "", "the run's cost cell is empty");
		// A displayed quantity explains itself: its value, coverage and fold rule in the read model's words (#434 §11.4).
		const tokensExplain = page
			.locator("main .trace-totals li", { has: page.locator("span", { hasText: /^Tokens$/ }) })
			.locator("details.explain");
		await tokensExplain.locator("summary").click();
		const explanation = tokensExplain.locator(".explain__panel");
		await explanation.locator("dt", { hasText: /^Coverage$/ }).waitFor();
		assert.notEqual(
			(await explanation.locator(".explain__rule").innerText()).trim(),
			"",
			"the explanation names no rule",
		);
		await check("trace-run-explain");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `trace-run-explain-${width}.png`) });
		await page.keyboard.press("Escape");
		assert.equal(await tokensExplain.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.ok(
			await tokensExplain.locator("summary").evaluate((element) => element === document.activeElement),
			"Escape hands focus back to the explained number",
		);
		// A run opens on its replay; the sealed record's checks have their own view.
		await page.getByRole("tab", { name: /^Checks & record/ }).click();
		// Format conformance and contract quality are separate facts; an unmeasured quality never reads as a pass.
		const checkRow = (label: string) =>
			page.locator(".run-record-check", { has: page.getByText(label, { exact: true }) });
		const mark = (label: string, word: string) =>
			checkRow(label).locator(".run-record-check__state .status-mark", { hasText: word }).waitFor();
		await mark("Result format", "Conforms");
		await mark("Result quality", "Not measured");
		await mark("Claimed checks", "1 of 2 claims grounded");
		// The checks stand under the seal the read model verified; the saved document comes only on request (#434 §11.3).
		await page.locator(".run-record-checks__integrity .status-mark", { hasText: "sealed" }).waitFor();
		assert.equal(await page.getByRole("heading", { name: "The settled record", exact: true }).count(), 0);
		await page.getByRole("button", { name: "Load full run record", exact: true }).click();
		await page.getByRole("heading", { name: "The settled record", exact: true }).waitFor();
		await check("trace-run");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `trace-run-${width}.png`), fullPage: true });
	});
	await step("fleet history", async () => {
		await navigate("Fleet");
		await page.locator("main").getByRole("heading", { name: "Fleet executions", exact: true }).waitFor();
		await page.getByText("not a live event stream", { exact: false }).waitFor();
		await check("fleet");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `fleet-${width}.png`), fullPage: true });
		await page.locator('main a[href^="/fleet/fleet-149"]').click();
		await page.getByText("Inspect worker output", { exact: true }).click();
		await page.getByText("Fixture step passed.", { exact: true }).waitFor();
		await page
			.locator("main")
			.getByRole("heading", { name: "review · pass", exact: true })
			.waitFor({ state: "attached" });
		await check("fleet-run");
		await dark(true);
		await check("fleet-run-dark");
	});
	await step("evidence and help", async () => {
		await page.goto(`${origin}/evidence`);
		await page.locator('main a[href^="/evidence/evidence-039"]').waitFor();
		await check("evidence");
		await page.locator('main a[href^="/evidence/evidence-039"]').click();
		await page.locator("main").getByRole("heading", { name: "Trust by run", exact: true }).waitFor();
		await check("evidence-detail-dark");
		await dark(false);
		await check("evidence-detail");
		// The inspectors live inside closed disclosures, so they are opened before they are judged.
		const openInspectors = async (name: string) => {
			await page.locator("main details").evaluateAll((nodes) => {
				for (const node of nodes) (node as HTMLDetailsElement).open = true;
			});
			await page.locator("main .facts").first().waitFor();
			const raw = await page
				.locator("main pre")
				.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "").filter((text) => /^\s*[{[]/.test(text)));
			assert.deepEqual(raw, [], `${name} still renders a raw JSON dump`);
			await check(`${name}-inspectors`);
			if (width === 1600 || width === 390)
				await page.screenshot({ path: join(output, `${name}-inspectors-${width}.png`), fullPage: true });
		};
		await openInspectors("evidence-detail");
		await page.keyboard.press("Control+/");
		await page.getByRole("heading", { name: "Shortcuts & help", exact: true }).waitFor();
		await page.getByRole("searchbox", { name: "Search shortcuts and help", exact: true }).waitFor();
		assert.equal(await page.getByRole("link", { name: "Open public documentation ↗", exact: true }).count(), 0);
		await page.getByRole("tab", { name: "Documentation", exact: true }).click();
		const publicHelp = page.getByRole("link", { name: "Open public documentation ↗", exact: true });
		assert.equal(await publicHelp.getAttribute("href"), "https://pancode.dev/docs.html");
		assert.equal(await publicHelp.getAttribute("referrerpolicy"), "no-referrer");
		await check("help");
		await page.keyboard.press("Escape");
		assert.equal(await page.getByRole("link", { name: "Docs", exact: true }).count(), 0);
	});
	await step("help page and rail", async () => {
		await page.goto(`${origin}/docs`);
		// Help's documentation link leaves the app.
		await page.locator("main").getByRole("heading", { name: "Make yourself at home.", exact: true }).waitFor();
		assert.equal(await page.locator(".docs-page, iframe").count(), 0);
		assert.equal(
			await page.getByRole("link", { name: "Browse documentation", exact: true }).getAttribute("href"),
			"https://pancode.dev/docs.html",
		);
		await check("help-landing");
		if (!phone) {
			// The rail folds away entirely and one visible control brings it back.
			await page.keyboard.press("Control+\\");
			await page.locator('.wb[data-sidebar="collapsed"]').waitFor();
			await page.locator(".wb-sidebar .wb-side").waitFor({ state: "hidden" });
			await check("help-rail-collapsed");
			if (width === 1600) await page.screenshot({ path: join(output, "navigation-collapsed-1600.png"), fullPage: true });
			await page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first().click();
			await page.locator('.wb[data-sidebar="expanded"]').waitFor();
			await page.locator(".wb-sidebar").getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
			assert.equal(
				await page.getByRole("navigation", { name: "Settings", exact: true }).getByRole("link").count(),
				SETTINGS_SECTIONS.length,
				"every settings place stays listed once the rail returns",
			);
		}
	});
}
