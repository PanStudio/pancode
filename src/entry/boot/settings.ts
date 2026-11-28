// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { type PancodeSettings, readSettings } from "../../core/config.js";
import type { OutputStyle } from "../../core/defaults.js";
import { type SessionOverrides, seedSessionRouting } from "../../core/session-routing.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import { takeContainedYoloNotice } from "../../domains/install/index.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { clampThinkingLevel, selectModel } from "../../session-control/index.js";
import type { BootOptions } from "../boot-options.js";
import { createSessionSettingsView } from "../session-settings-view.js";

/** What buildBootSettings reads from the names bootOrchestrator built before it. */
export interface BootSettingsInput {
	bus: TelemetryHub;
	clampThinkingLevel: typeof clampThinkingLevel;
	config: ConfigContract | undefined;
	initialNotices: string[];
	initialRoutingSettings: PancodeSettings;
	interactive: boolean;
	options: BootOptions;
	outputStyleListeners: Set<(style: OutputStyle) => void>;
	providers: ProvidersContract;
	selectModel: typeof selectModel;
	session: SessionContract | undefined;
	yoloRefusal: string | null;
}

/**
 * Stage P9: the seeded session routing, the startup autonomy and a held yolo, the startup overrides, and the session
 * settings view every later stage reads settings through.
 */
export function buildBootSettings(input: BootSettingsInput) {
	const {
		bus,
		clampThinkingLevel,
		config,
		initialNotices,
		initialRoutingSettings,
		interactive,
		options,
		outputStyleListeners,
		providers,
		selectModel,
		session,
		yoloRefusal,
	} = input;
	const sessionRouting = seedSessionRouting(initialRoutingSettings);
	// Non-routing settings a session changed "for this session only" via the
	// /settings overlay. Layered under the routing overlay in the effective
	// view, so the live session reflects them immediately while settings.yaml
	// (the global default for new sessions) stays untouched until the operator
	// chooses to save globally.
	// Overrides are keyed by settings path, the same ids the /settings overlay
	// commits (`setAtPath` walks the dotted path). The headless `--autonomy`
	// flag was keyed by the bare word, which wrote a top-level `autonomy` key
	// nothing reads, so `run --autonomy yolo` compiled and admitted at
	// whatever settings.yaml said.
	// The interactive `pancode --autonomy <level>` seeds the same override.
	// yolo is a grant from a present human to the main agent. A headless run has
	// no human to have granted it, so it runs at default unless its own command
	// line says --autonomy yolo; a settings.yaml yolo does not carry over (D1).
	const startupAutonomy = options.headless !== undefined ? (options.headless.autonomy ?? "default") : options.autonomy;
	if (
		options.headless !== undefined &&
		options.headless.autonomy === undefined &&
		(config?.get() ?? readSettings()).safety.autonomy === "yolo"
	) {
		process.stderr.write(
			"pancode run: autonomy default (settings.yaml sets yolo, which a headless run takes only from --autonomy yolo)\n",
		);
	}
	// An interactive session that would start at yolo holds at default when yolo
	// is refused here, and until the operator has accepted it once; the
	// acceptance card then asks (#407). Headless `--autonomy yolo` and an ACP
	// client's mode choice count as acceptance.
	const savedSafety = (config?.get() ?? readSettings()).safety;
	let bootAutonomy = startupAutonomy;
	let yoloHeldAtBoot = false;
	if (options.headless === undefined && (startupAutonomy ?? savedSafety.autonomy) === "yolo") {
		if (yoloRefusal !== null) {
			bootAutonomy = "default";
			if (interactive) initialNotices.push(`Autonomy is default. ${yoloRefusal}`);
			else process.stderr.write(`pancode: autonomy default. ${yoloRefusal}\n`);
		} else if (interactive && savedSafety.yoloAccepted !== true) {
			bootAutonomy = "default";
			yoloHeldAtBoot = true;
		}
	}
	// Yolo is contained (ob-yolo D1): the install domain says so once per home (interactive after accepting yolo,
	// headless on a yolo run), remembered in its own state and never in the operator's settings.
	const yoloNotice =
		yoloRefusal === null && (interactive ? savedSafety.yoloAccepted === true : startupAutonomy === "yolo")
			? takeContainedYoloNotice(savedSafety)
			: null;
	if (yoloNotice !== null) {
		if (interactive) initialNotices.push(yoloNotice);
		else process.stderr.write(`pancode: ${yoloNotice}\n`);
	}
	const startupOverrides: SessionOverrides = new Map(
		bootAutonomy === undefined ? [] : [["safety.autonomy", bootAutonomy]],
	);
	if (options.demo !== undefined) startupOverrides.set("interface.demo", options.demo);
	const {
		getCurrentSettings,
		bump: bumpSessionState,
		persistCurrentThinkingLevel,
		routeProvenance,
		settingOrigin,
		persistSavedMutation,
		selectAtScope,
		clampAtScope,
		readAcpSafeSettings,
		commitAcpSafeSettings,
		applySettingsBlob,
		commitSetting,
		routingGestures,
		restoreResumedRoute,
		createRoutedSession,
		start: startSessionSettings,
	} = createSessionSettingsView({
		config,
		providers,
		session,
		bus,
		startupOverrides,
		sessionRouting,
		outputStyleListeners,
		selectModel,
		clampThinkingLevel,
	});
	return {
		applySettingsBlob,
		bumpSessionState,
		clampAtScope,
		commitAcpSafeSettings,
		commitSetting,
		createRoutedSession,
		getCurrentSettings,
		persistCurrentThinkingLevel,
		persistSavedMutation,
		readAcpSafeSettings,
		restoreResumedRoute,
		routeProvenance,
		routingGestures,
		selectAtScope,
		settingOrigin,
		startSessionSettings,
		startupOverrides,
		settingsState: {
			get yoloHeldAtBoot() {
				return yoloHeldAtBoot;
			},
		},
	};
}
