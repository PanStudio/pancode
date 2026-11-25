// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The SDK declares the host values its API carries in its own words, because
 * a package never imports the harness. Each line below fails the typecheck
 * when PanCode's definition and the SDK's drift apart in either direction.
 * Nothing imports this module; it exists to be type-checked.
 */
import type * as Sdk from "@pancode/sdk/extension";
import type { ModelRunInfo } from "../../core/model-tier.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import type { TurnOrigin } from "../../core/turn-origin.js";
import type { EmbeddingInput, EmbeddingResponse, EmbeddingTask } from "../providers/embedding/types.js";

type Same<Host, Wire> = [Host] extends [Wire] ? ([Wire] extends [Host] ? true : false) : false;

[
	true satisfies Same<ModelRunInfo, Sdk.ModelRunInfo>,
	true satisfies Same<FactSum, Sdk.FactSum>,
	true satisfies Same<TurnOrigin, Sdk.TurnOrigin>,
	true satisfies Same<EmbeddingInput, Sdk.EmbeddingInput>,
	true satisfies Same<EmbeddingResponse, Sdk.EmbeddingResponse>,
	true satisfies Same<EmbeddingTask, Sdk.EmbeddingTask>,
];
