// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { serve } from "@hono/node-server";
import { type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { harness } from "../tests/harness/app.js";
import { seedEvidence, seedFleet, seedHub, seedReports, seedSettings } from "../tests/harness/hub-fixture.js";
import { writeFixtureTelemetry } from "../tests/harness/telemetry-fixture.js";
import { traceFixture } from "../tests/harness/trace-fixture.js";
import { fixtureLaunch } from "./fixture-launch.js";
import { conversationSteps } from "./smoke/conversation.js";
import { fixedViewportSteps } from "./smoke/fixed-viewport.js";
import { homeSteps } from "./smoke/home.js";
import { recoverySteps } from "./smoke/recovery.js";
import type { SmokeRun } from "./smoke/run.js";
import { sessionActionSteps } from "./smoke/session-actions.js";
import { workspaceSteps } from "./smoke/workspace.js";

const { values } = parseArgs({
	options: {
		chrome: { type: "string", default: "/usr/bin/google-chrome" },
		// The desktop browser and installed app are the active product targets.
		widths: { type: "string", default: "1600,1050" },
		"zoom-only": { type: "boolean", default: false },
		// A private build, so a concurrent `vite build` into dist/client cannot pull pages out from under a run.
		client: { type: "string", default: fileURLToPath(new URL("../dist/client/", import.meta.url)) },
		// Keep durable review captures separate from temporary browser profiles and fixture homes.
		out: { type: "string" },
		// Record a failing flow and run the next one, then list every failure and exit 1.
		continue: { type: "boolean", default: false },
	},
});
const widths = values.widths.split(",").map(Number);
assert.ok(
	widths.length > 0 && widths.every((width) => [1600, 1440, 1050, 400, 390, 320].includes(width)),
	"widths: 1600, 1440, 1050, 400, 390, 320",
);
// Keep browser profiles and failure captures under the caller's private temp root too.
const scratch = process.env.TMPDIR
	? join(process.env.TMPDIR, "pancode-gui-validation")
	: fileURLToPath(new URL("../../../tmp/gui-validation/", import.meta.url));
await mkdir(scratch, { recursive: true });
process.env.TMPDIR ??= scratch;
const output = values.out ?? (await mkdtemp(join(scratch, "browser-")));
await mkdir(output, { recursive: true });
let origin = "http://127.0.0.1:0";
// The usage panel reads the session's telemetry through the child, so the child serves read-model DTOs.
const telemetryScratch = await mkdtemp(join(scratch, "telemetry-"));
const telemetryFile = join(telemetryScratch, "dtos.json");
await writeFixtureTelemetry(telemetryFile, join(telemetryScratch, "state"));
const h = await harness(
	{ installDelayMs: 150 },
	{
		pwa: true,
		scenario: "markdown",
		origin: () => origin,
		clientDir: values.client,
		// The real runtime always reports its safe settings and targets, so the smoke does too.
		env: { PANCODE_WEB_FIXTURE_ROUTE: "1", PANCODE_WEB_FIXTURE_TELEMETRY: telemetryFile },
	},
);
await seedSettings(h.home.path, h.home.env, "fixture");
await seedFleet(h.home.path, h.home.env);
await seedEvidence(h.home.path, h.home.env);
await seedReports(h.home.path, h.home.env);
await seedHub(h.home.path, h.home.env);
await traceFixture(join(h.home.path, "state"));
const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => server.on("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
origin = `http://127.0.0.1:${address.port}`;
/** What a launch link carries after `#`: a fresh single-use ticket, as pancode gui prints it. */
const launch = () => fixtureLaunch(origin);
const browser = await chromium
	.launch({
		executablePath: values.chrome,
		headless: true,
		args: ["--disable-dev-shm-usage"],
	})
	.catch(async (error: unknown) => {
		if ("closeAllConnections" in server) server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await h.close();
		throw error;
	});
const failures: string[] = [],
	errors: string[] = [],
	checks: {
		page: string;
		width: number;
		zoom: number;
		seriousOrCritical: number;
		minorOrModerate: string[];
		overflow: boolean;
	}[] = [];
// The last run uses Chrome's native 200% page zoom in a fresh profile. Its layout viewport
// is 800 CSS pixels inside a 1600px window; neither CSS zoom nor pinch scaling is applied.
const runs = [...(values["zoom-only"] ? [] : widths.map((width) => ({ width, zoom: 1 }))), { width: 800, zoom: 2 }];
const statuses: { method: string; path: string; status: number }[] = [];
// The stale-token step: the shell's first reads (meta, the rail's workspaces and session overview, setup status)
// start together and wait on one exchange of the launch token, which is refused once per width; the reads then
// fail in the browser without asking again. A refused stream must stop, not reconnect forever.
const firstReads = [
	"/api/auth/clients",
	"/api/meta",
	"/api/events",
	"/api/events/ticket",
	"/api/workspaces",
	"/api/sessions/overview",
	"/api/setup",
];
/** A refusal a step asks for on purpose. The report keeps these apart from the error responses. */
function expectedRefusal(item: { method: string; path: string; status: number }): boolean {
	return (
		// The two "does-not-exist" folder steps.
		(item.method === "POST" && item.path === "/api/workspaces" && item.status === 422) ||
		// The harness PanCode does not expose session history, so the read refuses. The same path also
		// creates a session, and a refused create must still fail the run.
		(item.method === "GET" && item.status === 409 && /^\/api\/workspaces\/[^/]+\/sessions$/.test(item.path)) ||
		// The harness wires no node management, so the Nodes page's list read refuses; the width step
		// still lays the page out.
		(item.method === "GET" && item.status === 409 && /^\/api\/workspaces\/[^/]+\/nodes$/.test(item.path)) ||
		(item.status === 401 && firstReads.includes(item.path))
	);
}
/** Set on responses a step fulfils itself; the error-response tally skips them. */
const stubHeader = "x-pancode-smoke-stub";
const zoomMeasurements: { outerWidth: number; innerWidth: number; devicePixelRatio: number; visualScale: number }[] =
	[];
let zoomContext: BrowserContext | null = null;
let zoomProfile: string | null = null;
let success = false;
let failedPage: { screenshot(options: { path: string; fullPage: boolean }): Promise<unknown> } | null = null;
/** With --continue, each failed flow: its name and width, then the first line of what went wrong. */
const defects: { flow: string; message: string }[] = [];
/**
 * Run one named flow. Without --continue a failure throws as before. With it the failure is recorded with
 * a capture, open popups are dismissed, and the caller runs the next flow, which may then fail on the
 * state this one left behind; the first entry for a width is the one to read.
 */
async function flow(name: string, where: string, body: () => Promise<void>, recover?: () => Promise<void>) {
	if (!values.continue) return body();
	try {
		await body();
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
		defects.push({ flow: `${name} (${where})`, message });
		const slug = `${where}-${name}`.replace(/[^\w-]+/g, "-");
		// A capture is a diagnosis aid; a page that is already gone has nothing to show.
		await failedPage?.screenshot({ path: join(output, `defect-${slug}.png`), fullPage: false }).catch(() => {});
		// Recovery is best effort: the next flow reports whatever state this one could not undo.
		await recover?.().catch(() => {});
	}
}
/**
 * Read until the value matches or the time runs out, then assert on the last read. For state that a commit
 * lands a render or a transition later than the event the step waited on (router, an adopted URL write).
 */
async function eventually<T>(read: () => Promise<T>, expected: T, message: string, timeout = 5_000) {
	const deadline = Date.now() + timeout;
	let actual = await read();
	while (actual !== expected && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		actual = await read();
	}
	assert.equal(actual, expected, message);
}
try {
	for (const [runIndex, { width, zoom }] of runs.entries()) {
		let context: BrowserContext;
		if (zoom === 2) {
			zoomProfile = await mkdtemp(join(process.env.TMPDIR ?? scratch, "pancode-zoom-"));
			await mkdir(join(zoomProfile, "Default"));
			// Chromium's persisted default zoom is log-base-1.2 of the zoom factor. The default
			// storage partition's relative path is empty, represented by the preference key x.
			await writeFile(
				join(zoomProfile, "Default", "Preferences"),
				JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }),
			);
			zoomContext = await chromium.launchPersistentContext(zoomProfile, {
				executablePath: values.chrome,
				headless: true,
				viewport: null,
				colorScheme: "light",
				reducedMotion: "reduce",
				args: ["--disable-dev-shm-usage", "--window-size=1600,1050"],
			});
			context = zoomContext;
		} else {
			context = await browser.newContext({
				viewport: { width, height: 1050 },
				colorScheme: "light",
				reducedMotion: "reduce",
			});
		}
		// Turns on `client/render/render-probe.ts`, so the stream check below can count composer renders.
		await context.addInitScript("globalThis.__pancodeRenderCounts = {};");
		// A new install is dark; these flows choose System so the device preference drives the light and dark checks.
		await context.addInitScript(
			'try { if (localStorage.getItem("pancode-gui-theme") === null) localStorage.setItem("pancode-gui-theme", "system"); } catch {}',
		);
		await context.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (url.origin === origin) await route.continue();
			else {
				failures.push(`External request: ${url.origin}${url.pathname}`);
				await route.abort();
			}
		});
		const page = await context.newPage();
		failedPage = page;
		page.setDefaultTimeout(15000);
		let evidenceReads = 0;
		const apiWrites: string[] = [];
		page.on("request", (request) => {
			const path = new URL(request.url()).pathname;
			if (path === "/api/evidence" && request.method() === "GET") evidenceReads++;
			// Issuing and rotating this window's credential and stream tickets changes nothing it shows.
			const credentialPlumbing = path.startsWith("/api/auth/") || path === "/api/events/ticket";
			if (path.startsWith("/api/") && !credentialPlumbing && !["GET", "HEAD", "OPTIONS"].includes(request.method()))
				apiWrites.push(`${request.method()} ${path}`);
		});
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("requestfailed", (request) => {
			const path = new URL(request.url()).pathname;
			// Closing a tab intentionally closes its EventSource. An image the page
			// replaced before its bytes arrived is cancelled, not broken; a missing one is a 404 below. A
			// read the client cancels itself, because its view left or a newer read superseded it, is not
			// broken either.
			if (
				request.failure()?.errorText === "net::ERR_ABORTED" &&
				(path === "/api/events" ||
					request.resourceType() === "image" ||
					(request.resourceType() === "fetch" && request.method() === "GET" && path.startsWith("/api/")))
			)
				return;
			failures.push(
				`${path}: ${request.failure()?.errorText} (${request.resourceType()} on ${new URL(page.url()).pathname})`,
			);
		});
		page.on("response", (response) => {
			// A step's own stubbed failure is not a server answer the run must account for.
			if (response.status() >= 400 && response.headers()[stubHeader] === undefined)
				statuses.push({
					method: response.request().method(),
					path: new URL(response.url()).pathname,
					status: response.status(),
				});
		});
		async function check(name: string, checkedPage = page) {
			await checkedPage.evaluate(() => document.fonts.ready);
			// A theme change lands as an attribute first; let the cascade and a paint settle before axe reads colours.
			// Without an explicit choice no attribute is set and the system preference decides.
			await checkedPage.waitForFunction(
				() =>
					getComputedStyle(document.body).color ===
					((document.documentElement.dataset.theme ??
						(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"
						? "rgb(235, 239, 242)"
						: "rgb(21, 28, 31)"),
			);
			await checkedPage.evaluate(
				() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
			);
			const builder = new AxeBuilder({ page: checkedPage });
			const axe = await builder.analyze();
			assert.deepEqual(
				axe.violations.filter((item) => item.id === "aria-allowed-role"),
				[],
				`${name} has an invalid ARIA role at ${width}px`,
			);
			const serious = axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
			const overflow = await checkedPage.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			);
			checks.push({
				page: name,
				width,
				zoom,
				seriousOrCritical: serious.length,
				minorOrModerate: axe.violations
					.filter((item) => item.impact !== "serious" && item.impact !== "critical")
					.map((item) => item.id),
				overflow,
			});
			await writeFile(join(output, `${width}-${name}-axe.json`), JSON.stringify(axe.violations, null, 2));
			assert.deepEqual(
				serious.map((item) => ({
					id: item.id,
					nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
				})),
				[],
				`${name} at ${width}px`,
			);
			assert.equal(overflow, false, `${name} overflows at ${width}px`);
		}
		// The rail is a drawer on a phone (`client/app.tsx` PHONE) and a column beside the card otherwise.
		const phone = (zoom === 2 ? 800 : width) <= 760;
		async function revealSidebar() {
			if (await page.locator('.wb[data-drawer="open"]').count()) return;
			if (!phone && (await page.locator('.wb[data-sidebar="expanded"]').count())) return;
			await page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first().click();
			await page.locator(".wb-sidebar .wb-side").filter({ visible: true }).waitFor();
		}
		// Settings mode swaps the task rail for its own list of places; the gear at the rail's foot enters it.
		async function navigate(label: string) {
			await revealSidebar();
			const places = page.getByRole("navigation", { name: "Settings", exact: true });
			if (!(await places.count())) {
				await page.locator(".wb-sidebar").getByRole("link", { name: "Settings", exact: true }).click();
				await places.waitFor();
				await revealSidebar();
			}
			await places.getByRole("link", { name: label, exact: true }).click();
			await places.locator('a[aria-current="page"]', { hasText: label }).waitFor({ state: "attached" });
		}
		async function leaveSettings() {
			await revealSidebar();
			await page.locator(".wb-sidebar").getByRole("link", { name: "Back to work", exact: true }).click();
			await page.getByRole("navigation", { name: "Settings", exact: true }).waitFor({ state: "detached" });
		}
		// Dark checks follow the device preference; the explicit choice is exercised on General below.
		async function dark(on: boolean) {
			await page.emulateMedia({ colorScheme: on ? "dark" : "light" });
		}
		const step = (name: string, body: () => Promise<void>) =>
			flow(name, zoom === 2 ? "800px at 200% zoom" : `${width}px`, body, async () => {
				for (const extra of context.pages()) if (extra !== page) await extra.close();
				failedPage = page;
				await page.keyboard.press("Escape");
				await page.keyboard.press("Escape");
			});
		// Flows share these locators and helpers; a locator resolves only when it is used.
		let noticeSessionUrl = "";
		let workspaceUrl = "";
		const openDialog = page.getByRole("dialog", { name: "Open workspace", exact: true });
		const setting = (path: string) =>
			page.locator("main .setting-control", { has: page.locator("code", { hasText: path }) });
		const findSetting = page.locator("main").getByLabel("Find a setting", { exact: true });
		const composerField = page.getByLabel("Message PanCode", { exact: true });
		const pane = page.locator(".pane:not([hidden])");
		// The pane docks open from 1440px; narrower it is a modal slide-over behind the top bar's toggle.
		async function openPane() {
			if (!(await pane.count())) await page.getByRole("button", { name: "Show task details", exact: true }).click();
			await pane.locator(".pane__body").waitFor();
			const back = pane.getByRole("button", { name: "Back to task details", exact: true });
			if (await back.count()) await back.click();
			await pane.locator(".pane__title", { hasText: "Task details" }).waitFor();
		}
		async function openDrill(name: string) {
			await openPane();
			// Model, context, usage and branches sit under More details, whose body renders once opened.
			const more = pane.locator("details.pane-more");
			if ((await more.count()) && !(await more.evaluate((node) => (node as HTMLDetailsElement).open)))
				await more.locator(":scope > summary").click();
			const disclosure = pane.locator(".pane-card--disclosure", {
				has: page.locator(".pane-card__label", { hasText: new RegExp(`^${name}$`) }),
			});
			if (await disclosure.count()) {
				if (!(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open)))
					await disclosure.locator(":scope > summary").click();
				await disclosure.getByRole("button", { name: `Open ${name.toLowerCase()}`, exact: true }).click();
			} else await pane.locator(".pane-card__open", { hasText: name }).click();
			await pane.getByRole("button", { name: "Back to task details", exact: true }).waitFor();
		}
		async function closePane() {
			if (!(await pane.count())) return;
			// Docked or as a slide-over, one control closes the task details.
			await pane.getByRole("button", { name: "Close session details", exact: true }).click();
			await pane.waitFor({ state: "detached" });
		}
		const taskMenu = page.locator('.conversation .wb-bar .wb-menu:has(> summary[aria-label="Session actions"])');
		const slashList = page.getByRole("listbox", { name: "Slash commands", exact: true });
		async function slashPane(name: string) {
			await composerField.fill(`/${name}`);
			// With the palette dismissed, Enter on a line that names a pane view opens it rather than sending.
			await page.keyboard.press("Escape");
			await composerField.press("Enter");
			await pane.getByRole("button", { name: "Back to task details", exact: true }).waitFor();
		}
		// The top bar's live chips open their drill-ins; where a phone's bar has no room for them, the same
		// views are one slash command away.
		async function chipOrSlash(chip: RegExp, view: "usage" | "context") {
			const button = page.locator(".conversation .wb-bar").getByRole("button", { name: chip });
			if (await button.isVisible()) {
				await button.click();
				await pane.getByRole("button", { name: "Back to task details", exact: true }).waitFor();
			} else await slashPane(view);
		}
		// A settled turn leaves no working chip in the top bar and no Stop in the composer.
		const settled = async () => {
			await page.locator('.wb-chip--status[data-tone="working"]').waitFor({ state: "detached" });
			await page.getByRole("button", { name: "Stop turn", exact: true }).waitFor({ state: "detached" });
		};
		// Session actions open from the slash palette as a dialog over the conversation. The option carries
		// the engine's title; the dialog opens under the app's own heading.
		async function slashAction(name: string, title: string, heading: string) {
			await composerField.fill(`/${name}`);
			await slashList
				.getByRole("option")
				.filter({ hasText: `${title}.` })
				.click();
			const dialog = page.getByRole("dialog", { name: heading, exact: true });
			await dialog.waitFor();
			assert.equal(await composerField.inputValue(), "", "picking a session action left its line in the composer");
			return dialog;
		}
		async function closeDialog(dialog: Locator) {
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "detached" });
			assert.equal(
				await composerField.evaluate((node) => node === document.activeElement),
				true,
				"closing a slash dialog did not return focus to the composer",
			);
		}
		const run: SmokeRun = {
			browser,
			h,
			origin,
			output,
			launch,
			errors,
			statuses,
			zoomMeasurements,
			stubHeader,
			eventually,
			runIndex,
			width,
			zoom,
			phone,
			context,
			page,
			apiWrites,
			get evidenceReads() {
				return evidenceReads;
			},
			set failedPage(next: Page) {
				failedPage = next;
			},
			get noticeSessionUrl() {
				return noticeSessionUrl;
			},
			set noticeSessionUrl(url: string) {
				noticeSessionUrl = url;
			},
			get workspaceUrl() {
				return workspaceUrl;
			},
			set workspaceUrl(url: string) {
				workspaceUrl = url;
			},
			check,
			step,
			revealSidebar,
			navigate,
			leaveSettings,
			dark,
			openDialog,
			setting,
			findSetting,
			composerField,
			pane,
			openPane,
			openDrill,
			closePane,
			taskMenu,
			slashList,
			slashPane,
			chipOrSlash,
			settled,
			slashAction,
			closeDialog,
		};
		await homeSteps(run);
		await workspaceSteps(run);
		await conversationSteps(run);
		await sessionActionSteps(run);
		await recoverySteps(run);
		await fixedViewportSteps(run);
		await context.close();
		if (zoom === 2) zoomContext = null;
	}
	await flow("page errors", "all widths", async () => assert.deepEqual(errors, []));
	await flow("request failures", "all widths", async () => assert.deepEqual(failures, []));
	await flow("error responses", "all widths", async () => {
		// Nothing is read again after the stale token's refusal.
		assert.ok(
			statuses.some((item) => item.path === "/api/auth/clients" && item.status === 401),
			"the stale launch token was never refused at the exchange",
		);
		for (const path of firstReads)
			assert.ok(
				statuses.filter((item) => item.path === path && item.status === 401).length <= runs.length,
				`${path} was refused more than once per width`,
			);
		assert.deepEqual(
			statuses.filter((item) => !expectedRefusal(item)),
			[],
		);
	});
	success = true;
} finally {
	// The last thing on screen is usually the whole diagnosis of a timed-out locator.
	if (!success) await failedPage?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {});
	const report = {
		output,
		success: success && defects.length === 0,
		defects,
		chrome: browser.version(),
		zoomMeasurements,
		checks,
		requestFailures: failures,
		scriptErrors: errors,
		errorResponses: statuses.filter((item) => !expectedRefusal(item)),
		expectedRefusals: statuses.filter(expectedRefusal),
	};
	await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
	await browser.close();
	await zoomContext?.close();
	if (zoomProfile) await rm(zoomProfile, { recursive: true, force: true });
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await h.close();
	await rm(telemetryScratch, { recursive: true, force: true });
	if (defects.length > 0) {
		console.log("KNOWN PRODUCT DEFECTS");
		for (const defect of defects) console.log(`${defect.flow}: ${defect.message}`);
		process.exitCode = 1;
	}
}
