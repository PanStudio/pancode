// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Evidence records: trust status and the assessed findings a run carries (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { vocabulary } from "./enums.js";
import { ExistingId } from "./id-schemas.js";
import { closed, count, nullable, ObjectRefSchema, sha256Hex } from "./schemas.js";
import {
	EVIDENCE_TAGS,
	TRUST_ABSENCE_REASONS,
	TRUST_ARTIFACT_KINDS,
	TRUST_STATUS_AUTHORITY_KINDS,
	TRUST_STATUS_SOURCE_KINDS,
	TRUST_STATUS_STATES,
} from "./trust-vocabulary.js";

const trustIdentifier = Type.String({ minLength: 1, maxLength: 512 });
const trustArtifact = Type.Object(
	{
		kind: vocabulary(TRUST_ARTIFACT_KINDS),
		id: trustIdentifier,
		digest: Type.Optional(
			Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, closed),
		),
	},
	closed,
);
/** One trust axis: an attributed state, or an absence and its reason (`domains/evidence/trust-status.ts`). */
function trustAxisSchema<const T extends readonly string[]>(states: T) {
	return Type.Union([
		Type.Object(
			{
				state: vocabulary(states.filter((state) => state !== "absent")),
				source: Type.Object({ kind: vocabulary(TRUST_STATUS_SOURCE_KINDS), id: trustIdentifier }, closed),
				authority: Type.Object({ kind: vocabulary(TRUST_STATUS_AUTHORITY_KINDS), id: trustIdentifier }, closed),
				artifacts: Type.Array(trustArtifact, { maxItems: 16 }),
			},
			closed,
		),
		Type.Object({ state: Type.Literal("absent"), reason: vocabulary(TRUST_ABSENCE_REASONS) }, closed),
	]);
}
const TrustStatusSchema = Type.Object(
	{
		version: Type.Literal(1),
		artifactIntegrity: trustAxisSchema(TRUST_STATUS_STATES.artifactIntegrity),
		validationGrounding: trustAxisSchema(TRUST_STATUS_STATES.validationGrounding),
		independentReview: trustAxisSchema(TRUST_STATUS_STATES.independentReview),
		contextProvenance: trustAxisSchema(TRUST_STATUS_STATES.contextProvenance),
		completionEvidence: trustAxisSchema(TRUST_STATUS_STATES.completionEvidence),
	},
	closed,
);
const findingId = Type.String({ pattern: "^finding-[0-9]{3}$" });
/**
 * A finished run's assessment, journaled after its run.settled and before its seal, so the seal covers it and the
 * sealed run scope is the run's evidence (#434). Version 1. The trust status is the producer's: its integrity axis
 * says the producer held the record, and a reader replaces it with the seal's own verdict. Finding prose and the
 * decision records the run cited are content, kept in the `evidence-findings` object `text` names.
 */
export const EvidenceAssessedSchema = Type.Object(
	{
		version: Type.Literal(1),
		/** The dispatch lineage attempt the run ran as; null for a run dispatched without a lineage. */
		attempt: nullable(count),
		/** Succeeded on its first attempt with validation evidence. */
		firstPassSuccess: Type.Boolean(),
		/** What a non-zero exit is attributed to, from termination facts only; null for a run that exited 0. */
		failureCause: nullable(vocabulary(EVIDENCE_TAGS)),
		trust: TrustStatusSchema,
		findings: Type.Array(
			Type.Object({ id: findingId, severity: vocabulary(["info", "warn"]), tag: vocabulary(EVIDENCE_TAGS) }, closed),
			{ maxItems: 128 },
		),
		/** The gate decisions that judged the run by the time it settled, as the independent-review axis read them. */
		verdicts: Type.Array(
			Type.Object(
				{
					decisionId: ExistingId,
					digest: sha256Hex,
					outcome: ExistingId,
					review: vocabulary(TRUST_STATUS_STATES.independentReview),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		/**
		 * Where the run came from as dispatch recorded it: the decisions it cited and whether each resolved on its
		 * session's board, the pipeline step it ran as, and the persona override that composed its prompt. Null when the
		 * run was sealed by recovery after its owner died, which no longer holds them.
		 */
		provenance: nullable(
			Type.Object(
				{
					decisionRefs: Type.Array(Type.Object({ ref: ExistingId, resolved: Type.Boolean() }, closed), {
						maxItems: 256,
					}),
					pipeline: nullable(
						Type.Object(
							{
								fromRunId: nullable(ExistingId),
								position: Type.Integer({ minimum: 1 }),
								inputBytes: count,
								inputTruncated: Type.Boolean(),
							},
							closed,
						),
					),
					personaOverride: nullable(Type.Object({ promptHash: ExistingId }, closed)),
				},
				closed,
			),
		),
		text: ObjectRefSchema,
	},
	closed,
);
export type EvidenceAssessed = Static<typeof EvidenceAssessedSchema>;
/** The `evidence-findings` object an evidence.assessed names: each finding's sentence and the decisions it resolved. */
export const EvidenceFindingsObjectSchema = Type.Object(
	{
		version: Type.Literal(1),
		findings: Type.Array(Type.Object({ id: findingId, message: Type.String() }, closed)),
		decisions: Type.Array(
			Type.Object({ ref: ExistingId, sessionId: ExistingId, record: Type.Record(Type.String(), Type.Unknown()) }, closed),
		),
		/**
		 * The workspace dispatch ran the run from, so a project may still read its retained evidence once the bounded
		 * run ledger drops its row; null when the run was sealed by recovery without its row (#434).
		 */
		cwd: nullable(Type.String()),
	},
	closed,
);
export type EvidenceFindingsObject = Static<typeof EvidenceFindingsObjectSchema>;
