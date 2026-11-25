// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { RefObject } from "react";
import { Icon } from "../design/icons.js";
import { Keycaps } from "../interaction/Keycaps.js";
import { OUTPUT_DETAILS, type OutputDetail } from "./output-detail-model.js";

/**
 * The + menu opens upward from its button. A composer that sits high, as it does when zoomed, leaves less room above
 * than the panel's cap, so the panel is held to that room and scrolls instead of running off the top of the window.
 */
function fitAbove(details: HTMLDetailsElement): void {
	const panel = details.querySelector<HTMLElement>(".composer__options-panel");
	if (!panel) return;
	// The panel rises from the composer box it is positioned against, not from its own button.
	const room = (panel.offsetParent ?? details).getBoundingClientRect().top - 16;
	panel.style.setProperty("--options-room", `${Math.max(96, Math.round(room))}px`);
}

/** The composer's + menu: interrupt the running turn, transcript detail, and whether Enter sends. */
export function ComposerOptions({
	options,
	onOpenChange,
	canInterrupt,
	interrupt,
	outputDetail,
	onOutputDetail,
	enterSends,
	onEnterSends,
}: {
	options: RefObject<HTMLDetailsElement | null>;
	onOpenChange: (open: boolean) => void;
	canInterrupt: boolean;
	interrupt: { readonly isPending: boolean; mutate(): void };
	outputDetail: OutputDetail;
	onOutputDetail: (next: OutputDetail) => void;
	enterSends: boolean;
	onEnterSends: (enterSends: boolean) => void;
}) {
	const closeOptions = () => {
		if (!options.current) return;
		options.current.open = false;
		options.current.querySelector("summary")?.focus();
	};

	return (
		<details
			className="composer__options"
			ref={options}
			onToggle={(event) => {
				onOpenChange(event.currentTarget.open);
				if (event.currentTarget.open) fitAbove(event.currentTarget);
			}}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				closeOptions();
			}}
		>
			<summary aria-label="Message options" title="Message and keyboard options">
				<Icon name="more" />
			</summary>
			<div className="composer__options-panel">
				{canInterrupt ? (
					<button
						type="button"
						className="composer__menu-item"
						disabled={interrupt.isPending}
						title="Ask Panos to put down what it is doing and take new direction. The turn stays open."
						onClick={() => {
							closeOptions();
							interrupt.mutate();
						}}
					>
						<Icon name="stop" />
						{interrupt.isPending ? "Interrupting…" : "Interrupt"}
					</button>
				) : null}
				<fieldset className="composer__detail">
					<legend>Transcript detail</legend>
					<div className="composer__detail-options">
						{OUTPUT_DETAILS.map((tier) => (
							<button
								key={tier.value}
								type="button"
								aria-pressed={outputDetail === tier.value}
								title={tier.summary}
								onClick={() => onOutputDetail(tier.value)}
							>
								{tier.label}
							</button>
						))}
					</div>
				</fieldset>
				<label className="composer__enter-mode">
					<input type="checkbox" checked={enterSends} onChange={(event) => onEnterSends(event.target.checked)} />
					Enter sends
				</label>
				<p className="composer__options-note">
					{enterSends ? (
						<>
							<Keycaps chord="Shift + Enter" /> adds a line.
						</>
					) : (
						<>
							<Keycaps chord="Enter" /> adds a line. <Keycaps chord="Ctrl/Cmd + Enter" /> sends.
						</>
					)}{" "}
					<Keycaps chord="@" /> adds a file or folder. <Keycaps chord="↑" /> recalls earlier messages and{" "}
					<Keycaps chord="Ctrl/Cmd + R" /> searches them.
				</p>
			</div>
		</details>
	);
}
