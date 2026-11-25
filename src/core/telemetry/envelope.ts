// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static } from "typebox";
import { Type } from "typebox";
import type { TelemetryContext } from "./context.js";
import { TelemetryContextSchema } from "./context.js";
import { ContentClass, Tier, vocabulary } from "./enums.js";
import type { JournalEventName, JournalPayload } from "./events.js";
import { isJournalEvent, journalDefinition, validPayload } from "./events.js";
import { UUID_V7_PATTERN } from "./id-schemas.js";
import { newRecordId } from "./ids.js";
import { checkRecordSchema } from "./record-check.js";
import { UtcSchema } from "./schemas.js";

const closed = { additionalProperties: false };
export const ClockOriginSchema = Type.Object(
	{
		host: Type.String({ minLength: 1 }),
		pid: Type.Integer({ minimum: 1 }),
		birthToken: Type.Union([Type.String(), Type.Null()]),
		monoEpochWallMs: Type.Number({ minimum: 0 }),
	},
	closed,
);
export type ClockOrigin = Static<typeof ClockOriginSchema>;
export const SegmentHeaderSchema = Type.Object(
	{
		v: Type.Literal(1),
		k: Type.Literal("segment.open"),
		schemaSet: Type.String({ minLength: 1 }),
		mode: vocabulary(["standard", "research"]),
		capture: Type.Object(
			{
				content: Type.Boolean(),
				deltas: Type.Boolean(),
				providerHeaders: Type.Boolean(),
				busTrace: Type.Boolean(),
			},
			closed,
		),
		clockOrigin: ClockOriginSchema,
		writer: Type.Object(
			{
				pancodeVersion: Type.String(),
				piVersion: Type.String(),
				/** The build that wrote the segment, when the bundle recorded one; a source run writes none (C-31). */
				build: Type.Optional(
					Type.Object(
						{
							commit: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
							dirty: Type.Optional(Type.Boolean()),
							id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
							builtAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
						},
						closed,
					),
				),
			},
			closed,
		),
		/**
		 * The scope's hash chain head when this segment opened, on the first header of every segment a rotation opened,
		 * so the rotated segments form one chain. The scope's first segment starts the chain and carries none (#434).
		 */
		chainHead: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
	},
	closed,
);
export type SegmentHeader = Static<typeof SegmentHeaderSchema>;

export const EnvelopeSchema = Type.Object(
	{
		v: Type.Literal(1),
		k: Type.String(),
		kv: Type.Integer({ minimum: 1 }),
		id: Type.String({ pattern: `^rec_${UUID_V7_PATTERN}$` }),
		t: UtcSchema,
		mono: Type.Number({ minimum: 0 }),
		/** Forwarded worker records retain their source clock; local records use the segment origin (#434). */
		origin: Type.Optional(ClockOriginSchema),
		ctx: TelemetryContextSchema,
		tier: Tier,
		cc: ContentClass,
		data: Type.Unknown(),
	},
	closed,
);
export type TelemetryRecord<K extends JournalEventName = JournalEventName> = K extends JournalEventName
	? Omit<Static<typeof EnvelopeSchema>, "k" | "data"> & { k: K; data: JournalPayload<K> }
	: never;

/** Called by the writer after dequeue; producers do not allocate ids or serialize per record (#434). */
export function makeTelemetryRecord<K extends JournalEventName>(
	kind: K,
	data: JournalPayload<K>,
	ctx: TelemetryContext,
	clock: { t: string; mono: number },
): TelemetryRecord<K> {
	const definition = journalDefinition(kind);
	return {
		v: 1,
		k: kind,
		kv: definition.version,
		id: newRecordId(),
		...clock,
		ctx,
		tier: definition.tier,
		cc: definition.cc,
		data,
	} as unknown as TelemetryRecord<K>;
}

export type RecordRead =
	| { kind: "record"; record: TelemetryRecord }
	| { kind: "header"; header: SegmentHeader }
	/** `k` names a known record kind whose payload failed its schema, so a reader can say which record it was. */
	| { kind: "skipped"; reason: "unknown-kind" | "unknown-version" | "invalid-record"; segment?: true; k?: string }
	/** A complete interior line whose checksum failed; what it held is unknown. */
	| { kind: "damaged" };

/** Readers never retire future records; even a newer envelope is counted, not rewritten (#434). */
export function readTelemetryRecord(value: unknown): RecordRead {
	if (!value || typeof value !== "object") return { kind: "skipped", reason: "invalid-record" };
	const raw = value as Record<string, unknown>;
	if (typeof raw.v === "number" && raw.v > 1) {
		return {
			kind: "skipped",
			reason: "unknown-version",
			...(raw.k === "segment.open" ? { segment: true as const } : {}),
		};
	}
	if (raw.k === "segment.open") {
		return checkRecordSchema(SegmentHeaderSchema, raw)
			? { kind: "header", header: raw }
			: { kind: "skipped", reason: "invalid-record", segment: true };
	}
	if (!checkRecordSchema(EnvelopeSchema, value)) return { kind: "skipped", reason: "invalid-record" };
	if (!isJournalEvent(value.k)) return { kind: "skipped", reason: "unknown-kind" };
	const definition = journalDefinition(value.k);
	if (value.kv !== definition.version) return { kind: "skipped", reason: "unknown-version" };
	const data = value.data;
	const invalid = { kind: "skipped", reason: "invalid-record", k: value.k } as const;
	if (value.tier !== definition.tier || value.cc !== definition.cc || !validPayload(value.k, data)) return invalid;
	if (value.k === "call.started" || value.k === "call.settled") {
		const call = data as JournalPayload<"call.started">;
		if (value.ctx.callId !== call.callId || value.ctx.attemptId !== call.attemptId) {
			return invalid;
		}
	}
	if (
		value.k === "run.usage_reported" &&
		(!value.ctx.runId ||
			value.ctx.agent.role !== "worker" ||
			value.ctx.agent.id !== value.ctx.runId ||
			value.ctx.callId ||
			value.ctx.attemptId)
	)
		return invalid;
	return { kind: "record", record: value as TelemetryRecord };
}
