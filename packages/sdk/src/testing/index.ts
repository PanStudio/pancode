// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Runs an extension's api 2 runtime in a test, in process, under the rules PanCode applies to it. */
export { createExtensionTestHost } from "./host.js";
export type { RuntimeRegistration } from "./registration.js";
export type {
	ExtensionTestHost,
	ExtensionTestManifest,
	ExtensionTestOptions,
	ExtensionTestServices,
} from "./test-api.js";
