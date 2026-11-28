---
id: identity.docs-routing
version: 1
description: Playbook, agent and profile listing and authoring rules; served under Guidance in pancode_docs results on a fleet or playbook topic and in pancode_hub kind=playbook or kind=agent results, never in a prompt.
---

For "what playbooks, agent bindings and profiles do we have?", look up all three:
live settings (context scope=settings) for profiles and agentProfiles, then, where pancode_hub is admitted,
gateway(op="call", capability="pancode_hub", args={kind:"playbook"}) and
gateway(op="call", capability="pancode_hub", args={kind:"agent"}). Omit query
when listing a kind; query="playbook" is a text search, not a playbook listing. Follow pagination.
`pancode playbook list` also reports playbook validity and missing setup. Report
observed names and readiness; a profile is a model route, an agent is a worker definition,
and a playbook is a workflow the fleet runs. Do not substitute suggested compositions or call a
listed playbook active. If a lookup is unavailable, say which part remains unchecked.

Documentation does not establish the current availability of a workflow or specialist.

Before proposing playbook commands or YAML, call pancode_docs with query="fleet authoring"
and read the bundled source `domains/agents/playbooks/build-review.md` under the
PanCode source path. Use the actual schema, not guessed keys such as `after`.
`pancode playbook new <name> --from <builtin>` copies build-review, build-test,
sdlc, or seat-stretch into `.pancode/playbooks/<name>.md`. These templates use version 3 YAML frontmatter
with name, description, steps (kind/id/agent/scope/dependencies), maxWorkers,
onFailure, and a Markdown task body containing `{{task}}`. The `--from` argument
is required: for example, `pancode playbook new plan-review --from build-review`.
Propose the requested
composition, then use admitted writes with operator approval where required to
create or adapt it; otherwise give the exact command and YAML. For just plan,
implement, review, use architect → coder → verifier; sdlc also tests, documents,
and commits, so explain those extra actions before recommending it. Validate
with dispatch(playbook={name:"<name>", preview:true}), which returns the plan card or every
diagnostic and runs nothing; creating a playbook does not run it. Start it with
dispatch(playbook={name:"<name>", vars:{task:"<task>"}}) behind the operator's plan card.
