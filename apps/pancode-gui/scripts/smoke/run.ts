// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import type { harness } from "../../tests/harness/app.js";
import type { fixtureLaunch } from "../fixture-launch.js";

/** What every surface's steps share: the smoke's server and records, and one width's page with its helpers. */
export interface SmokeRun {
	readonly browser: Browser;
	readonly h: Awaited<ReturnType<typeof harness>>;
	readonly origin: string;
	readonly output: string;
	readonly launch: () => ReturnType<typeof fixtureLaunch>;
	readonly errors: string[];
	readonly statuses: { method: string; path: string; status: number }[];
	readonly zoomMeasurements: { outerWidth: number; innerWidth: number; devicePixelRatio: number; visualScale: number }[];
	readonly stubHeader: string;
	readonly eventually: <T>(read: () => Promise<T>, expected: T, message: string, timeout?: number) => Promise<void>;
	readonly runIndex: number;
	readonly width: number;
	readonly zoom: number;
	readonly phone: boolean;
	readonly context: BrowserContext;
	readonly page: Page;
	readonly apiWrites: string[];
	readonly evidenceReads: number;
	set failedPage(page: Page);
	noticeSessionUrl: string;
	workspaceUrl: string;
	readonly check: (name: string, checkedPage?: Page) => Promise<void>;
	readonly step: (name: string, body: () => Promise<void>) => Promise<void>;
	readonly revealSidebar: () => Promise<void>;
	readonly navigate: (label: string) => Promise<void>;
	readonly leaveSettings: () => Promise<void>;
	readonly dark: (on: boolean) => Promise<void>;
	readonly openDialog: Locator;
	readonly setting: (path: string) => Locator;
	readonly findSetting: Locator;
	readonly composerField: Locator;
	readonly pane: Locator;
	readonly openPane: () => Promise<void>;
	readonly openDrill: (name: string) => Promise<void>;
	readonly closePane: () => Promise<void>;
	readonly taskMenu: Locator;
	readonly slashList: Locator;
	readonly slashPane: (name: string) => Promise<void>;
	readonly chipOrSlash: (chip: RegExp, view: "usage" | "context") => Promise<void>;
	readonly settled: () => Promise<void>;
	readonly slashAction: (name: string, title: string, heading: string) => Promise<Locator>;
	readonly closeDialog: (dialog: Locator) => Promise<void>;
}
