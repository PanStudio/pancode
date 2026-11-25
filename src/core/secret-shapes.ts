// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Credential shapes every redactor and the sandbox env scrub share, so a shape one of them hides is never shown by
 * another. A pattern with `keepsHead` keeps group 1 (the command or header naming the secret) and hides group 2; the
 * others hide the whole match. Each pattern is global; callers clone it or reset `lastIndex` before `test`.
 */
export interface CredentialShape {
	kind: string;
	re: RegExp;
	keepsHead?: true;
}

/** A pattern source whose lower-case letters match either case. */
export function eitherCase(source: string): string {
	return source.replace(/[a-z]/g, (letter) => `[${letter.toUpperCase()}${letter}]`);
}

/**
 * The `pass` and `pwd` words of {@link SECRET_KEY_WORDS}. A bare `pass` or `pwd` is prose, the working directory or a word
 * such as `compass`, so each needs a `_` or `-` ahead of it in any case (`DB_PASS`, `db-pass`, `MYSQL_PWD`), or a glued
 * `PASS` written in capitals after a capital or digit (`DBPASS`, `PGPASS`, `MYSQLPASS`), or is `pgpass`. A counter such as
 * `n_pass=3` still takes this name, so display redaction shows only a short number under these names and hides the rest.
 */
export const PASS_KEY_WORDS = [
	`(?:[_-]|${eitherCase("pg")})${eitherCase("pass")}(?![A-Za-z])`,
	"[A-Z0-9]PASS(?![A-Za-z])",
	`[_-]${eitherCase("pwd")}(?![A-Za-z])`,
].join("|");

/**
 * The secret words a key name holds, shared by evidence and display redaction so the two hide the same keys. Beyond
 * {@link PASS_KEY_WORDS}, `passwd`, `password` and `passphrase` count anywhere; `PWD=/home/a`, `first pass: lint`,
 * `tests_passed`, `compass=northwest` and `bypass` keep their values. Only the glued `PASS` is case-sensitive; every other
 * word is spelled in either case, because Node 22 has no `(?i:)` group and the patterns compile without the `i` flag.
 */
export const SECRET_KEY_WORDS = [
	eitherCase("api[_-]?key|apikey|(?:account|access)[_-]?key|secret|token|pass(?:wd|word|phrase)|credential"),
	PASS_KEY_WORDS,
].join("|");

export const GITHUB_TOKEN_SHAPE: CredentialShape = {
	kind: "github-token",
	re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
};
// The dotted tail is the routing suffix of GitLab's newer tokens, as in `glpat-<key>.01.<id>`.
export const GITLAB_TOKEN_SHAPE: CredentialShape = {
	kind: "gitlab-token",
	re: /\bgl(?:pat|dt|rt|ptt|soat|ft)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{2,})*/g,
};
export const SLACK_TOKEN_SHAPE: CredentialShape = { kind: "slack-token", re: /\bxox[bpars]-[A-Za-z0-9-]{8,}\b/g };
// A webhook URL is its own credential: whoever holds the path can post as the integration.
export const SLACK_WEBHOOK_SHAPE: CredentialShape = {
	kind: "slack-webhook",
	re: /\b(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,}/gi,
};

/**
 * The value an Authorization header or a bearer scheme names. An opaque credential has no shape of its own, so the
 * header or scheme is the signal. A bare `bearer <word>` needs a digit to stay out of prose, and `$TOKEN` falls outside
 * the value charset. The optional quote takes its own whitespace, so a run of spaces is never split two ways.
 */
export const AUTHORIZATION_SHAPE: CredentialShape = {
	kind: "authorization",
	re: /\b((?:authorization\s*(?:["']\s*)?[:=]\s*["']?(?:bearer|basic|token|apikey)\s+)|(?:bearer\s+)(?=[A-Za-z0-9._~+/-]*\d))([A-Za-z0-9._~+/-]{8,}=*)/gi,
	keepsHead: true,
};

/** Shapes that are a credential by their value alone, wherever they sit. */
export const CREDENTIAL_VALUE_SHAPES: ReadonlyArray<CredentialShape> = [
	{ kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	GITHUB_TOKEN_SHAPE,
	GITLAB_TOKEN_SHAPE,
	{ kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ kind: "provider-key", re: /\b(?:hf_|npm_)[A-Za-z0-9]{20,}\b/g },
	SLACK_TOKEN_SHAPE,
	SLACK_WEBHOOK_SHAPE,
];

/**
 * A variable name ending a {@link SECRET_KEY_WORDS} word at a `_` or its end, all capitals as the environment and `.env`
 * files spell it (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `DB_PASSWORD`) or all lower case as `~/.aws/credentials` and
 * other ini files do (`aws_secret_access_key`). `MAX_TOKENS`, `TOKENIZER` and camel-case code names are not one.
 */
export const ENV_SECRET_NAME = `(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]*?(?:${SECRET_KEY_WORDS})(?![A-Za-z0-9]))(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)`;
/** The characters of a credential value printed by an assignment: base64, base64url and the usual token punctuation. */
export const ENV_SECRET_VALUE_CHARS = "[\\w/+=.~-]";

/**
 * What joins a secret name to its value: an `=` with optional spaces, as env, `.env` and ini files print one, or an `=`
 * and a quote. A quoted value after a spaced `=` is a source literal such as `const TOKEN = "fixture"`, which stays.
 */
export const ENV_SECRET_JOIN = String.raw`(?:[ \t]*=[ \t]*|=["'])`;

/**
 * A credential assigned to a secret variable name. Only a value of 16 or more characters holding a letter and a digit
 * counts, so command output keeps `GITHUB_TOKEN=$(gh auth token)`, `SECRET_KEY=test-secret-key-for-ci` and
 * `MAX_OUTPUT_TOKEN=128000`.
 */
const ENV_SECRET_SHAPE: CredentialShape = {
	kind: "env-secret",
	re: new RegExp(
		`(${ENV_SECRET_NAME}${ENV_SECRET_JOIN})(?=${ENV_SECRET_VALUE_CHARS}*\\d)(?=${ENV_SECRET_VALUE_CHARS}*[A-Za-z])(${ENV_SECRET_VALUE_CHARS}{16,})`,
		"g",
	),
	keepsHead: true,
};

/** Shapes where the command or header names the credential that follows it. */
// A shape that can match across a line break needs certifiedThinkingBreak (chat-panel.ts) and RAIL_FAMILIES (url-userinfo-hold.test.ts) updated.
export const CREDENTIAL_LEAD_SHAPES: ReadonlyArray<CredentialShape> = [
	ENV_SECRET_SHAPE,
	// `curl -u name:pw` and `--user name:pw`: the name stays, the password goes.
	{
		kind: "basic-auth",
		re: /(\bcurl\b[^\n|;&]*?\s(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)([^\s"']+)/g,
		keepsHead: true,
	},
	{ kind: "cookie", re: /(\b(?:set-)?cookie\s*["']?\s*:\s*)([^\r\n"']{8,})/gi, keepsHead: true },
	{ kind: "cli-password", re: /(\bsshpass\s+(?:-[a-oq-zA-Z]\S*\s+)*-p\s*)([^\s"']+)/g, keepsHead: true },
	{ kind: "cli-password", re: /(\bdocker\s+login\b[^\n|;&]*?\s-p(?:\s+|=))([^\s"']+)/g, keepsHead: true },
];

export const CREDENTIAL_SHAPES: ReadonlyArray<CredentialShape> = [
	...CREDENTIAL_VALUE_SHAPES,
	...CREDENTIAL_LEAD_SHAPES,
];

/** Whether `value` holds any shared credential shape. */
export function holdsCredentialShape(value: string): boolean {
	return CREDENTIAL_SHAPES.some((shape) => {
		shape.re.lastIndex = 0;
		return shape.re.test(value);
	});
}

/** Replace every match of `shapes` in `value`; `marker` names the replacement for a kind. */
export function replaceCredentialShapes(
	value: string,
	shapes: ReadonlyArray<CredentialShape>,
	marker: (kind: string) => string,
): string {
	let out = value;
	for (const shape of shapes) {
		out = out.replace(shape.re, (_match: string, head: unknown) => {
			return shape.keepsHead && typeof head === "string" ? `${head}${marker(shape.kind)}` : marker(shape.kind);
		});
	}
	return out;
}
