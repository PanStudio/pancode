// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { AcpElicitationCapability as ElicitationCapability } from "./wire.js";

export { elicitationContentErrors, elicitationValueError } from "./elicitation-values.js";
export {
	ACP_ELICITATION_CANCEL_METHOD as ELICITATION_CANCEL_METHOD,
	ACP_ELICITATION_REQUEST_METHOD as ELICITATION_REQUEST_METHOD,
} from "./wire.js";
export { ElicitationCapability };

const closed = { additionalProperties: false };
const Key = Type.String({ minLength: 1, maxLength: 128 });
const Label = Type.String({ minLength: 1, maxLength: 256 });
const Option = Type.Object({ value: Type.String({ maxLength: 1024 }), label: Label }, closed);
const base = {
	key: Key,
	label: Label,
	description: Type.Optional(Type.String({ maxLength: 1024 })),
	required: Type.Boolean(),
};

/**
 * One field of an MCP server's form, as the runtime read it from the server's
 * flat schema. The runtime already refused secrets and anything a flat form
 * does not allow; the GUI renders what is here and nothing else.
 */
export const ElicitationField = Type.Union([
	Type.Object(
		{
			...base,
			kind: Type.Literal("string"),
			minLength: Type.Optional(Type.Integer({ minimum: 0 })),
			maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
			format: Type.Optional(
				Type.Union([Type.Literal("email"), Type.Literal("uri"), Type.Literal("date"), Type.Literal("date-time")]),
			),
			default: Type.Optional(Type.String()),
		},
		closed,
	),
	Type.Object(
		{
			...base,
			kind: Type.Literal("number"),
			integer: Type.Boolean(),
			minimum: Type.Optional(Type.Number()),
			maximum: Type.Optional(Type.Number()),
			default: Type.Optional(Type.Number()),
		},
		closed,
	),
	Type.Object({ ...base, kind: Type.Literal("boolean"), default: Type.Optional(Type.Boolean()) }, closed),
	Type.Object(
		{
			...base,
			kind: Type.Literal("choice"),
			options: Type.Array(Option, { minItems: 1, maxItems: 64 }),
			default: Type.Optional(Type.String()),
		},
		closed,
	),
	Type.Object(
		{
			...base,
			kind: Type.Literal("multi"),
			options: Type.Array(Option, { minItems: 1, maxItems: 64 }),
			minItems: Type.Optional(Type.Integer({ minimum: 0 })),
			maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
			default: Type.Optional(Type.Array(Type.String())),
		},
		closed,
	),
]);
export type ElicitationField = Static<typeof ElicitationField>;

const Message = Type.String({ maxLength: 4096 });
const Server = Type.String({ minLength: 1, maxLength: 256 });
const ElicitationId = Type.String({ minLength: 1, maxLength: 128 });
const formParts = {
	mode: Type.Literal("form"),
	message: Message,
	fields: Type.Array(ElicitationField, { minItems: 1, maxItems: 24 }),
};
const urlParts = {
	mode: Type.Literal("url"),
	message: Message,
	url: Type.String({ minLength: 1, maxLength: 2048 }),
	host: Type.String({ minLength: 1, maxLength: 2048 }),
	domain: Type.String({ minLength: 1, maxLength: 2048 }),
	warnings: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 8 }),
	/** The browser page is part of a call that waits: after opening it, the operator says when it is done. */
	awaitCompletion: Type.Boolean(),
	/** The operator already agreed to open this link during the same call. */
	consented: Type.Boolean(),
};

/** `_pancode/elicitation/request`: an MCP server's form or link, put to the person at this GUI. */
export const ElicitationRequest = Type.Union([
	Type.Object({ sessionId: Id, elicitationId: ElicitationId, server: Server, ...formParts }, closed),
	Type.Object({ sessionId: Id, elicitationId: ElicitationId, server: Server, ...urlParts }, closed),
]);
export const ElicitationWithdrawal = Type.Object(
	{ sessionId: Id, elicitationId: ElicitationId, completed: Type.Optional(Type.Literal(true)) },
	closed,
);

const promptParts = { id: Id, turnId: Id, requestedAt: Type.String(), server: Server };
/** What the GUI shows: the oldest elicitation still waiting in this session. */
export const ElicitationPrompt = Type.Union([
	Type.Object({ ...promptParts, ...formParts }, closed),
	Type.Object({ ...promptParts, ...urlParts }, closed),
]);
export type ElicitationPrompt = Static<typeof ElicitationPrompt>;

export const ElicitationValue = Type.Union([
	Type.String({ maxLength: 65536 }),
	Type.Number(),
	Type.Boolean(),
	Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64 }),
]);
export type ElicitationValue = Static<typeof ElicitationValue>;
export const ElicitationSubmission = Type.Union([
	Type.Object(
		{
			action: Type.Literal("accept"),
			content: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), ElicitationValue, { maxProperties: 24 })),
		},
		closed,
	),
	Type.Object({ action: Type.Union([Type.Literal("decline"), Type.Literal("cancel")]) }, closed),
]);
export type ElicitationSubmission = Static<typeof ElicitationSubmission>;

/** The runtime's ElicitResult. */
export type ElicitationResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, ElicitationValue> };
