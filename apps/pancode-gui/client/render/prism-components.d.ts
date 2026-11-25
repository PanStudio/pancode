// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Prism grammar components have no bundled typings; each registers itself on the global Prism when imported. */
declare module "prismjs/components/*" {
	const component: unknown;
	export default component;
}
