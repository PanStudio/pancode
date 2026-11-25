// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The GitHub Copilot login the captures run on. The copilot-sdk runtime passes
// no token: it reads the official `copilot login` store under COPILOT_HOME
// (default ~/.copilot). Only the login keys of that store are copied into a
// capture home, under the account name `researcher`, and every token and the
// real account name join the privacy scan.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOGIN_KEYS = ["authTokens", "lastLoggedInUser", "loggedInUsers"];
const PERSONA = "researcher";

export function copilotLogin() {
	const dir = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
	const text = readFileSync(join(dir, "config.json"), "utf8");
	// The store opens with `//` comment lines.
	const config = JSON.parse(
		text
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n"),
	);
	if (!config.authTokens || Object.keys(config.authTokens).length === 0)
		throw new Error(`${dir} holds no Copilot login; sign in once with copilot login.`);
	const names = new Set(
		[config.lastLoggedInUser, ...(config.loggedInUsers ?? [])].map((user) => user?.login).filter(Boolean),
	);
	// The capture home is the researcher's: the account name in the copied store reads `researcher`;
	// the token, not the name, is the credential.
	const renamed = (value) =>
		typeof value === "string"
			? [...names].reduce((text, name) => text.replace(new RegExp(`:${name}(?=:|$)`, "g"), `:${PERSONA}`), value)
			: Array.isArray(value)
				? value.map(renamed)
				: value && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value).map(([key, item]) => [
								renamed(key),
								key === "login" && names.has(item) ? PERSONA : renamed(item),
							]),
						)
					: value;
	const login = Object.fromEntries(LOGIN_KEYS.filter((key) => key in config).map((key) => [key, renamed(config[key])]));
	const tokens = Object.values(config.authTokens)
		.map((entry) => (typeof entry === "string" ? entry : entry?.token))
		.filter((token) => typeof token === "string" && token.length > 0);
	return { login, tokens, names: [...names] };
}
