# STORY-017 — Administration console for roles, settings and the audit trail

As a System Administrator, I want screens for user management, role permissions, system settings and the audit trail, so that the access controls already built can be operated without editing the database directly.

**Release:** r4 · Release 4 · Final Integration and Operational Readiness (weeks 7–7)
**Owner:** System Administrator
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-059** (Functional, should) — As a System Administrator, I want screens for user management, role permissions, system settings and the audit trail, so that the access controls already built can be operated without editing the database directly.

## How to build it

STORY-007 and STORY-008 already implement role based access, audit trails and settings. This story is the operator interface over them. The refusal path matters as much as the happy path, so build and test it.

## Failure paths you must handle

- An administrator removes their own last administrator role
- A role change is attempted on a user who no longer exists
- The audit trail grows past one page

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given I am an administrator, when I open the console, then I can view and change user roles and system settings.
- [ ] Given I am not an administrator, when I open the console, then I am refused and the refusal is recorded.
- [ ] Given any change is made, when I open the audit trail, then that change appears with actor, timestamp and previous value.
- [ ] Trust: the console enforces the same role checks as the API, so no screen can grant what the API would refuse.

When every box above is ticked, stop and show the demo.
