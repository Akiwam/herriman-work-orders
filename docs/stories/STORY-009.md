# STORY-009 — STORY-009 · Complete API integration with specific vendors

As a system, I want to complete API integration with specific vendors, so that data exchange is seamless and efficient.

**Release:** r4 · Release 4 · Final Integration and Operational Readiness (weeks 7–7)
**Owner:** System
**Blocked by:** STORY-008

## The requirement this satisfies

_No requirement linked._

## How to build it

## Read this first
Your workspace repo is still being set up, so the full requirements are not on disk yet.
Everything you need for THIS task is inlined below — work from it directly.
Once the portal finishes provisioning, the full documents will be in your repo.

## What we're building
Herriman City Work Order Management System — A comprehensive work order management system for Herriman City, integrating GIS data, public reporting, and robust API capabilities.
You are in Release r4 · Final Integration and Operational Readiness (weeks 17–20).
This release lands when: Demonstrate full system functionality and readiness for launch.

## Your task
STORY-009 — Complete API integration with specific vendors
As a system, I want to complete API integration with specific vendors, so that data exchange is seamless and efficient.
Owning agent(s): System

## The requirement this satisfies
REQ-054 (FUNC, must) — "API specifications and testing must be coordinated with specific vendors."
REQ-055 (FUNC, must) — "The system must provide API interfaces for Lama, Sprypoint, and Madison AI."

## Guardrails that apply to the WHOLE project
These hold regardless of which story you are on. If this task would break one,
stop and say so rather than working around it.

- The system must allow for successful creation, updating, and completion of work orders, as evidenced by user testing and demonstration.

## What this project is trying to move
- The software must be operational by July 1, 2027.

You are not being asked to hit these today. Know them so your choices point at them.

## How we build here
Finalize API specifications and complete integration with Lama, Sprypoint, and Madison AI.

Walking skeleton first, then harden. Small, testable, reversible steps. Every external
call gets an explicit timeout and capped retries. Every side effect is idempotent —
running it twice must not double-charge, double-email, or double-create.

## Where this sits in the build
This story waits on these — they are already specified, reuse them, do not rebuild them:
- STORY-008 · Configure system settings and user management

Waiting on this one — leave room for it, but do NOT build it now:
- STORY-010 · Operational readiness assessment

## Failure paths you must handle
- Vendor API fails
- Data mismatch
- Unauthorized access

## Acceptance — your stop condition
- Given a vendor API, when integrated, then data exchange is seamless.
- Given a data request, when via API, then it is processed correctly.
- Trust: All vendor API interactions are logged with timestamps and request details.

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
- The commit message names the story: `STORY-009: <what you did>`. The platform reads that to track your progress.
- A junior developer can read the change and understand why it is correct.
- When you are finished, tell me your confidence as a percentage that this story is
  complete and correct, and what would raise it.

## When you finish: record what this story taught the project
Before you start, read `.colaberry/plan.json` and `docs/stories/STORY-000.md` (the section
"What the platform understands about this project"). That is the current truth. Note anything
this story adds to it: a system it turns out to talk to, a decision you had to make, a limit you
discovered, a role or approval point that appeared.

When the acceptance criteria pass, write `.colaberry/enrichment/STORY-009.json` with exactly this shape:

```
{
  "schemaVersion": "1",
  "projectId": "062d6c26-d24a-4c98-a59e-7e1a4bb17890",
  "storyId": "STORY-009",
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

- [ ] Given a vendor API, when integrated, then data exchange is seamless.
- [ ] Given a data request, when via API, then it is processed correctly.
- [ ] Trust: All vendor API interactions are logged with timestamps and request details.

When every box above is ticked, stop and show the demo.
