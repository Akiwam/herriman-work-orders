# RFP - Enterprise Work Order Management System — Requirements

Gov build: project name established; requirements pending curation. Releases and stories mirror the board.

This is the source of truth for what you are building. Your Claude Code prompts
point here. If you sharpen a requirement, edit it — your version is the real one.

| Kind | Meaning |
|---|---|
| Functional | something the system does |
| Safety | a guardrail, with a check that enforces it |
| Reliability | how it behaves when something fails |
| Constraint | a technology or vendor you must use — context, not a task |

## Contract requirements

### REQ-001 — Functional · must

Herriman City (the “City”) is requesting proposals (“Proposals”) from qualified companies (“Proposers”) to provide work order management system for the City (the “Services”).

Fulfilled by: STORY-001

### REQ-002 — Functional · must

The City is requesting Proposal to provide a work order management system.

Fulfilled by: STORY-001

### REQ-022 — Functional · must

Scope of Work & Functional Requirements Vendors must indicate their compliance and technical approach for each requirement outlined below.

Fulfilled by: STORY-012

### REQ-023 — Functional · must

System must support bidirectional GIS integration to select assets and autofill multiple fields into a work order.

Fulfilled by: STORY-001

### REQ-026 — Functional · must

System must actively read from and write to the primary GIS database.

Fulfilled by: STORY-002

### REQ-031 — Functional · must

System must possess spatial analysis capabilities to generate heat maps based on work order types and geographical frequency.

Fulfilled by: STORY-005

### REQ-032 — Functional · must

System must provide an additional freeform location text field for use if specific location information is missing from the GIS database.

Fulfilled by: STORY-001

### REQ-037 — Functional · must

A public-facing reporting interface allowing citizens to submit requests or view public work order activities.

Fulfilled by: STORY-003

### REQ-038 — Functional · must

Integration Requirements The proposed solution must natively interface or provide verified API connections to the following core systems:

Fulfilled by: STORY-004

### REQ-039 — Functional · must

o Provide the ability to update, complete, and respond to Bluestakes data within the platform.

Fulfilled by: STORY-013

### REQ-040 — Functional · must

o Provide fully open database or API compatibility allowing Madison AI engines to index, crawl, and search internal work order data.

Fulfilled by: STORY-011

### REQ-045 — Functional · must

Does the City plan to initially implement new or existing workflows? Most exist and some will be new.

Fulfilled by: STORY-006

### REQ-047 — Functional · must

• System Administrators – Users responsible for System Administration including System configuration, Audits, access control, User ID, and Authorizations etc.

Fulfilled by: STORY-007, STORY-008

### REQ-051 — Functional · must

Selected vendors will be asked to give demonstrations of software.

Fulfilled by: STORY-001

### REQ-052 — Functional · must

• Time needs to be allotted for configuring, testing and data conversion

Fulfilled by: STORY-010

### REQ-053 — Functional · must

• Software needs to be operational by July 1, 2027 Integrations

Fulfilled by: STORY-010

### REQ-054 — Functional · must

• API specifications and testing would need to be coordinated with the Specific Vendors

Fulfilled by: STORY-004, STORY-009

### REQ-055 — Functional · should

• Lama, Sprypoint and Madison ai have no current interface but should be API.

Fulfilled by: STORY-009

## Student Additions

### REQ-056 — Functional · should

As a system_user, I want one signed-in console with navigation that lists every work order with its status, assignee and location, so that the system I already built can be operated and demonstrated without a database client.

Fulfilled by: STORY-014

### REQ-057 — Functional · should

As a system_user, I want citizen requests and Bluestakes records to arrive as a drafted work order that I approve, correct or reject, so that the agent does the data entry while a named person keeps the decision.

Fulfilled by: STORY-015

### REQ-058 — Functional · should

As a City Planner, I want work orders plotted on a map and summarized as a heat map, so that I can see where work is concentrated instead of reading coordinates in a table.

Fulfilled by: STORY-016

### REQ-059 — Functional · should

As a System Administrator, I want screens for user management, role permissions, system settings and the audit trail, so that the access controls already built can be operated without editing the database directly.

Fulfilled by: STORY-017

### REQ-060 — Functional · should

As a Project Manager, I want one view showing each external connection, its last successful call and the operational readiness checks, so that I can show a reviewer the system is connected and ready rather than describing it.

Fulfilled by: STORY-018
