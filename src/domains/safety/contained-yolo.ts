// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readSettings } from "../../core/config.js";
import { autonomyCeilingRefusal, yoloRootRefusal } from "../../core/yolo-host.js";
import { effectiveYoloConfinement } from "../../lib/autonomy/autonomy.js";

/**
 * Why `research`, `campaign` or an extension's run service cannot hand its agent runs yolo here, or null
 * when they can. Each runs every agent as a headless `pancode run --autonomy yolo`, which takes its confinement from
 * the operator's user settings; these surfaces promise contained yolo (sandbox, safety judge, autonomous caps, open
 * decisions), so an operator whose settings choose unconfined yolo is refused rather than handed it. Root outside a
 * container is refused as `run` does.
 */
export function containedYoloRefusal(surface: string): string | null {
	const root = yoloRootRefusal();
	if (root !== null) return root;
	const ceiling = autonomyCeilingRefusal();
	if (ceiling !== null) return ceiling;
	if (effectiveYoloConfinement(readSettings().safety) === "unconfined")
		return `${surface} runs yolo contained only, and your user settings choose unconfined yolo (safety.yoloConfinement); set it back to contained to use --autonomy yolo here`;
	return null;
}
