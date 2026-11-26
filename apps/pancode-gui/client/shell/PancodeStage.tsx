// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useEffect, useRef, useState } from "react";
import { PancodeDisplayName, PancodeMarkArt } from "./PancodeMark.js";
import "./stage.css";

/** How long the finished stage keeps its "Ready" caption before it settles to the plain mark. */
const FINALE_HOLD = 4200;

/**
 * The app's opening stage: the canonical PanCode mark over the display name, with setup progress written under
 * them. The same element opens an ordinary new task, so finishing setup flows into the composer without a cut.
 *
 * `done` is the number of finished steps, or null while that is still unknown. "Ready" is shown only for a
 * completion seen while mounted, never for the state a page loads with.
 */
export function PancodeStage({ done, total }: { done: number | null; total: number }) {
	const known = done !== null;
	const complete = known && done >= total;
	const [finale, setFinale] = useState(false);
	const sawIncomplete = useRef(false);

	useEffect(() => {
		if (known && !complete) sawIncomplete.current = true;
		if (!complete || !sawIncomplete.current) return;
		sawIncomplete.current = false;
		setFinale(true);
		const timer = window.setTimeout(() => setFinale(false), FINALE_HOLD);
		return () => window.clearTimeout(timer);
	}, [known, complete]);

	const caption = finale ? "Ready" : known && !complete ? `Step ${done + 1} of ${total}` : "";
	return (
		<div className="pancode-stage" data-finale={finale || undefined}>
			<span className="pancode-stage__mark" aria-hidden="true">
				<PancodeMarkArt />
			</span>
			<PancodeDisplayName />
			<p className="pancode-stage__caption">{caption}</p>
		</div>
	);
}
