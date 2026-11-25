// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Link } from "react-router";
import { Icon } from "../design/icons.js";
import { useShell } from "../shell/shell-context.js";
import { PUBLIC_HELP, publicGuideUrl } from "./public-help.js";
import "./help.css";

const GUIDES = [
	{ path: "gui", title: "Your workspace", detail: "Projects, sessions and working with PanCode", icon: "sessions" },
	{
		path: "configuration-and-targets",
		title: "Connect your models",
		detail: "Providers, subscriptions and lab servers",
		icon: "models",
	},
	{ path: "fleet-dispatch", title: "Work with a team", detail: "Agents, delegation and shared research", icon: "fleet" },
	{
		path: "context-continuity",
		title: "Continue longer work",
		detail: "Context, memory and session continuity",
		icon: "layers",
	},
	{
		path: "panhub",
		title: "Extend your workflow",
		detail: "Skills, tools and reusable capabilities",
		icon: "hub",
	},
	{ path: "troubleshooting", title: "Find a way forward", detail: "Connection problems and recovery", icon: "system" },
] as const;

export function HelpLanding() {
	const shell = useShell();
	return (
		<section className="help-landing">
			<header>
				<p className="eyebrow">Help and learning</p>
				<h1>
					Make yourself <em>at home.</em>
				</h1>
				<p>Find your way around PanCode, connect your research tools, and keep your work moving.</p>
			</header>
			<div className="help-landing__actions">
				<button type="button" className="primary" onClick={() => shell?.openHelp()}>
					<Icon name="docs" />
					In-app help and shortcuts
				</button>
				<a href={PUBLIC_HELP} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
					Browse documentation <Icon name="external" />
				</a>
			</div>
			<div className="help-landing__guides">
				{GUIDES.map((guide) => (
					<a
						key={guide.path}
						href={publicGuideUrl(guide.path)}
						target="_blank"
						rel="noopener noreferrer"
						referrerPolicy="no-referrer"
					>
						<Icon name={guide.icon} />
						<div>
							<h2>{guide.title}</h2>
							<p>{guide.detail}</p>
						</div>
						<Icon name="external" />
					</a>
				))}
			</div>
			<footer>
				<p>
					Quick help and keyboard shortcuts are available inside PanCode. Full guides open on PanCode’s documentation site.
					The installed package also includes a reference for offline reading.
				</p>
				<Link to="/">
					Back to your workspace
					<Icon name="arrowLeft" />
				</Link>
			</footer>
		</section>
	);
}
