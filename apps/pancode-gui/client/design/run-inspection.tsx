// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ReactNode } from "react";
import { useId } from "react";
import { inspectionTabIndex } from "./run-inspection-model.js";

export function InspectionSummary({ figures }: { figures: readonly { label: string; value: string | number }[] }) {
	return (
		<dl className="inspection-summary">
			{figures.map((figure) => (
				<div key={figure.label}>
					<dt>{figure.label}</dt>
					<dd>{figure.value}</dd>
				</div>
			))}
		</dl>
	);
}

export function InspectionError({
	title,
	error,
	retry,
	busy = false,
}: {
	title: string;
	error: Error;
	retry: () => void;
	busy?: boolean;
}) {
	return (
		<div className="inspection-error" role="alert">
			<div>
				<strong>{title}</strong>
				<p>{error.message}</p>
			</div>
			<button type="button" disabled={busy} onClick={retry}>
				{busy ? "Retrying…" : "Try again"}
			</button>
		</div>
	);
}

/** An inline alert that ends in a retry button: `{children} <button>Try again</button>`. */
export function RetryAlert({
	children,
	retry,
	busy,
	label = "Try again",
	className,
	buttonClassName,
}: {
	children: ReactNode;
	retry: () => void;
	busy?: boolean;
	label?: string;
	className?: string;
	buttonClassName?: string;
}) {
	return (
		<p role="alert" className={className}>
			{children}{" "}
			<button type="button" className={buttonClassName} disabled={busy} onClick={retry}>
				{label}
			</button>
		</p>
	);
}

/** The next page of an infinite list, offered while one remains and the last refresh did not fail. */
export function LoadOlder({
	pages,
	label,
	loading = label,
}: {
	pages: {
		hasNextPage: boolean;
		isRefetchError: boolean;
		isFetching: boolean;
		isFetchingNextPage: boolean;
		fetchNextPage: () => Promise<unknown>;
	};
	label: string;
	loading?: string;
}) {
	if (!pages.hasNextPage || pages.isRefetchError) return null;
	return (
		<button type="button" disabled={pages.isFetching} onClick={() => void pages.fetchNextPage()}>
			{pages.isFetchingNextPage ? loading : label}
		</button>
	);
}

export function InspectionTabs<T extends string>({
	tabs,
	value,
	onChange,
	label,
	children,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
	label: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<>
			<div
				className="inspection-tabs"
				role="tablist"
				aria-label={label}
				onKeyDown={(event) => {
					const current = tabs.findIndex((tab) => tab.id === value);
					const index = inspectionTabIndex(event.key, current, tabs.length);
					const next = tabs[index];
					if (!next) return;
					event.preventDefault();
					onChange(next.id);
					document.getElementById(`${id}-${next.id}`)?.focus();
				}}
			>
				{tabs.map((tab) => (
					<button
						type="button"
						role="tab"
						key={tab.id}
						id={`${id}-${tab.id}`}
						aria-selected={tab.id === value}
						aria-controls={`${id}-panel`}
						tabIndex={tab.id === value ? 0 : -1}
						onClick={() => onChange(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: A tab panel is keyboard focusable so its content follows the active tab. */}
			<div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>
				{children}
			</div>
		</>
	);
}
