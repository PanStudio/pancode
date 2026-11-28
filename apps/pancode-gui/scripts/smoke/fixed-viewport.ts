// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import assert from "node:assert/strict";
import type { Route } from "playwright-core";
import { SETTINGS_SECTIONS } from "../../client/shell/shell-model.js";
import type { SmokeRun } from "./run.js";

/** Checks that run once at fixed viewports: polish geometry, keys landing where the chord sent them, and every page fitting each layout breakpoint. */
export async function fixedViewportSteps(run: SmokeRun) {
	const {
		closePane,
		composerField,
		eventually,
		launch,
		origin,
		page,
		revealSidebar,
		runIndex,
		settled,
		step,
		taskMenu,
		width,
		zoom,
	} = run;
	// Geometry from inspection round 1 (spec 16b) at fixed viewports, so it runs once, not per width.
	if (runIndex === 0 && zoom === 1)
		await step("polish geometry", async () => {
			const sizes = [
				{ width: 1440, height: 900 },
				{ width: 390, height: 844 },
			];
			await page.goto(`${origin}/#${await launch()}`);
			await page.getByRole("heading", { level: 1 }).waitFor();
			for (const size of sizes) {
				await page.setViewportSize(size);
				const at = `${size.width}x${size.height}`;
				// The hub: the tab row clears the heading, "Show" clears the search row, and a clamped description
				// carries its whole text.
				await page.goto(`${origin}/hub`);
				await page.locator("main .hub-packages > li").first().waitFor();
				const hubLayout = await page.evaluate(() => {
					// No named helper: tsx would wrap it in a `__name` call the page does not define.
					const [tabs, heading, search, show] = [
						".hub-page .settings-tabs",
						'.hub-page > [role="tabpanel"] > h2',
						'.hub-page > [role="tabpanel"] > .settings-filter',
						".hub-facets > legend",
					].map((selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null);
					const untitled = [...document.querySelectorAll<HTMLElement>(".hub-package__identity p")]
						.filter((node) => node.scrollHeight > node.clientHeight && !node.title.trim())
						.map((node) => node.textContent?.slice(0, 40) ?? "");
					return {
						tabsGap: tabs && heading ? heading.top - tabs.bottom : null,
						showGap: search && show ? show.top - search.bottom : null,
						untitled,
					};
				});
				assert.ok((hubLayout.tabsGap ?? -1) >= 16, `The hub tabs touch the heading at ${at}: ${hubLayout.tabsGap}`);
				assert.ok((hubLayout.showGap ?? -1) >= 12, `"Show" hugs the search row at ${at}: ${hubLayout.showGap}`);
				assert.deepEqual(hubLayout.untitled, [], `a clamped hub description has no title at ${at}`);
				// Home: the hero stays put while the starters leave and Task settings opens.
				await page.goto(`${origin}/`);
				const hero = page.locator(".newtask__title");
				await hero.waitFor();
				const heroTop = () => hero.evaluate((node) => node.getBoundingClientRect().top);
				const resting = await heroTop();
				await composerField.fill("x");
				await page.locator(".newtask__starters").waitFor({ state: "detached" });
				const typed = await heroTop();
				await page.locator(".newtask__context > summary").click();
				const settingsOpen = await heroTop();
				await composerField.fill("");
				for (const [state, top] of [
					["typing", typed],
					["Task settings", settingsOpen],
				] as const)
					assert.ok(Math.abs(top - resting) <= 1, `Home's hero moved ${top - resting}px on ${state} at ${at}`);
				// Evidence: run cards and the bundle heading tell runs by one agent apart; the eyebrow says it reads.
				await page.goto(`${origin}/evidence`);
				await page.locator("main .inspection-card-title a").first().waitFor();
				const titles = await page.locator("main .inspection-card-title").allInnerTexts();
				assert.equal(new Set(titles).size, titles.length, `two evidence cards share a title at ${at}`);
				assert.match(await page.locator("main .eyebrow").first().innerText(), /read and recheck$/iu);
				await page.locator("main .inspection-card-title a").first().click();
				await page.locator("main").getByRole("heading", { name: "Trust by run", exact: true }).waitFor();
				assert.match(await page.locator("main .panel-heading h1").innerText(), / · /u);
				assert.match(await page.locator("main .eyebrow").first().innerText(), /read and recheck$/iu);
				// Fleet: a run that has not ended promises its record instead of reporting it missing.
				await page.goto(`${origin}/fleet`);
				await page.locator("main #fleet-workers").waitFor();
				await page.locator("main .trace-panel .panel-marks").first().waitFor();
				const cards = await page.locator("main .trace-panel:has(.panel-marks)").evaluateAll((nodes) =>
					nodes.map((node) => ({
						status: node.querySelector(".panel-marks .status-mark")?.textContent?.trim() ?? "",
						text: (node as HTMLElement).innerText,
					})),
				);
				const running = cards.filter((card) => /running/iu.test(card.status));
				assert.ok(running.length > 0, `no running dispatch card to check at ${at}`);
				for (const card of running) {
					assert.match(card.text, /Record written when the run ends/u);
					assert.doesNotMatch(card.text, /no run record/iu);
				}
				assert.ok(
					cards.some((card) => !/running/iu.test(card.status) && !/Record written when the run ends/u.test(card.text)),
					`no settled dispatch card kept its integrity line at ${at}`,
				);
			}
			await page.setViewportSize({ width: 1440, height: 900 });
			// Sessions: the rail marks the Sessions page, not a task page, and opening a section does not move it.
			const sessionsLink = page.locator('.wb-sidebar a.wb-action[href="/sessions"]');
			await page.goto(`${origin}/`);
			await revealSidebar();
			const restingShadow = await sessionsLink.evaluate((node) => getComputedStyle(node).boxShadow);
			await sessionsLink.click();
			await page.waitForURL(`${origin}/sessions`);
			// The URL commits before the router re-renders the rail and the route's own styles apply.
			await eventually(
				() => sessionsLink.getAttribute("aria-current"),
				"page",
				"the rail does not mark Sessions current on /sessions",
			);
			assert.notEqual(await sessionsLink.evaluate((node) => getComputedStyle(node).boxShadow), restingShadow);
			const missionInner = page.locator("main .mission__inner");
			await missionInner.waitFor();
			await eventually(
				() => page.locator("main .mission").evaluate((node) => getComputedStyle(node).scrollbarGutter),
				"stable",
				"the Sessions page does not keep a stable scrollbar gutter",
			);
			const metrics = page.locator("main .operator-records > summary");
			if (await metrics.count()) {
				const box = () => missionInner.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
				const before = await box();
				await metrics.click();
				const after = await box();
				assert.ok(
					Math.abs(after.left - before.left) <= 0.5 && Math.abs(after.width - before.width) <= 0.5,
					`Sessions shifted when Recorded metrics opened: ${JSON.stringify({ before, after })}`,
				);
			}
			// Task header: a 40-character name is whole at 1440px, and narrower it gives way only to a full bar.
			await page.goto(run.workspaceUrl);
			// The harness PanCode never saves a task, so it cannot be renamed here: the name is the first request.
			const longTitle = "Renamed convergence check for the sensors";
			await page.locator("main button.primary", { hasText: "New session" }).click();
			await page.waitForURL(`${origin}/`);
			await composerField.fill(longTitle);
			await page.getByRole("button", { name: "Start session", exact: true }).click();
			await page.waitForURL(/\/sessions\/[^/]+$/);
			const sessionPath = new URL(page.url()).pathname;
			await page.locator(".chat-turn.is-settled").first().waitFor();
			await settled();
			// A docked task pane narrows the bar; the header is measured on its own.
			await closePane();
			assert.equal(await sessionsLink.getAttribute("aria-current"), null, "Sessions is marked current on a task page");
			await page.locator(".conversation .wb-bar__rename", { hasText: longTitle }).waitFor();
			const bar = () =>
				page.locator(".conversation .wb-bar").evaluate((node) => {
					const style = getComputedStyle(node);
					const inner = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
					const children = [...node.children].filter((child) => getComputedStyle(child).display !== "none");
					const used =
						children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
						parseFloat(style.columnGap || "0") * Math.max(0, children.length - 1);
					const title =
						node.querySelector<HTMLElement>(".wb-bar__rename") ?? node.querySelector<HTMLElement>(".wb-bar__title");
					const last = children.at(-1)?.getBoundingClientRect();
					const readings = node.querySelector(".wb-bar__readings");
					const shelf = readings?.getBoundingClientRect();
					return {
						whole: title !== null && title.scrollWidth <= title.clientWidth,
						unused: inner - used,
						// A reading that wraps onto the bar's hidden second line is not shown.
						readingsWhole:
							shelf === undefined ||
							[...(readings?.children ?? [])].every((child) => child.getBoundingClientRect().bottom <= shelf.bottom + 0.5),
						lastInside: last !== undefined && last.right <= node.getBoundingClientRect().right + 0.5,
					};
				});
			for (const size of [
				{ width: 1440, height: 900 },
				{ width: 1050, height: 900 },
				{ width: 768, height: 900 },
			]) {
				await page.setViewportSize(size);
				await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
				const measured = await bar();
				assert.ok(measured.lastInside, `the bar's last control left the bar at ${size.width}px`);
				// At 1440px the name gives way only to readings that all show whole and fill the bar.
				if (size.width === 1440)
					assert.ok(
						measured.whole || (measured.readingsWhole && measured.unused < 8),
						`the task's name is cut beside ${measured.unused}px of free bar at 1440px`,
					);
				else
					assert.ok(
						measured.whole || measured.unused < 8,
						`the task's name is cut beside ${measured.unused}px of free bar at ${size.width}px`,
					);
			}
			// Header menu: one line per item, the panel inside the window.
			for (const size of sizes) {
				await page.setViewportSize(size);
				await taskMenu.locator("summary").click();
				const menu = await taskMenu.locator(".wb-menu__panel").evaluate((panel) => {
					const heights = [...panel.querySelectorAll('[role="menuitem"]')].map(
						(item) => item.getBoundingClientRect().height,
					);
					return {
						spread: Math.max(...heights) - Math.min(...heights),
						right: panel.getBoundingClientRect().right,
						innerWidth,
					};
				});
				assert.ok(menu.spread <= 1, `a header menu item wraps at ${size.width}px: ${menu.spread}px taller`);
				assert.ok(menu.right <= menu.innerWidth, `the header menu leaves the window at ${size.width}px`);
				await page.keyboard.press("Escape");
			}
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${origin}${sessionPath}`);
			await composerField.waitFor();
			// Help: the Documentation view names itself once, in its tab.
			await page.keyboard.press("Control+/");
			const help = page.getByRole("dialog", { name: "Shortcuts & help", exact: true });
			await help.getByRole("tab", { name: "Documentation", exact: true }).click();
			await help.getByRole("link", { name: "Open public documentation ↗", exact: true }).waitFor();
			assert.equal(
				await help.evaluate(
					(node) =>
						[...node.querySelectorAll("*")].filter(
							(element) =>
								element.textContent?.trim() === "Documentation" &&
								![...element.children].some((child) => child.textContent?.trim() === "Documentation"),
						).length,
				),
				1,
				"Documentation is named more than once in its own view",
			);
			await page.keyboard.press("Escape");
			// Markdown: a pressed Wrap shows its state without weight, and a refused link reads as plain text.
			const wrap = page.locator(".chat-transcript .code-block__head button", { hasText: "Wrap" }).first();
			await wrap.scrollIntoViewIfNeeded();
			const wrapLook = async () => {
				await page.mouse.move(0, 0);
				return wrap.evaluate((node) => {
					const style = getComputedStyle(node);
					return { boxShadow: style.boxShadow, borderColor: style.borderColor };
				});
			};
			assert.equal(await wrap.getAttribute("aria-pressed"), "false");
			const unpressed = await wrapLook();
			await wrap.click();
			assert.equal(await wrap.getAttribute("aria-pressed"), "true");
			assert.notDeepEqual(await wrapLook(), unpressed, "a pressed Wrap looks like an unpressed one at rest");
			await wrap.click();
			const blocked = page.locator(".chat-transcript .md-link--blocked").first();
			await blocked.scrollIntoViewIfNeeded();
			const blockedLook = await blocked.evaluate((node) => {
				const style = getComputedStyle(node);
				return {
					border: style.borderBottomStyle,
					decoration: style.textDecorationLine,
					cursor: style.cursor,
					text: (node as HTMLElement).innerText,
				};
			});
			assert.deepEqual(
				{ border: blockedLook.border, decoration: blockedLook.decoration, cursor: blockedLook.cursor },
				{ border: "none", decoration: "none", cursor: "default" },
			);
			assert.match(blockedLook.text, /\(link blocked\)/u);
			await page.setViewportSize({ width, height: 1050 });
		});
	// Round 2 keys (R2-1, R2-11, R2-18): keys land where the chord sent them and focus comes back to where it
	// left. Once, at a fixed desktop size, so the rail is on screen.
	if (runIndex === 0 && zoom === 1)
		await step("keys land where the chord sent them", async () => {
			await page.setViewportSize({ width: 1440, height: 900 });
			const focused = () =>
				page.evaluate(() => {
					const active = document.activeElement;
					return active ? `${active.tagName.toLowerCase()}.${active.className}|${active.textContent?.trim() ?? ""}` : "";
				});
			const composerFocused = () => composerField.evaluate((node) => node === document.activeElement);
			// A slow first load: the palette and Help chunks are held until the step lets them through.
			const holds = new Map<string, () => void>();
			const hold = (name: string) => {
				const gate = new Promise<void>((resolve) => holds.set(name, resolve));
				return async (route: Route) => {
					await gate;
					await route.continue().catch(() => {});
				};
			};
			const paletteChunk = /\/assets\/CommandPalette-[^/]*\.js$/u;
			const helpChunk = /\/assets\/HelpDialog-[^/]*\.js$/u;
			await page.route(paletteChunk, hold("palette"));
			await page.route(helpChunk, hold("help"));
			try {
				// "polish geometry" reopened this window from a launch link, so it is a new client, and the one it
				// replaced still holds the task and counts as present for a while. Wait for the control read and take
				// control when it says this window only views the task; the fill below needs an enabled message box.
				const controlRead = page.waitForResponse(
					(response) =>
						response.request().method() === "GET" &&
						/^\/api\/sessions\/[^/]+\/control$/u.test(new URL(response.url()).pathname),
				);
				await page.goto(run.noticeSessionUrl);
				await composerField.waitFor();
				const control = (await (await controlRead).json()) as {
					controller: { clientId: string } | null;
					you: { clientId: string };
				};
				if (control.controller && control.controller.clientId !== control.you.clientId) {
					const note = page.locator(".composer__delivery-note");
					await note.getByRole("button", { name: "Take control", exact: true }).click();
					await note.locator("strong", { hasText: /^Viewing$/u }).waitFor({ state: "detached" });
				}
				await composerField.fill("");
				await composerField.focus();
				for (const [chord, name, chunk, combobox] of [
					["Control+K", "Run a command", "palette", "combobox"],
					["Control+/", "Search shortcuts and help", "help", "searchbox"],
				] as const) {
					await page.keyboard.press(chord);
					await page.keyboard.type("zz");
					await page.keyboard.press("Enter");
					const dialog = page.getByRole("dialog");
					assert.equal(
						await dialog.getByLabel(name, { exact: true }).inputValue(),
						"zz",
						`${chord}: keys lost while loading`,
					);
					assert.equal(await composerField.inputValue(), "", `${chord}: the typed keys reached the message box`);
					holds.get(chunk)?.();
					// The body swaps in with the typed text and keeps focus in its field.
					const field = dialog.getByRole(combobox, { name, exact: true });
					await field.waitFor();
					assert.equal(await field.inputValue(), "zz", `${chord}: the loaded body dropped the typed text`);
					assert.equal(
						await field.evaluate((node) => node === document.activeElement),
						true,
						`${chord}: focus left the field`,
					);
					await page.keyboard.press("Escape");
					await dialog.waitFor({ state: "detached" });
					await eventually(composerFocused, true, `${chord}: Esc did not return focus to the message box`);
				}
			} finally {
				for (const release of holds.values()) release();
				await page.unroute(paletteChunk);
				await page.unroute(helpChunk);
			}
			// Help's topics are tabs: one tab stop, and the arrow keys move and select.
			await page.keyboard.press("Control+/");
			const help = page.getByRole("dialog", { name: "Shortcuts & help", exact: true });
			const guide = help.getByRole("tab", { name: "Using PanCode", exact: true });
			await guide.focus();
			await page.keyboard.press("ArrowRight");
			const shortcuts = help.getByRole("tab", { name: "Shortcuts", exact: true });
			assert.equal(await shortcuts.getAttribute("aria-selected"), "true", "ArrowRight did not select the next topic");
			assert.equal(await shortcuts.evaluate((node) => node === document.activeElement), true);
			await page.keyboard.press("End");
			assert.equal(
				await help.getByRole("tab", { name: "Documentation", exact: true }).getAttribute("aria-selected"),
				"true",
			);
			await page.keyboard.press("Escape");
			await help.waitFor({ state: "detached" });
			// Esc from the palette opened by the rail's Search returns to Search.
			const search = page.getByRole("button", { name: "Search", exact: true });
			await search.click();
			await page.getByRole("combobox", { name: "Run a command", exact: true }).waitFor();
			await page.keyboard.press("Escape");
			await eventually(focused, "button.wb-action|Search", "Esc from the palette did not return to Search");
			// Up and Down, j and k move between the rail's task rows.
			const rows = page.locator("section.wb-side__tasks").locator("a.wb-task__main, button.wb-task__main:not([disabled])");
			assert.ok((await rows.count()) >= 2, "the rail lists fewer than two tasks to move between");
			await rows.nth(0).focus();
			await page.keyboard.press("ArrowDown");
			assert.equal(
				await rows.nth(1).evaluate((node) => node === document.activeElement),
				true,
				"ArrowDown did not move rows",
			);
			await page.keyboard.press("k");
			assert.equal(await rows.nth(0).evaluate((node) => node === document.activeElement), true, "k did not move rows");
			await page.keyboard.press("j");
			assert.equal(await rows.nth(1).evaluate((node) => node === document.activeElement), true, "j did not move rows");
			// Enter in the header rename returns focus to the title button rather than the page.
			await page.goto(run.noticeSessionUrl);
			const rename = page.locator(".wb-bar__rename");
			await rename.click();
			await page.getByRole("textbox", { name: "Task name", exact: true }).waitFor();
			await page.keyboard.press("Enter");
			await eventually(
				() => rename.evaluate((node) => node === document.activeElement).catch(() => false),
				true,
				"Enter in the header rename left focus on the page",
			);
			// New task, by chord and by the rail's button, lands in the Home message box.
			await page.goto(`${origin}/sessions`);
			await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor();
			await page.keyboard.press("Control+Shift+O");
			await page.waitForURL(/\/(sessions\/[^/]+)?$/u);
			await eventually(composerFocused, true, "Ctrl+Shift+O did not focus the message box");
			await page.goto(`${origin}/sessions`);
			await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor();
			await page.locator("nav.wb-side__actions").getByRole("button", { name: "New session", exact: true }).click();
			await eventually(composerFocused, true, "the rail's New task did not focus the message box");
			await page.setViewportSize({ width, height: 1050 });
		});
	// The layout breakpoints and one pixel either side: phone 390, the 600 drawer bar, the 760 phone rail, a
	// 768 tablet and the 1050 compact desktop. Every page fits its width: the document never scrolls sideways
	// and no visible element reaches past the viewport outside a scroller of its own.
	if (runIndex === 0 && zoom === 1)
		await step("widths fit at every breakpoint", async () => {
			const places = [
				`${origin}/`,
				`${origin}/sessions`,
				run.noticeSessionUrl,
				run.workspaceUrl,
				...SETTINGS_SECTIONS.map((section) => `${origin}${section.path}`),
			].filter((place) => place !== "");
			const misfits: string[] = [];
			for (const breakpoint of [390, 599, 601, 759, 761, 768, 1049, 1051]) {
				await page.setViewportSize({ width: breakpoint, height: 900 });
				for (const place of places) {
					await page.goto(place);
					await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor();
					await page.evaluate(() => document.fonts.ready);
					await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
					const found = await page.evaluate(() => {
						const viewport = document.documentElement.clientWidth;
						const out: string[] = [];
						if (document.documentElement.scrollWidth > viewport)
							out.push(`document ${document.documentElement.scrollWidth}px wide`);
						for (const node of document.body.querySelectorAll("*")) {
							const rect = node.getBoundingClientRect();
							if (rect.width === 0 || rect.height === 0 || (rect.right <= viewport + 1 && rect.left >= -1)) continue;
							// A closed disclosure's content still has a layout box; checkVisibility knows it is skipped.
							if (
								!node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true }) ||
								node.closest("[inert], .sr-only")
							)
								continue;
							const style = getComputedStyle(node);
							if (style.position === "fixed" && (rect.right <= 0 || rect.left >= viewport)) continue;
							// Inside a scroller of its own the overflow is reachable, and inside a clip-path (the visually
							// hidden pattern) nothing shows. No named helper here: tsx would wrap it in a __name call the
							// page does not define.
							let excused = false;
							for (let at = node.parentElement; at && !excused; at = at.parentElement) {
								const { overflowX, clipPath } = getComputedStyle(at);
								excused =
									clipPath !== "none" || ((overflowX === "auto" || overflowX === "scroll") && at.scrollWidth > at.clientWidth);
							}
							if (excused) continue;
							const name = `${node.tagName.toLowerCase()}${node.className && typeof node.className === "string" ? `.${node.className.trim().split(/\s+/u).join(".")}` : ""}`;
							out.push(`${name} spans ${Math.round(rect.left)}..${Math.round(rect.right)}`);
						}
						return out.slice(0, 6);
					});
					for (const item of found) misfits.push(`${breakpoint}px ${new URL(page.url()).pathname}: ${item}`);
				}
			}
			await page.setViewportSize({ width, height: 1050 });
			// One line, so --continue reports every misfit.
			assert.deepEqual(misfits, [], `pages overflow their width: ${misfits.join("; ")}`);
		});
}
