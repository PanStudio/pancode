// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { capabilityEnvelope, envelopeDigest } from "@pancode/sdk/pack";
import type { PackIdentity } from "../../core/pack-identity.js";
import type { InstalledExtension } from "./types.js";

export function extensionIdentity(entry: InstalledExtension): PackIdentity {
	return {
		kind: "extension",
		id: entry.id,
		version: entry.version,
		digest: entry.provenance?.contentDigest ?? "",
		scope: entry.scope,
		...(entry.runtimeV2 ? { envelopeDigest: envelopeDigest(capabilityEnvelope(entry.runtimeV2, entry.plugin)) } : {}),
	};
}
