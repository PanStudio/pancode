// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The hub root public keys: base64 raw Ed25519 keys whose holder certifies the CI keys that sign the hub index
 * (`hub/keys/signing.json`, verified by `hub-signature.ts`). The private halves are held offline by the
 * maintainer. Empty until the real root key is generated, so every verification refuses; never add a
 * development or placeholder key here, since any key in this list is trusted by every release.
 */
export const HUB_ROOT_PUBLIC_KEYS: ReadonlyArray<string> = [];
