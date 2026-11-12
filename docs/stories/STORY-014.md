# STORY-014 — App shell and work order console

As a system_user, I want one signed-in console with navigation that lists every work order with its status, assignee and location, so that the system I already built can be operated and demonstrated without a database client.

**Release:** r4 · Release 4 · Final Integration and Operational Readiness (weeks 7–7)
**Owner:** system_user
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-056** (Functional, should) — As a system_user, I want one signed-in console with navigation that lists every work order with its status, assignee and location, so that the system I already built can be operated and demonstrated without a database client.

## How to build it

Build the shell and the console only. Navigation must reach every screen in the later stories, even if those screens are still placeholders. Do not rebuild the work order API that STORY-001 already delivers.

## Failure paths you must handle

- The GIS service is unavailable when the detail view loads
- The session expires while a work order is being edited
- The work order list grows past one page

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given work orders exist, when the console loads, then each row shows status, assignee and location.
- [ ] Given a work order is opened, when the detail view renders, then its full history and GIS record appear on one screen.
- [ ] Given no work orders exist, when the console loads, then an empty state is shown rather than an error.
- [ ] Given the console is deployed, when it is opened at 1440x900, then every screen renders without a horizontal scrollbar so it can be captured for the proposal exhibit.
- [ ] Trust: every action taken in the console writes to the same audit trail as the API, recording who did it and when.

When every box above is ticked, stop and show the demo.
