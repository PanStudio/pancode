// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { arch, platform, release } from "node:os";
import type { ClientIdentity, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { mergeClientIdentity } from "@earendil-works/pi-ai";
import { readPancodeVersion } from "../core/package-root.js";

let identity: ClientIdentity | undefined;

/**
 * How PanCode introduces itself to providers. Pi 1.4 sends its own `pi/<version>` User-Agent unless a request names
 * an identity, and its Agent attributes OpenRouter, NVIDIA NIM and OpenCode requests to pi. The User-Agent matches
 * the one the openai-codex runtime already sends. Anthropic subscription OAuth keeps Pi's Claude Code headers.
 */
export function pancodeClientIdentity(): ClientIdentity {
	identity ??= {
		userAgent: { custom: `pancode/${readPancodeVersion()} (${platform()} ${release()}; ${arch()})` },
		attribution: { name: "PanCode", url: "https://github.com/akougkas/pancode", categories: ["cli-agent"] },
	};
	return identity;
}

/** PanCode's identity under a request's own, which still wins field by field. */
export function withPancodeIdentity<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T {
	return {
		...options,
		identity: mergeClientIdentity(pancodeClientIdentity(), options?.identity) ?? pancodeClientIdentity(),
	} as T;
}
