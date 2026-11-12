# STORY-016 — Map and heat map views for work order activity

As a City Planner, I want work orders plotted on a map and summarized as a heat map, so that I can see where work is concentrated instead of reading coordinates in a table.

**Release:** r4 · Release 4 · Final Integration and Operational Readiness (weeks 7–7)
**Owner:** City Planner
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-058** (Functional, should) — As a City Planner, I want work orders plotted on a map and summarized as a heat map, so that I can see where work is concentrated instead of reading coordinates in a table.

## How to build it

STORY-002 already reads and writes the GIS database and STORY-005 already generates heat map data. This story is the view over both, not a second copy of either.

## Failure paths you must handle

- A work order has no coordinates recorded
- The GIS source times out
- The selected date range returns no work orders

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given work orders with locations, when the map loads, then each one is plotted at its GIS coordinates.
- [ ] Given a date range is selected, when the heat map renders, then it reflects only work orders within that range.
- [ ] Given the GIS source is unavailable, when the map loads, then it says so and still lists the work orders.
- [ ] Trust: the map reads the same GIS record as the API, so what is displayed and what is stored cannot disagree.

When every box above is ticked, stop and show the demo.
