# STORY-018 — Integrations and operational readiness view

As a Project Manager, I want one view showing each external connection, its last successful call and the operational readiness checks, so that I can show a reviewer the system is connected and ready rather than describing it.

**Release:** r4 · Release 4 · Final Integration and Operational Readiness (weeks 7–7)
**Owner:** Project Manager
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-060** (Functional, should) — As a Project Manager, I want one view showing each external connection, its last successful call and the operational readiness checks, so that I can show a reviewer the system is connected and ready rather than describing it.

## How to build it

STORY-004, STORY-009, STORY-011 and STORY-010 already built the connections and the readiness assessment. This story surfaces them on one screen so a reviewer can see them. A status that is hardcoded or cached without refresh does not satisfy the trust line.

## Failure paths you must handle

- An integration has never been called, so it has no last successful call
- A vendor endpoint returns success with an unexpected payload shape
- A readiness check has no evidence recorded

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given configured integrations, when the view loads, then each shows its vendor, status and the time of its last successful call.
- [ ] Given an integration has failed, when the view loads, then it is flagged with the error class and the time it began failing.
- [ ] Given the readiness checks, when the view loads, then each check shows pass or fail with the evidence behind it.
- [ ] Trust: every status shown is read from a real call result, never from a stored flag that nothing updates.

When every box above is ticked, stop and show the demo.
