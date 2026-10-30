# STORY-003 — STORY-003 · Public interface for citizen requests

As a citizen, I want to submit requests and view work order activities, so that I can stay informed about public works.

**Release:** r1 · Release 1 · Public Reporting and API Integration (weeks 2–2)
**Owner:** Citizen
**Blocked by:** STORY-013

## The requirement this satisfies

_No requirement linked._

## How to build it

## Read this first
Your workspace repo is still being set up, so the full requirements are not on disk yet.
Everything you need for THIS task is inlined below — work from it directly.
Once the portal finishes provisioning, the full documents will be in your repo.

## What we're building
Herriman City Work Order Management System — A comprehensive work order management system for Herriman City, integrating GIS data, public reporting, and robust API capabilities.
You are in Release r1 · Public Reporting and API Integration (weeks 5–8).
This release lands when: Show public interface for citizen requests and basic API connections.

## Your task
STORY-003 — Public interface for citizen requests
As a citizen, I want to submit requests and view work order activities, so that I can stay informed about public works.
Owning agent(s): Citizen

## The requirement this satisfies
REQ-037 (FUNC, must) — "The system must provide a public-facing reporting interface allowing citizens to submit requests or view public work order activities."

## Guardrails that apply to the WHOLE project
These hold regardless of which story you are on. If this task would break one,
stop and say so rather than working around it.

- The system must allow for successful creation, updating, and completion of work orders, as evidenced by user testing and demonstration.

## What this project is trying to move
- The software must be operational by July 1, 2027.

You are not being asked to hit these today. Know them so your choices point at them.

## How we build here
Develop a public-facing interface for request submission and work order viewing.

Walking skeleton first, then harden. Small, testable, reversible steps. Every external
call gets an explicit timeout and capped retries. Every side effect is idempotent —
running it twice must not double-charge, double-email, or double-create.

## Where this sits in the build
This story waits on these — they are already specified, reuse them, do not rebuild them:
- STORY-001 · Create, manage, and audit work orders with GIS integration

This is the last story in the plan.

## Failure paths you must handle
- Submission fails
- Data not displayed
- Unauthorized access

## Acceptance — your stop condition
- Given a citizen request, when submitted, then it appears in the work order system.
- Given a public work order, when viewed, then it shows current status and history.
- Trust: All public submissions are logged with timestamps and IP addresses.

When every line above passes, the task is done — stop the build loop and show me the demo.

## Stop and ask me if
- A guardrail above would have to bend to finish this.
- The requirement turns out to be wrong, or impossible as written. Say so — do not
  silently build something adjacent that passes the tests.
- You need a credential, an account, or access to an external system that you do not have.
- The acceptance criteria cannot be tested as written.
- You are about to change a file outside this story to make it pass.

## Definition of done
- Tests cover the happy path and at least one failure path above.
- No secrets in code, commits, or logs.
- The commit message names the story: `STORY-003: <what you did>`. The platform reads that to track your progress.
- A junior developer can read the change and understand why it is correct.
- When you are finished, tell me your confidence as a percentage that this story is
  complete and correct, and what would raise it.

## When you finish: record what this story taught the project
Before you start, read `.colaberry/plan.json` and `docs/stories/STORY-000.md` (the section
"What the platform understands about this project"). That is the current truth. Note anything
this story adds to it: a system it turns out to talk to, a decision you had to make, a limit you
discovered, a role or approval point that appeared.

When the acceptance criteria pass, write `.colaberry/enrichment/STORY-003.json` with exactly this shape:

```
{
  "schemaVersion": "1",
  "projectId": "062d6c26-d24a-4c98-a59e-7e1a4bb17890",
  "storyId": "STORY-003",
  "projectTruthBaseRevision": 0,
  "observedAt": "<ISO timestamp>",
  "sourceCommitSha": "<sha of your last commit, or null>",
  "factProposals": [
    {
      "dimension": "integrations",
      "value": "Reads open tickets from the Zendesk API.",
      "evidence": "src/zendesk/client.ts"
    }
  ],
  "decisions": [
    {
      "statement": "Poll every 5 minutes rather than subscribe to webhooks.",
      "rationale": "no webhook access in the sandbox",
      "evidence": "src/poll.ts"
    }
  ],
  "limitations": [
    {
      "statement": "Attachments over 10MB are skipped.",
      "evidence": "src/zendesk/client.ts#L40"
    }
  ],
  "demonstrationEvidence": [
    {
      "kind": "test",
      "ref": "zendesk.client.test.ts"
    }
  ],
  "measurementEvents": []
}
```

Rules for that file:
- Only what this story's work actually shows. Each entry names the file, commit or test that
  proves it. No evidence, no entry.
- `dimension` is one of: problem, desired_outcome, actors, current_workflow, inputs, outputs,
  data, systems, integrations, pain_points, exceptions, approval_points, security_context,
  ai_opportunities, human_only_decisions, assumptions, unknowns, constraints,
  success_definition, delivery_profile.
- Never claim a business result. What the business wanted, what hurt before, what "success"
  means: those are the student's statements, not the build's, and the platform refuses them
  from this file.
- If you found something that contradicts the truth, still write it: the platform files it as
  a question for the student rather than replacing what they confirmed.
- `projectTruthBaseRevision` is `truth_revision` from `.colaberry/manifest.json`, or 0 if absent.
- Commit it with the story. The platform reads it on push; pushing it twice changes nothing.

## How I want you to work
Work as a paced co-pilot. Move one step at a time: propose the next change, wait for me
to confirm, then make it. Never batch several edits together. After each step, tell me
what you did and what the next step is.

## Your workspace repo
Not provisioned yet. Finish repo setup in the portal to get a repo, your requirements on disk, and progress tracking. That repo is public, so keep secrets out of it.

Begin.

## Failure paths you must handle


## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a citizen request, when submitted, then it appears in the work order system.
- [ ] Given a public work order, when viewed, then it shows current status and history.
- [ ] Trust: All public submissions are logged with timestamps and IP addresses.

When every box above is ticked, stop and show the demo.
