// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { ClientBootstrap, ClientCredential, EventTicket, LaunchChallenge } from "./auth.js";
import { Empty, Id } from "./common.js";
import { EventCursor } from "./events.js";
import { Meta } from "./meta.js";
import { Accepted, Operation } from "./operations.js";
import { Install, Programs } from "./programs.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";

const toolParams = Type.Object({ programId: Id }, { additionalProperties: false });
/** The server itself: versions, the OpenAPI document, authentication, the event stream, pinned programs and operations. */
export const serverRoutes = {
	meta: defineRoute({ ...get, response: Meta, summary: "Application and PanCode versions", ...runtimeRoutes.meta }),
	openapi: defineRoute({
		...get,
		response: Type.Record(Type.String(), Type.Unknown()),
		summary: "OpenAPI contract",
		...runtimeRoutes.openapi,
	}),
	authChallenge: defineRoute({
		...post,
		status: 200,
		params: Empty,
		response: LaunchChallenge,
		summary:
			"A single-use, short-lived challenge a launcher proves the launch token over at POST /api/auth/clients; needs no credential",
		...runtimeRoutes.authChallenge,
	}),
	authClients: defineRoute({
		...post,
		status: 200,
		params: Empty,
		body: ClientBootstrap,
		response: ClientCredential,
		summary:
			"Open this client's own short-lived credential from a launcher's proof of the launch token over a challenge, a launch ticket, or a live credential; the launch token opens nothing else",
		...runtimeRoutes.authClients,
	}),
	authRotate: defineRoute({
		...post,
		status: 200,
		params: Empty,
		response: ClientCredential,
		summary: "Replace this client's credential before it expires; the old one is honoured for a short grace",
		...runtimeRoutes.authRotate,
	}),
	authLaunchTicket: defineRoute({
		...post,
		status: 200,
		params: Empty,
		response: EventTicket,
		summary: "A single-use, short-lived ticket a launcher puts in the URL it opens instead of the launch token",
		...runtimeRoutes.authLaunchTicket,
	}),
	authRevoke: defineRoute({
		...post,
		status: 200,
		params: Empty,
		response: Empty,
		summary:
			"Sign this client out: its credential and stream tickets stop working, its event streams close and the sessions it controls are freed",
		...runtimeRoutes.authRevoke,
	}),
	eventTicket: defineRoute({
		...post,
		status: 200,
		params: Empty,
		response: EventTicket,
		summary: "A single-use ticket that opens one event stream for this client",
		...runtimeRoutes.eventTicket,
	}),
	events: defineRoute({
		...get,
		query: Type.Object(
			{ after: Type.Optional(EventCursor), ticket: Type.Optional(Type.String({ maxLength: 64 })) },
			{ additionalProperties: false },
		),
		response: Type.String(),
		stream: true,
		summary: "Global event stream",
		...runtimeRoutes.events,
	}),
	tools: defineRoute({
		...get,
		response: Programs,
		summary: "Pinned programs in registry order",
		...runtimeRoutes.tools,
	}),
	install: defineRoute({
		...post,
		params: toolParams,
		body: Install,
		response: Accepted,
		summary: "Install the pinned program",
		...runtimeRoutes.install,
	}),
	remove: defineRoute({
		...post,
		params: toolParams,
		response: Accepted,
		summary: "Remove vendored versions",
		...runtimeRoutes.remove,
	}),
	operation: defineRoute({
		...get,
		params: operationParams,
		response: Operation,
		summary: "Operation snapshot",
		...runtimeRoutes.operation,
	}),
	cancel: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		response: Operation,
		summary: "Cancel a cancellable operation",
		...runtimeRoutes.cancel,
	}),
};
