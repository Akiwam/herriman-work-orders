// Test helper (STORY-015): since AI-first intake, a citizen request becomes a work order only when a
// named person approves its draft. Tests that need the work order approve it the way a supervisor would.

import { approveDraft, listDrafts } from '../../server/intake.js';
import { bootstrapAdministrator } from '../../server/access.js';

export const APPROVER_EMAIL = 'intake.approver@herriman.example';

/** The test approver: a system administrator (who holds intake:approve), created once per database. */
export function approver(db) {
  const existing = db.prepare(`SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
                               WHERE r.role_id = 'system_admin' AND u.is_active = 1 ORDER BY u.created_at LIMIT 1`).get();
  return existing?.id ?? bootstrapAdministrator(db, { email: APPROVER_EMAIL, display_name: 'Intake Approver' }).id;
}

/** Approve the open draft for a citizen request (by tracking code). Returns the new work order's id. */
export async function approveRequest(db, trackingCode, { now, changes = {} } = {}) {
  const req = db.prepare('SELECT id, category FROM service_requests WHERE tracking_code = ?').get(trackingCode);
  const draft = listDrafts(db).find((d) => d.source_type === 'citizen_request' && d.source_id === req.id);
  // If the agent could not tell the work type, the reviewer supplies it, as they would on screen.
  const fill = draft.proposed.work_type ? {} : { work_type: req.category };
  const { workOrder } = await approveDraft(db, draft.id, { changes: { ...fill, ...changes }, actorUserId: approver(db), ...(now ? { now } : {}) });
  return workOrder.id;
}
