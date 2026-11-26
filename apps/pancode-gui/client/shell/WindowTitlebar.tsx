// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PancodeLogo, PancodeWordmark } from "./PancodeMark.js";

/** The installed PWA owns the title area; Windows keeps its real caption controls and resize edges. */
export function WindowTitlebar() {
	return (
		<div className="window-titlebar" aria-hidden="true">
			<PancodeLogo size={20} />
			<PancodeWordmark />
		</div>
	);
}
