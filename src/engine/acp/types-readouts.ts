// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Readouts: the live session readouts notification, its capability, and
 * the admission meta.
 */
import type { Static } from "typebox";
import { Type } from "typebox";
import { closed, sessionId } from "./types.js";

/**
 * Live readouts for an attended client: the yolo posture and window, the live rate, armed skills and the provider
 * retry, pushed per session as one closed frame. `null` in a field means nothing to show, never zero. The judge's
 * admission phase rides `_meta[ACP_ADMISSION_META_KEY]` on a non-terminal `tool_call_update`. Both need the
 * client's `clientCapabilities._meta[ACP_READOUTS_META_KEY] = {version: 1}`.
 */
export const ACP_READOUTS_META_KEY = "pancode/readouts";
export const ACP_READOUTS_NOTIFICATION = "_pancode/session/readouts";
export const ACP_ADMISSION_META_KEY = "pancode/admission";
/** A frame whose only change is the rate waits this long after the last one (at most 4 Hz). */
export const ACP_READOUTS_MIN_INTERVAL_MS = 250;

export const AcpReadoutsCapability = Type.Object(
	{
		version: Type.Literal(1),
		notification: Type.Literal(ACP_READOUTS_NOTIFICATION),
		minIntervalMs: Type.Literal(ACP_READOUTS_MIN_INTERVAL_MS),
		admission: Type.Literal(ACP_ADMISSION_META_KEY),
	},
	closed,
);
export type AcpReadoutsCapability = Static<typeof AcpReadoutsCapability>;
export const ACP_READOUTS_CAPABILITY: AcpReadoutsCapability = {
	version: 1,
	notification: ACP_READOUTS_NOTIFICATION,
	minIntervalMs: ACP_READOUTS_MIN_INTERVAL_MS,
	admission: ACP_ADMISSION_META_KEY,
};

const readoutTone = Type.Union([Type.Literal("warning"), Type.Literal("error")]);
const AcpAutonomyWindowReadout = Type.Object(
	{
		display: Type.String({ maxLength: 128 }),
		tone: Type.Union([Type.Literal("neutral"), Type.Literal("warning")]),
		halted: Type.Boolean(),
		haltDetail: Type.Optional(Type.String({ maxLength: 512 })),
	},
	closed,
);
const AcpAutonomyReadout = Type.Object(
	{
		level: Type.Literal("yolo"),
		confinement: Type.Union([Type.Literal("contained"), Type.Literal("unconfined")]),
		osSandbox: Type.Boolean(),
		label: Type.String({ maxLength: 64 }),
		tone: readoutTone,
		window: Type.Union([Type.Null(), AcpAutonomyWindowReadout]),
	},
	closed,
);
const AcpThroughputReadout = Type.Object(
	{ display: Type.String({ maxLength: 32 }), estimated: Type.Boolean(), flowing: Type.Boolean() },
	closed,
);
const AcpSkillsReadout = Type.Object(
	{
		names: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 }),
		display: Type.String({ maxLength: 256 }),
	},
	closed,
);
const AcpRetryReadout = Type.Object(
	{
		phase: Type.Union([
			Type.Literal("scheduled"),
			Type.Literal("waiting"),
			Type.Literal("retrying"),
			Type.Literal("moved"),
			Type.Literal("cancelled"),
			Type.Literal("exhausted"),
			Type.Literal("recovered"),
		]),
		active: Type.Boolean(),
		display: Type.String({ maxLength: 512 }),
	},
	closed,
);
export const AcpReadouts = Type.Object(
	{
		autonomy: Type.Union([Type.Null(), AcpAutonomyReadout]),
		throughput: Type.Union([Type.Null(), AcpThroughputReadout]),
		skills: Type.Union([Type.Null(), AcpSkillsReadout]),
		retry: Type.Union([Type.Null(), AcpRetryReadout]),
	},
	closed,
);
export type AcpReadouts = Static<typeof AcpReadouts>;
/** `_pancode/session/readouts` params. `sequence` rises by one per frame on the connection. */
export const AcpReadoutsNotification = Type.Object(
	{
		version: Type.Literal(1),
		sessionId,
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		readouts: AcpReadouts,
	},
	closed,
);
export type AcpReadoutsNotification = Static<typeof AcpReadoutsNotification>;
/** `tool_call_update._meta["pancode/admission"]`: the safety judge is reviewing the call, or has admitted it. */
export const AcpAdmissionMeta = Type.Object(
	{
		version: Type.Literal(1),
		state: Type.Union([Type.Literal("judging"), Type.Literal("admitted")]),
		display: Type.Optional(Type.String({ maxLength: 128 })),
	},
	closed,
);
export type AcpAdmissionMeta = Static<typeof AcpAdmissionMeta>;
