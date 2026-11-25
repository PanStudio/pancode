// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { Empty, Id } from "./common.js";
import {
	MemoryDecideRequest,
	MemoryId,
	MemoryPending,
	TrustApproveRequest,
	TrustPreview,
	TrustSurface,
} from "./review.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";
import { FileCompletion, FilePreview, PathCompletion, Workspace, WorkspacePick } from "./sessions.js";

const trustParams = Type.Object({ id: Id, surface: TrustSurface }, { additionalProperties: false });
/** Workspaces and their files. */
export const workspaceRoutes = {
	workspaces: defineRoute({
		...get,
		response: Type.Array(Workspace),
		summary: "Recent workspaces",
		...runtimeRoutes.workspaces,
	}),
	workspacePathComplete: defineRoute({
		...get,
		query: Type.Object(
			{
				input: Type.String({ maxLength: 4096 }),
				hidden: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		response: PathCompletion,
		summary: "Complete a typed directory path on this machine",
		...runtimeRoutes.workspacePathComplete,
	}),
	workspacePick: defineRoute({
		...post,
		status: 200,
		params: Empty,
		response: WorkspacePick,
		summary: "Ask the operating system's folder dialog for a workspace directory",
		...runtimeRoutes.workspacePick,
	}),
	openWorkspace: defineRoute({
		...post,
		status: 200,
		params: Empty,
		body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
		response: Workspace,
		summary: "Open an existing workspace by absolute path",
		...runtimeRoutes.openWorkspace,
	}),
	workspace: defineRoute({
		...get,
		params: operationParams,
		response: Workspace,
		summary: "Canonical workspace",
		...runtimeRoutes.workspace,
	}),
	workspaceFiles: defineRoute({
		...get,
		params: operationParams,
		query: Type.Object({ input: Type.String({ maxLength: 4096 }) }, { additionalProperties: false }),
		response: FileCompletion,
		summary: "Complete a typed @path against the files of one workspace",
		...runtimeRoutes.workspaceFiles,
	}),
	workspaceFile: defineRoute({
		...get,
		params: operationParams,
		query: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
		response: FilePreview,
		summary: "Read one workspace file for preview, never a secret file or one outside the workspace",
		...runtimeRoutes.workspaceFile,
	}),
};

/** Workspace trust and the memory lessons waiting for review. */
export const workspaceTrustRoutes = {
	// x090 spec 12
	trustPreview: defineRoute({
		...get,
		params: trustParams,
		response: TrustPreview,
		summary: "Every file, script and package a project trust surface holds, with the digest an approval names",
		...runtimeRoutes.trustPreview,
	}),
	trustApprove: defineRoute({
		...post,
		status: 200,
		params: trustParams,
		body: TrustApproveRequest,
		response: Empty,
		summary: "Trust a project surface at the digest of the preview the operator reviewed",
		...runtimeRoutes.trustApprove,
	}),
	memoryPending: defineRoute({
		...get,
		params: operationParams,
		response: MemoryPending,
		summary: "Memory lessons waiting for review, newest first",
		...runtimeRoutes.memoryPending,
	}),
	memoryDecide: defineRoute({
		...post,
		status: 200,
		params: Type.Object({ id: Id, memoryId: MemoryId }, { additionalProperties: false }),
		body: MemoryDecideRequest,
		response: Empty,
		summary: "Approve or reject one memory lesson waiting for review",
		...runtimeRoutes.memoryDecide,
	}),
};
