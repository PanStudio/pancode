// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PancodeDisplayName, PancodeMarkArt, PancodePulse, PancodeWordmark, PULSE_SIZE } from "../shell/PancodeMark.js";
import type { SceneId } from "./wizard-model.js";

/**
 * The left half of the wizard: the static canonical PanCode mark over the wordmark, and one line under them. Each step keeps its
 * scene id so approved scene art can return per step; until then every scene shows the mark. While the child
 * is working, the live dot and a word say so. The first step is the app's opening: the mark over the display name on
 * the page's ground, with the glow.
 */
export function Stage({
	scene,
	opening,
	caption,
	working,
}: {
	scene: SceneId;
	/** The wizard's first step, before any setup question. */
	opening: boolean;
	caption: string;
	/** What PanCode, a worker or the setup child is doing right now, or null when nothing is. */
	working: string | null;
}) {
	return (
		<div className="wizard-stage" data-scene={scene} data-opening={opening || undefined}>
			<div className="wizard-stage__frame">
				<span className="wizard-stage__mark" aria-hidden="true">
					<PancodeMarkArt />
				</span>
				{opening ? (
					<PancodeDisplayName />
				) : (
					<span className="wizard-stage__wordmark" aria-hidden="true">
						<PancodeWordmark />
					</span>
				)}
			</div>
			<div className="wizard-stage__text">
				{working !== null ? (
					<p className="wizard-stage__working" role="status">
						<PancodePulse size={PULSE_SIZE.stage} />
						<span>{working}</span>
					</p>
				) : (
					<p className="wizard-stage__caption">{caption}</p>
				)}
			</div>
		</div>
	);
}
