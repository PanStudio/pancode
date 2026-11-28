// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { Client } from "../api/client.js";
import { useShell } from "../shell/shell-context.js";
import { settingsWorkspace } from "./config-map-model.js";
import "./workspace-selection.css";
import { workspacesQuery } from "../api/queries.js";

export function useWorkspaceSelection(client: Client) {
	const [search, setSearch] = useSearchParams();
	const workspaces = useQuery({
		...workspacesQuery(client),
	});
	const shell = useShell();
	const requested = search.get("workspace");
	const id = settingsWorkspace(requested, shell?.activeWorkspaceId, workspaces.data ?? []);
	return {
		workspaces,
		id,
		missing: !!requested && !!workspaces.data && !id,
		select: (workspace: string) =>
			setSearch((current) => {
				const next = new URLSearchParams(current);
				next.set("workspace", workspace);
				return next;
			}),
	};
}

export function WorkspacePicker({
	selection,
	purpose = "inspection",
}: {
	selection: ReturnType<typeof useWorkspaceSelection>;
	/**
	 * `installation` pages read installation-wide without a project; one only adds its resources. `records` pages
	 * fold every project's records without one, and narrow to the chosen project.
	 */
	purpose?: "settings" | "inspection" | "installation" | "records";
}) {
	const { workspaces, id, select } = selection;
	const shell = useShell();
	if (workspaces.error)
		return (
			<div role="alert">
				<p>Projects could not be read: {workspaces.error.message}</p>
				<button type="button" disabled={workspaces.isFetching} onClick={() => void workspaces.refetch()}>
					Retry projects
				</button>
			</div>
		);
	if (workspaces.isPending) return <p role="status">Reading projects…</p>;
	if (!workspaces.data.length)
		return (
			<p>
				{purpose === "settings"
					? "These are your user settings. "
					: purpose === "installation"
						? "This is the installation-wide inventory. "
						: purpose === "records"
							? "These are the records of every project. "
							: null}
				{shell ? (
					<button type="button" className="wb-link" onClick={shell.openWorkspace}>
						Open a project
					</button>
				) : (
					<Link to="/">Open a project</Link>
				)}{" "}
				to{" "}
				{purpose === "settings"
					? "see the project settings that apply there too"
					: purpose === "installation"
						? "include that project's own resources"
						: purpose === "records"
							? "inspect one project's records"
							: "inspect its records"}
				.
			</p>
		);
	return (
		<label className="workspace-picker">
			<span className="workspace-picker__label">
				Project context
				<small>
					{purpose === "settings"
						? "Resolve values and overrides for this folder; saves go to your user settings"
						: purpose === "installation"
							? "Include this project's own resources"
							: "Choose the project to inspect"}
				</small>
			</span>
			<select value={id} onChange={(event) => select(event.target.value)}>
				{!id && (
					<option value="" disabled>
						Choose an open project
					</option>
				)}
				{workspaces.data.map((row) => (
					<option key={row.id} value={row.id}>
						{row.name} · {row.path}
					</option>
				))}
			</select>
			{selection.missing && (
				<small role="alert">The linked project is no longer open. Choose a project to continue.</small>
			)}
		</label>
	);
}
