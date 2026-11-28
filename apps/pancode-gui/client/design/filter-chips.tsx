// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The filter row and the empty view shared by the task and session inventories.
import type { ReactNode } from "react";
import { PancodeEmptyMark } from "../shell/PancodeMark.js";
import { Icon } from "./icons.js";

/** One pressed button per filter with its count, "—" while unknown. Choosing "all" selects "". */
export function FilterChips<T extends string>({
	className,
	label,
	filters,
	names,
	value,
	count,
	onSelect,
}: {
	className: string;
	label: string;
	filters: readonly T[];
	names: Readonly<Record<T, string>>;
	value: T;
	count: (filter: T) => number | null;
	onSelect: (filter: string) => void;
}) {
	return (
		<nav className={className} aria-label={label}>
			{filters.map((filter) => (
				<button
					type="button"
					key={filter}
					aria-pressed={value === filter}
					onClick={() => onSelect(filter === "all" ? "" : filter)}
				>
					{names[filter]}
					<span>{count(filter) ?? "—"}</span>
				</button>
			))}
		</nav>
	);
}

/** An inventory with nothing to show: clear the filters that hid everything, or start the first task. */
export function InventoryEmpty({
	className,
	heading: Heading,
	title,
	children,
	filtered,
	onClear,
	onStart,
	startDisabled,
}: {
	className: string;
	heading: "h2" | "h3";
	title: ReactNode;
	children: ReactNode;
	filtered: boolean;
	onClear: () => void;
	onStart: () => void;
	startDisabled?: boolean;
}) {
	return (
		<div className={className}>
			<PancodeEmptyMark />
			<Heading>{title}</Heading>
			<p>{children}</p>
			{filtered ? (
				<button type="button" onClick={onClear}>
					Clear filters
				</button>
			) : (
				<button type="button" className="primary" disabled={startDisabled} onClick={onStart}>
					Start a task
					<Icon name="plus" />
				</button>
			)}
		</div>
	);
}
