# STORY-015 — AI-first intake: the agent drafts, a person approves

As a system_user, I want citizen requests and Bluestakes records to arrive as a drafted work order that I approve, correct or reject, so that the agent does the data entry while a named person keeps the decision.

**Release:** r4 · Release 4 · Final Integration and Operational Readiness (weeks 7–7)
**Owner:** system_user
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-057** (Functional, should) — As a system_user, I want citizen requests and Bluestakes records to arrive as a drafted work order that I approve, correct or reject, so that the agent does the data entry while a named person keeps the decision.

## How to build it

This is the screen that makes the human and AI split visible. Reuse the citizen request path from STORY-003 and the Bluestakes path from STORY-013 as the sources; this story adds the proposal, the queue and the approval record, not new ingestion.

## Failure paths you must handle

- The agent proposes a draft with a field it could not determine
- Two reviewers approve the same draft at the same time
- An approval is submitted after the source record changed

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an incoming citizen request or Bluestakes record, when it is received, then a draft work order is proposed with its fields already filled in.
- [ ] Given a proposed draft, when I approve it, then the work order is created and the record names who approved it.
- [ ] Given a proposed draft, when I edit or reject it, then my version is what is saved and the original proposal is retained.
- [ ] Given the approval queue, when it renders, then each item states who performs the work and who must approve it.
- [ ] Trust: no work order reaches a live queue without a named person approving it, and the screen shows who that was.

When every box above is ticked, stop and show the demo.
