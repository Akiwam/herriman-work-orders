// Herriman Work Orders staff console (STORY-014).
//
// Every change goes through the existing work order API with the signed-in person's session, so each
// action lands in the same audit trail as any API call. The browser keeps only the session token, in
// this tab's sessionStorage; the personal key is sent once, to sign in, and never stored.
//
// If the session expires while you are editing, your edit stays on screen, you sign in again in place,
// and the save is retried. If someone else changed the work order meanwhile, you are told rather than
// overwriting their change (the version check, If-Match).

(() => {
  const API = '/api/v1';
  const app = document.getElementById('app');
  const NAV = [
    { route: 'work-orders', label: 'Work orders' },
    { route: 'intake', label: 'AI intake' },
    { route: 'map', label: 'Map' },
    { route: 'admin', label: 'Administration' },
    { route: 'integrations', label: 'Integrations & readiness' },
  ];
  const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

  // ---------- small helpers ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage blocked: stays signed in for this page only */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* nothing to remove */ } },
  };
  let token = store.get('hwo.session');
  let me = JSON.parse(store.get('hwo.me') || 'null');

  class SessionExpired extends Error {}

  async function api(method, path, { body, etag } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401 && path !== '/console/session') throw new SessionExpired();
    return { status: res.status, body: data, etag: res.headers.get('ETag') };
  }

  // Records whether the page fits the window, for the automatic 1440x900 check (data-layout-check on <html>).
  function markLayout() {
    requestAnimationFrame(() => {
      const el = document.documentElement;
      el.dataset.layoutCheck = el.scrollWidth > el.clientWidth ? `overflow:${el.scrollWidth - el.clientWidth}` : 'ok';
    });
  }

  // ---------- signing in ----------
  function signInForm(message) {
    return `<form class="card" id="signin-form">
      <h1>Sign in</h1>
      <p class="sub">${esc(message || 'Use the personal key your administrator gave you. It is used once to sign you in and is not kept by this browser.')}</p>
      <label for="key">Personal key</label>
      <input id="key" name="key" type="password" autocomplete="off" required class="wide">
      <p class="banner bad" id="signin-error" hidden></p>
      <div class="actions"><button class="primary" type="submit">Sign in</button></div>
    </form>`;
  }

  async function signIn(form) {
    const key = form.querySelector('#key').value.trim();
    const res = await api('POST', '/console/session', { body: { key } });
    if (res.status !== 201) {
      const err = form.querySelector('#signin-error');
      err.textContent = res.body?.message ?? 'Sign-in failed.';
      err.hidden = false;
      return false;
    }
    token = res.body.token;
    me = res.body.user;
    store.set('hwo.session', token);
    store.set('hwo.me', JSON.stringify(me));
    return true;
  }

  function showSignInPage(message) {
    app.innerHTML = `<div class="signin">${signInForm(message)}</div>`;
    document.getElementById('signin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await signIn(e.target)) render();
    });
    markLayout();
  }

  /** Session expired mid-task: sign in over the current screen, then carry on with what was being done. */
  function signInAgain(retry) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = signInForm('Your session expired. Sign in again to save. Your changes are still here.');
    document.body.appendChild(overlay);
    overlay.querySelector('#signin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await signIn(e.target)) {
        overlay.remove();
        renderShellUser();
        await retry();
      }
    });
    overlay.querySelector('#key').focus();
  }

  async function signOut() {
    try { await api('DELETE', '/console/session'); } catch { /* already ended */ }
    token = null;
    me = null;
    store.del('hwo.session');
    store.del('hwo.me');
    location.hash = '#/work-orders';
    showSignInPage('You are signed out.');
  }

  // ---------- the shell ----------
  function shell(active, content) {
    return `<div class="shell">
      <nav class="side" aria-label="Console">
        <div class="brand">Herriman Work Orders<small>Staff console</small></div>
        ${NAV.map((n) => `<a href="#/${n.route}" class="${n.route === active ? 'active' : ''}">${esc(n.label)}${n.story ? `<span class="soon">${esc(n.story)} · coming next</span>` : ''}</a>`).join('')}
        <div class="me"><span id="me-name">${esc(me?.display_name ?? '')}</span><br><span class="muted">${esc(me?.email ?? '')}</span>
          <button type="button" id="sign-out">Sign out</button></div>
      </nav>
      <main id="main">${content}</main>
    </div>`;
  }
  function renderShellUser() {
    const el = document.getElementById('me-name');
    if (el) el.textContent = me?.display_name ?? '';
  }
  function mount(active, content) {
    app.innerHTML = shell(active, content);
    document.getElementById('sign-out').addEventListener('click', signOut);
    markLayout();
  }

  // ---------- the work order list ----------
  async function renderList(params) {
    mount('work-orders', '<p class="muted">Loading work orders…</p>');
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    const [list, users] = await Promise.all([api('GET', `/console/work-orders?${qs}`), api('GET', '/console/users')]);
    if (list.status !== 200) return mount('work-orders', `<p class="banner bad">${esc(list.body?.message ?? 'The list could not be loaded.')}</p>`);
    const { items, total, next_cursor: next } = list.body;
    const options = (current) => `<option value="">Anyone</option><option value="unassigned" ${current === 'unassigned' ? 'selected' : ''}>Unassigned</option>`
      + users.body.items.map((u) => `<option value="${esc(u.id)}" ${current === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
    const filters = `<div class="toolbar">
      <label class="muted inline-label" for="f-status">Status</label>
      <select id="f-status"><option value="">All</option>${['open', 'completed'].map((s) => `<option ${params.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label class="muted inline-label" for="f-assignee">Assignee</label>
      <select id="f-assignee">${options(params.assignee)}</select>
      <span class="spacer"></span>
      <span class="muted">${total} work order${total === 1 ? '' : 's'}</span>
    </div>`;
    const empty = `<div class="card empty"><h2>No work orders${params.status || params.assignee ? ' match these filters' : ' yet'}</h2>
      <p>${params.status || params.assignee ? 'Try a different filter.' : 'Work orders appear here as soon as one is created, from the API, the public site or AI intake.'}</p></div>`;
    const table = `<table>
      <thead><tr><th class="col-title">Work order</th><th class="col-status">Status</th><th class="col-step">Step</th><th class="col-assignee">Assignee</th><th class="col-location">Location</th><th class="col-updated">Updated</th></tr></thead>
      <tbody>${items.map((r) => `<tr data-id="${esc(r.id)}" tabindex="0">
        <td title="${esc(r.title)}">${esc(r.title)}<br><span class="muted">${esc(r.work_type)} · ${esc(r.priority)}</span></td>
        <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
        <td title="${esc(r.step)}">${esc(r.step)}</td>
        <td>${r.assignee ? esc(r.assignee.name) : '<span class="muted">Unassigned</span>'}</td>
        <td title="${esc(r.location ?? '')}">${r.location ? esc(r.location) : '<span class="muted">No location</span>'}</td>
        <td title="${esc(when(r.updated_at))}">${esc(day(r.updated_at))}</td></tr>`).join('')}</tbody></table>`;
    const pager = `<div class="toolbar pager">
      <button type="button" id="first-page" ${params.cursor ? '' : 'disabled'}>First page</button>
      <button type="button" id="next-page" ${next ? '' : 'disabled'}>Next page</button></div>`;
    mount('work-orders', `<h1>Work orders</h1><p class="sub">Every work order, newest first.</p>${filters}${items.length ? table + pager : empty}`);

    const go = (p) => { location.hash = `#/work-orders?${new URLSearchParams(Object.entries(p).filter(([, v]) => v))}`; };
    document.getElementById('f-status').addEventListener('change', (e) => go({ ...params, status: e.target.value, cursor: '' }));
    document.getElementById('f-assignee').addEventListener('change', (e) => go({ ...params, assignee: e.target.value, cursor: '' }));
    document.querySelectorAll('tbody tr').forEach((tr) => {
      const open = () => { location.hash = `#/work-orders/${tr.dataset.id}`; };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
    document.getElementById('next-page')?.addEventListener('click', () => go({ ...params, cursor: next }));
    document.getElementById('first-page')?.addEventListener('click', () => go({ ...params, cursor: '' }));
  }

  // ---------- one work order ----------
  async function renderDetail(id, notice) {
    mount('work-orders', '<p class="muted">Loading…</p>');
    const [res, users] = await Promise.all([api('GET', `/console/work-orders/${encodeURIComponent(id)}`), api('GET', '/console/users')]);
    if (res.status !== 200) return mount('work-orders', `<p><a href="#/work-orders">← Work orders</a></p><p class="banner bad">${esc(res.body?.message ?? 'Not found.')}</p>`);
    const { item: wo, history, gis_status: gisStatus, gis_records: gisRecords, intake } = res.body;
    let etag = res.etag;
    const done = wo.status === 'completed';

    const gisBanner = {
      live: '',
      unavailable: '<p class="banner warn">GIS is unavailable right now, so this is the copy saved when the work order was created. Everything else on this screen is current.</p>',
      not_connected: '<p class="banner warn">GIS is not connected; showing the saved copy.</p>',
      no_assets: '',
    }[gisStatus] ?? '';
    const gisPanel = gisRecords.length
      ? gisRecords.map((g) => `<dl class="facts"><dt>Asset</dt><dd>${esc(g.id)} · ${esc(g.asset_type ?? '')}</dd><dt>Name</dt><dd>${esc(g.name ?? '—')}</dd>
          ${g.address ? `<dt>Address</dt><dd>${esc(g.address)}</dd>` : ''}<dt>Source</dt><dd>${esc(g.source)}</dd></dl>`).join('<hr>')
      : '<p class="muted">No GIS asset is linked to this work order; its location was entered by hand.</p>';

    const nextSteps = wo.workflow.next_steps.map((s) => `<button type="button" data-step="${esc(s.key)}">Move to "${esc(s.name)}"</button>`).join('');
    const editing = done ? '<p class="muted">Completed work orders cannot be changed.</p>' : `
      <form id="edit-form">
        <label for="e-priority">Priority</label>
        <select id="e-priority">${PRIORITIES.map((p) => `<option ${wo.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
        <label for="e-description">Description</label>
        <textarea id="e-description">${esc(wo.description ?? '')}</textarea>
        <div class="actions"><button class="primary" type="submit">Save changes</button></div>
      </form>
      <label for="e-assignee">Assignee</label>
      <div class="toolbar"><select id="e-assignee"><option value="">Unassigned</option>${users.body.items.map((u) => `<option value="${esc(u.id)}" ${wo.assignee?.id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <button type="button" id="assign">Assign</button></div>
      ${nextSteps ? `<label>Workflow</label><div class="actions">${nextSteps}</div>` : ''}
      ${wo.workflow.can_complete ? `<label for="e-note">Completion note (what was done)</label><textarea id="e-note"></textarea>
        <div class="actions"><button type="button" id="complete">Complete work order</button></div>` : ''}`;

    mount('work-orders', `<p><a href="#/work-orders">← Work orders</a></p>
      <h1>${esc(wo.title)}</h1>
      <p class="sub"><span class="pill ${esc(wo.status)}">${esc(wo.status)}</span> · ${esc(wo.workflow.workflow_name)}: ${esc(wo.workflow.current_step_name)} · version ${esc(wo.version)}</p>
      <div id="notice">${notice ?? ''}</div>
      <div class="grid2">
        <div class="stack">
          <section class="card"><h2>Details</h2><dl class="facts">
            <dt>Type</dt><dd>${esc(wo.work_type)}</dd><dt>Priority</dt><dd>${esc(wo.priority)}</dd>
            <dt>Assignee</dt><dd>${wo.assignee ? esc(wo.assignee.name) : '<span class="muted">Unassigned</span>'}</dd>
            <dt>Location</dt><dd>${esc(wo.location.address ?? wo.location.text ?? '—')}</dd>
            <dt>Description</dt><dd>${esc(wo.description ?? '—')}</dd>
            <dt>Created</dt><dd>${esc(when(wo.created_at))} by ${esc(wo.created_by)}</dd>
            ${done ? `<dt>Completed</dt><dd>${esc(when(wo.completed_at))}: ${esc(wo.completion_note)}</dd>` : ''}
          </dl></section>
          <section class="card"><h2>Change</h2>${editing}</section>
        </div>
        <div class="stack">
          ${intake ? `<section class="card"><h2>From AI intake</h2><dl class="facts">
            <dt>Drafted by</dt><dd>${esc(intake.drafted_by)}</dd>
            <dt>Approved by</dt><dd><strong>${esc(intake.approved_by?.name ?? '—')}</strong> on ${esc(when(intake.approved_at))}</dd>
            <dt>Changed by the approver</dt><dd>${intake.changed_from_proposal.length ? esc(intake.changed_from_proposal.join(', ')) : 'nothing: approved as drafted'}</dd>
          </dl><p><a href="#/intake/${esc(intake.draft_id)}">See the draft and the agent's proposal</a></p></section>` : ''}
          <section class="card"><h2>GIS record</h2>${gisBanner}${gisPanel}</section>
          <section class="card"><h2>History</h2><ol class="history">${history.map((h) => `<li>${esc(h.what)}<br><span class="when">${esc(when(h.at))} · ${esc(h.by)}</span></li>`).join('')}</ol></section>
        </div>
      </div>`);

    const say = (html) => { document.getElementById('notice').innerHTML = html; markLayout(); };
    /** Send one change; handles an expired session (sign in, then retry) and a stale copy (412). */
    const change = async (method, path, body, success) => {
      const attempt = async () => {
        try {
          const r = await api(method, path, { body, etag });
          if (r.status === 412) {
            say(`<p class="banner bad">Someone changed this work order after you opened it, so nothing was saved. Your edit is still below; reload to see their change, then save again. <button type="button" id="reload">Reload</button></p>`);
            document.getElementById('reload').addEventListener('click', () => renderDetail(id));
            return;
          }
          if (r.status >= 400) return say(`<p class="banner bad">${esc(r.body?.message ?? 'Not saved.')}${r.body?.problems ? ` ${esc(r.body.problems.join('; '))}` : ''}</p>`);
          etag = r.etag;
          renderDetail(id, `<p class="banner good">${esc(success)}</p>`);
        } catch (err) {
          if (err instanceof SessionExpired) return signInAgain(attempt);
          say(`<p class="banner bad">The system could not be reached, so nothing was saved. Your edit is still here; try again.</p>`);
        }
      };
      await attempt();
    };
    if (done) return;
    const base = `/work-orders/${encodeURIComponent(id)}`;
    document.getElementById('edit-form').addEventListener('submit', (e) => {
      e.preventDefault();
      change('PATCH', base, { priority: document.getElementById('e-priority').value, description: document.getElementById('e-description').value }, 'Changes saved.');
    });
    document.getElementById('assign').addEventListener('click', () => {
      const v = document.getElementById('e-assignee').value;
      change('POST', `${base}/assign`, { assignee_user_id: v || null }, v ? 'Assigned.' : 'Unassigned.');
    });
    document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => change('POST', `${base}/transition`, { to: b.dataset.step }, 'Moved to the next step.')));
    document.getElementById('complete')?.addEventListener('click', () => change('POST', `${base}/complete`, { note: document.getElementById('e-note').value }, 'Work order completed.'));
  }


  // ---------- AI intake (STORY-015): the agent drafts, a person approves ----------
  const FIELD_LABELS = { title: 'Title', work_type: 'Work type', priority: 'Priority', location_text: 'Location', description: 'Description' };
  const EDITABLE = Object.keys(FIELD_LABELS);
  const STATUS_TABS = [['proposed', 'Waiting for approval'], ['approved', 'Approved'], ['rejected', 'Rejected']];

  async function renderIntakeQueue(params) {
    const status = STATUS_TABS.some(([s]) => s === params.status) ? params.status : 'proposed';
    mount('intake', '<p class="muted">Loading the intake queue…</p>');
    const res = await api('GET', `/intake/drafts?status=${status}`);
    if (res.status !== 200) return mount('intake', `<p class="banner bad">${esc(res.body?.message ?? 'The queue could not be loaded.')}</p>`);
    const items = res.body.items;
    const tabs = `<div class="toolbar">${STATUS_TABS.map(([s, label]) => `<a class="tab ${s === status ? 'active' : ''}" href="#/intake?status=${s}">${esc(label)}</a>`).join('')}
      <span class="spacer"></span><span class="muted">${items.length} item${items.length === 1 ? '' : 's'}</span></div>`;
    const empty = `<div class="card empty"><h2>${status === 'proposed' ? 'Nothing waiting for approval' : `Nothing ${status} yet`}</h2>
      <p>Citizen requests and Blue Stakes tickets appear here as drafts as soon as they arrive.</p></div>`;
    const decided = status !== 'proposed';
    const table = `<table class="queue">
      <thead><tr><th class="q-source">Source</th><th class="q-draft">Drafted work order</th><th class="q-needs">${decided ? 'Decision' : 'Needs'}</th>
        <th class="q-who">Performs the work</th><th class="q-who">${decided ? 'Decided by' : 'Must approve'}</th><th class="q-when">Drafted</th></tr></thead>
      <tbody>${items.map((d) => {
        const f = d.final ?? d.proposed;
        const needs = decided
          ? `<span class="pill ${d.status === 'approved' ? 'completed' : 'open'}">${esc(d.status)}</span>`
          : (d.missing.length ? d.missing.map((m) => `<span class="pill attention">${esc(FIELD_LABELS[m] ?? m)} needed</span>`).join(' ') : '<span class="pill completed">Ready</span>');
        const approver = decided ? esc(d.reviewed_by_name ?? '—') : `${esc(d.approver_label)}<br><span class="muted">or ${esc(d.who_can_approve.filter((r) => r !== d.approver_label).join(', '))}</span>`;
        return `<tr data-id="${esc(d.id)}" tabindex="0">
          <td>${esc(d.source.kind)}<br><span class="muted">${esc(d.source.reference)}</span></td>
          <td title="${esc(f.title ?? '')}">${esc(f.title ?? 'Untitled')}<br><span class="muted">${esc(f.work_type ?? 'type not determined')} · ${esc(f.priority)}</span></td>
          <td>${needs}</td>
          <td>${esc(d.performer_label)}</td>
          <td>${approver}</td>
          <td>${esc(day(d.drafted_at))}</td></tr>`;
      }).join('')}</tbody></table>`;
    mount('intake', `<h1>AI intake</h1>
      <p class="sub">The intake agent drafts a work order from each citizen request and Blue Stakes ticket. Nothing reaches the work order list until a named person approves it.</p>
      ${tabs}${items.length ? table : empty}`);
    document.querySelectorAll('tbody tr').forEach((tr) => {
      const open = () => { location.hash = `#/intake/${tr.dataset.id}`; };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  async function renderDraft(id, notice) {
    mount('intake', '<p class="muted">Loading the draft…</p>');
    const res = await api('GET', `/intake/drafts/${encodeURIComponent(id)}`);
    if (res.status !== 200) return mount('intake', `<p><a href="#/intake">← AI intake</a></p><p class="banner bad">${esc(res.body?.message ?? 'Not found.')}</p>`);
    const d = res.body.item;
    const etag = res.etag;
    const open = d.status === 'proposed';
    const mine = d.final ?? d.proposed;
    const why = Object.fromEntries(d.undetermined.map((u) => [u.field, u.reason]));

    const decision = {
      approved: `<p class="banner good">Approved by <strong>${esc(d.reviewed_by_name)}</strong> on ${esc(when(d.reviewed_at))}. <a href="#/work-orders/${esc(d.work_order_id)}">Open the work order</a></p>`,
      rejected: `<p class="banner warn">Rejected by <strong>${esc(d.reviewed_by_name)}</strong> on ${esc(when(d.reviewed_at))}: ${esc(d.review_note)}</p>`,
      superseded: '<p class="banner warn">This draft was replaced by a newer one because its source changed. It is kept for the record; open the newer draft from the queue.</p>',
      approving: '<p class="banner warn">Someone is approving this draft right now.</p>',
    }[d.status] ?? '';
    const input = (f) => {
      const v = mine[f] ?? '';
      if (f === 'priority') return `<select data-field="priority">${PRIORITIES.map((p) => `<option ${v === p ? 'selected' : ''}>${p}</option>`).join('')}</select>`;
      if (f === 'description') return `<textarea data-field="description">${esc(v)}</textarea>`;
      return `<input data-field="${f}" value="${esc(v)}" class="wide">`;
    };
    const rows = EDITABLE.map((f) => `<tr class="${why[f] ? 'undetermined' : ''}">
      <th scope="row">${esc(FIELD_LABELS[f])}${d.missing.includes(f) ? '<br><span class="pill attention">needed</span>' : ''}</th>
      <td>${d.proposed[f] ? esc(d.proposed[f]) : '<span class="muted">— not determined</span>'}${why[f] ? `<br><span class="field-reason">${esc(why[f])}</span>` : ''}</td>
      <td>${open ? input(f) : esc(mine[f] ?? '—')}</td></tr>`).join('');

    mount('intake', `<p><a href="#/intake">← AI intake</a></p>
      <h1>${esc(d.source.kind)} ${esc(d.source.reference)}</h1>
      <p class="sub"><span class="pill ${d.status === 'approved' ? 'completed' : 'open'}">${esc(d.status)}</span> · drafted by ${esc(d.drafted_by)} on ${esc(when(d.drafted_at))}</p>
      <div id="notice">${notice ?? ''}</div>${decision}
      <div class="grid2">
        <div class="stack">
          <section class="card"><h2>The agent's proposal, and your version</h2>
            <p class="muted">The proposal on the left is kept as it was. What you approve is the version on the right.</p>
            <table class="compare"><thead><tr><th class="c-field">Field</th><th class="c-proposed">Agent proposed</th><th class="c-mine">${open ? 'Your version' : 'Saved version'}</th></tr></thead>
              <tbody>${rows}</tbody></table>
            ${open ? `<div class="actions"><button class="primary" type="button" id="approve">Approve and create the work order</button>
              <button type="button" id="save">Save correction</button></div>
              <label for="reason">Reject, with the reason (kept internally)</label><textarea id="reason"></textarea>
              <div class="actions"><button type="button" id="reject">Reject</button></div>` : ''}
          </section>
        </div>
        <div class="stack">
          <section class="card"><h2>Who</h2><dl class="facts">
            <dt>Performs the work</dt><dd>${esc(d.performer_label)}</dd>
            <dt>Must approve</dt><dd>${esc(d.approver_label)} <span class="muted">(${esc(d.who_can_approve.join(', '))} can approve)</span></dd>
            <dt>Drafted by</dt><dd>${esc(d.drafted_by)}</dd>
            ${d.reviewed_by_name ? `<dt>Decided by</dt><dd>${esc(d.reviewed_by_name)}</dd>` : ''}
          </dl></section>
          <section class="card"><h2>Source</h2><dl class="facts">
            <dt>${esc(d.source.kind)}</dt><dd>${esc(d.source.reference)}</dd>
            <dt>Says</dt><dd>${esc(d.source.text)}</dd>
            <dt>Category</dt><dd>${esc(d.source.category)}</dd>
            <dt>Location</dt><dd>${esc(d.source.location)}</dd>
            <dt>Received</dt><dd>${esc(when(d.source.received_at))}</dd>
            ${d.source.due_at ? `<dt>Answer due</dt><dd>${esc(when(d.source.due_at))}</dd>` : ''}
          </dl><p class="muted">Contact details are never shown to the agent or here.</p></section>
        </div>
      </div>`);
    if (!open) return;

    const say = (html) => { document.getElementById('notice').innerHTML = html; markLayout(); };
    const yourVersion = () => Object.fromEntries([...document.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value.trim() || null]));
    const act = async (path, body, onDone) => {
      const attempt = async () => {
        try {
          const r = await api('POST', `/intake/drafts/${encodeURIComponent(id)}/${path}`, { body, etag });
          if (r.status === 412) return say('<p class="banner bad">Someone changed this draft after you opened it, so nothing was saved. <a href="" id="reload">Reload it</a> to see their change.</p>');
          if (r.status === 409 && r.body?.error === 'source_changed') {
            say(`<p class="banner bad">${esc(r.body.message)} <button type="button" id="redraft">Re-draft from the source</button></p>`);
            document.getElementById('redraft').addEventListener('click', async () => {
              const again = await api('POST', `/intake/drafts/${encodeURIComponent(id)}/redraft`, { body: {} });
              location.hash = `#/intake/${again.body.item.id}`;
            });
            return;
          }
          if (r.status >= 400) return say(`<p class="banner bad">${esc(r.body?.message ?? 'Not saved.')}${r.body?.problems ? ` ${esc(r.body.problems.join('; '))}` : ''}</p>`);
          onDone(r.body);
        } catch (err) {
          if (err instanceof SessionExpired) return signInAgain(attempt);
          say('<p class="banner bad">The system could not be reached, so nothing was saved. Your version is still here; try again.</p>');
        }
      };
      await attempt();
    };
    document.getElementById('approve').addEventListener('click', () => act('approve', { changes: yourVersion() }, (b) => {
      location.hash = `#/work-orders/${b.work_order_id}`;
    }));
    document.getElementById('save').addEventListener('click', () => act('correct', { changes: yourVersion() }, () => renderDraft(id, '<p class="banner good">Your correction is saved. The agent\'s proposal is kept as it was.</p>')));
    document.getElementById('reject').addEventListener('click', () => act('reject', { reason: document.getElementById('reason').value }, () => renderDraft(id)));
  }


  // ---------- map and heat map (STORY-016) ----------
  // Positions come only from /console/map, which places work orders exactly as the heat map does; this
  // code projects them onto the screen and never decides where a work order is. No street layer: a
  // basemap needs an outside map service the city has not provided, so the map is drawn on a grid.
  const MAP_W = 900;
  const MAP_H = 560;
  const PAD = 34;
  const NICE_DEGREES = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const NICE_METRES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

  /** An equirectangular projection fitted to the points and cells, keeping east-west distances true at the middle latitude. */
  function projection(lats, lngs) {
    let [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
    const spread = Math.max(maxLat - minLat, maxLng - minLng, 0.004);
    minLat -= spread * 0.08; maxLat += spread * 0.08; minLng -= spread * 0.08; maxLng += spread * 0.08;
    const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const scale = Math.min((MAP_W - 2 * PAD) / ((maxLng - minLng) * k), (MAP_H - 2 * PAD) / (maxLat - minLat));
    const offX = (MAP_W - (maxLng - minLng) * k * scale) / 2;
    const offY = (MAP_H - (maxLat - minLat) * scale) / 2;
    return {
      x: (lng) => offX + (lng - minLng) * k * scale,
      y: (lat) => offY + (maxLat - lat) * scale,
      bounds: { minLat, maxLat, minLng, maxLng },
      metresPerPixel: 111320 / scale,
    };
  }

  function gridAndScale(p) {
    const { minLat, maxLat, minLng, maxLng } = p.bounds;
    const step = NICE_DEGREES.find((s) => (maxLat - minLat) / s <= 8) ?? 1;
    const lines = [];
    for (let lat = Math.ceil(minLat / step) * step; lat <= maxLat; lat += step) {
      lines.push(`<line class="grid" x1="0" x2="${MAP_W}" y1="${p.y(lat).toFixed(1)}" y2="${p.y(lat).toFixed(1)}"/><text class="grid-label" x="4" y="${(p.y(lat) - 3).toFixed(1)}">${lat.toFixed(4)}°</text>`);
    }
    for (let lng = Math.ceil(minLng / step) * step; lng <= maxLng; lng += step) {
      lines.push(`<line class="grid" y1="0" y2="${MAP_H}" x1="${p.x(lng).toFixed(1)}" x2="${p.x(lng).toFixed(1)}"/><text class="grid-label" y="${MAP_H - 4}" x="${(p.x(lng) + 3).toFixed(1)}">${lng.toFixed(4)}°</text>`);
    }
    const metres = NICE_METRES.filter((m) => m / p.metresPerPixel <= 160).pop() ?? NICE_METRES[0];
    const px = metres / p.metresPerPixel;
    const x0 = MAP_W - px - 16;
    lines.push(`<rect class="scale-bg" x="${(x0 - 8).toFixed(1)}" y="${MAP_H - 44}" width="${(px + 16).toFixed(1)}" height="30" rx="6"/>
      <line class="scale" x1="${x0.toFixed(1)}" x2="${(x0 + px).toFixed(1)}" y1="${MAP_H - 22}" y2="${MAP_H - 22}"/>
      <text class="scale-label" x="${(x0 + px / 2).toFixed(1)}" y="${MAP_H - 28}" text-anchor="middle">${metres >= 1000 ? `${metres / 1000} km` : `${metres} m`}</text>`);
    return lines.join('');
  }

  async function renderMap(params) {
    mount('map', '<p class="muted">Loading the map…</p>');
    if (!me?.permissions) {
      const who = await api('GET', '/console/me');
      if (who.status === 200) { me = who.body; store.set('hwo.me', JSON.stringify(me)); }
    }
    const canHeat = me?.permissions?.includes('heatmaps:read');
    const filters = Object.fromEntries(['from', 'to', 'status', 'work_types'].map((k) => [k, params[k] ?? '']).filter(([, v]) => v));
    const qs = new URLSearchParams(filters);
    const showHeat = canHeat && params.heat === '1';
    const [res, heat] = await Promise.all([
      api('GET', `/console/map?${qs}`),
      showHeat ? api('GET', `/heat-maps?${qs}`) : Promise.resolve(null),
    ]);
    if (res.status !== 200) return mount('map', `<h1>Map</h1><p class="banner bad">${esc(res.body?.problems?.join('; ') ?? res.body?.message ?? 'The map could not be loaded.')}</p>`);
    const m = res.body;
    const cells = heat?.status === 200 ? heat.body.features : [];

    const lats = [...m.points.map((pt) => pt.lat), ...cells.flatMap((c) => c.geometry.coordinates[0].map((xy) => xy[1]))];
    const lngs = [...m.points.map((pt) => pt.lng), ...cells.flatMap((c) => c.geometry.coordinates[0].map((xy) => xy[0]))];
    let svg = '';
    if (lats.length) {
      const p = projection(lats, lngs);
      const shade = (share) => Math.min(5, Math.max(1, Math.ceil(share * 5)));
      const heatLayer = cells.map((c) => {
        const ring = c.geometry.coordinates[0].map(([lng, lat]) => `${p.x(lng).toFixed(1)},${p.y(lat).toFixed(1)}`).join(' ');
        return `<polygon class="heat-cell heat-${shade(c.properties.share)}" points="${ring}"><title>${c.properties.count} work order${c.properties.count === 1 ? '' : 's'} in this cell</title></polygon>`;
      }).join('');
      const dots = m.points.map((pt) => {
        const cls = ['pt', `pt-${pt.status}`, pt.position_from === 'citizen map pin' ? 'pt-pin' : ''].join(' ');
        const ring = pt.gis_check === 'differs' ? `<circle class="pt-differs" cx="${p.x(pt.lng).toFixed(1)}" cy="${p.y(pt.lat).toFixed(1)}" r="11"/>` : '';
        const note = pt.gis_check === 'differs' ? ' · GIS differs from the stored record (sync pending)' : pt.gis_check === 'matches' ? ' · confirmed by GIS' : '';
        return `<a href="#/work-orders/${esc(pt.id)}">${ring}<circle class="${cls}" cx="${p.x(pt.lng).toFixed(1)}" cy="${p.y(pt.lat).toFixed(1)}" r="6"><title>${esc(pt.title)} (${esc(pt.status)}) · ${esc(pt.position_from)}${note}</title></circle></a>`;
      }).join('');
      svg = `<svg class="map" viewBox="0 0 ${MAP_W} ${MAP_H}" role="img" aria-label="Work orders plotted at their coordinates">
        <rect class="map-bg" width="${MAP_W}" height="${MAP_H}"/>${gridAndScale(p)}${heatLayer}${dots}</svg>`;
    }

    const range = [filters.from && `from ${filters.from}`, filters.to && `before ${filters.to}`].filter(Boolean).join(' and ');
    const gisBanner = {
      unavailable: '<p class="banner warn">GIS is unavailable right now, so positions could not be confirmed against it. Every work order is still shown, from its stored record.</p>',
      not_connected: '<p class="banner warn">GIS is not connected; positions are shown from the stored records.</p>',
    }[m.gis_status] ?? '';
    const differs = m.points.filter((pt) => pt.gis_check === 'differs');
    const filterBar = `<form class="toolbar" id="map-filters">
      <label class="muted inline-label" for="m-from">Created from</label><input type="date" id="m-from" value="${esc(filters.from ?? '')}">
      <label class="muted inline-label" for="m-to">before</label><input type="date" id="m-to" value="${esc(filters.to ?? '')}">
      <label class="muted inline-label" for="m-status">Status</label>
      <select id="m-status">${['all', 'open', 'completed'].map((s) => `<option ${(filters.status ?? 'all') === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label class="muted inline-label" for="m-types">Work types</label><input id="m-types" placeholder="e.g. pothole,streetlight" value="${esc(filters.work_types ?? '')}">
      ${canHeat ? `<label class="inline-label check"><input type="checkbox" id="m-heat" ${showHeat ? 'checked' : ''}> Heat map</label>` : ''}
      <button type="submit">Show</button></form>`;
    const body = m.empty
      ? `<div class="card empty"><h2>No work orders ${range ? `created ${esc(range)}` : 'yet'}</h2><p>Choose a wider date range, or clear the filters.</p></div>`
      : `<div class="grid2 map-grid">
          <section class="card">${svg || '<p class="muted">None of these work orders has coordinates to plot.</p>'}
            <p class="legend"><span class="key pt-open"></span> open <span class="key pt-completed"></span> completed <span class="key pt-pin"></span> placed by the citizen's map pin
              ${differs.length ? '<span class="key pt-differs-key"></span> GIS differs (sync pending)' : ''}</p>
            ${showHeat ? '<p class="legend">Shaded squares: the heat map, darker where more work orders are concentrated.</p>' : ''}
            <p class="muted">Drawn on a coordinate grid: no street layer, because a basemap needs a map service the city has not provided. The same data opens on the city's own GIS map as GeoJSON.</p>
          </section>
          <div class="stack">
            <section class="card"><h2>On this map</h2><dl class="facts">
              <dt>Plotted</dt><dd>${m.points.length}${m.truncated ? ' (first 5,000)' : ''}</dd>
              <dt>Not on the map</dt><dd>${m.unplaced.length}</dd>
              <dt>GIS check</dt><dd>${esc({ live: 'confirmed against GIS', unavailable: 'GIS unavailable', not_connected: 'GIS not connected', no_assets: 'no GIS assets linked' }[m.gis_status] ?? m.gis_status)}</dd>
              ${showHeat && heat?.status !== 200 ? `<dt>Heat map</dt><dd>${esc(heat?.body?.message ?? 'not available')}</dd>` : ''}
            </dl></section>
            ${differs.length ? `<section class="card"><h2>GIS differs</h2><ol class="history">${differs.map((pt) => `<li><a href="#/work-orders/${esc(pt.id)}">${esc(pt.title)}</a><br><span class="when">Stored ${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)} · GIS now ${pt.gis_location.lat.toFixed(5)}, ${pt.gis_location.lng.toFixed(5)}</span></li>`).join('')}</ol></section>` : ''}
            <section class="card"><h2>Not on the map</h2>${m.unplaced.length
              ? `<ol class="history">${m.unplaced.slice(0, 12).map((u) => `<li><a href="#/work-orders/${esc(u.id)}">${esc(u.title)}</a><br><span class="when">${esc(u.location ?? 'no location')} · ${esc(u.reason)}</span></li>`).join('')}</ol>${m.unplaced.length > 12 ? `<p class="muted">and ${m.unplaced.length - 12} more</p>` : ''}`
              : '<p class="muted">Every work order here has coordinates.</p>'}</section>
          </div>
        </div>`;

    mount('map', `<h1>Map</h1><p class="sub">Where work orders are, placed exactly as the heat map places them${range ? `, created ${esc(range)}` : ''}.</p>${filterBar}${gisBanner}${body}`);
    document.getElementById('map-filters').addEventListener('submit', (e) => {
      e.preventDefault();
      const next = {
        from: document.getElementById('m-from').value, to: document.getElementById('m-to').value,
        status: document.getElementById('m-status').value === 'all' ? '' : document.getElementById('m-status').value,
        work_types: document.getElementById('m-types').value.replace(/\s+/g, ''),
        heat: document.getElementById('m-heat')?.checked ? '1' : '',
      };
      location.hash = `#/map?${new URLSearchParams(Object.entries(next).filter(([, v]) => v))}`;
    });
  }


  // ---------- administration (STORY-017) ----------
  // Screens over the access, settings and audit APIs (STORY-007, STORY-008). There are no permission
  // rules here: every read and change goes to the same API with the signed-in person's session, so the
  // console can never grant what the API would refuse, and every refusal is recorded by the API itself.
  const ADMIN_TABS = [
    ['users', 'Users', 'access:admin'], ['roles', 'Roles', 'access:admin'],
    ['settings', 'Settings', 'settings:admin'], ['audit', 'Audit trail', 'audit:read'],
  ];
  const AUDIT_TYPES = ['', 'work_order', 'user', 'user_role', 'role', 'setting', 'intake_draft', 'workflow', 'readiness_item', 'readiness_assessment', 'vendor_coordination', 'api_access', 'console_session'];

  function adminShell(tab, content) {
    const tabs = ADMIN_TABS.map(([key, label]) => `<a class="tab ${key === tab ? 'active' : ''}" href="#/admin/${key}">${esc(label)}</a>`).join('');
    mount('admin', `<h1>Administration</h1><p class="sub">Users, roles, system settings and the audit trail. Every change goes through the same checks as the API and is recorded.</p>
      <div class="toolbar">${tabs}</div><div id="notice"></div>${content}`);
  }
  const notice = (html) => { document.getElementById('notice').innerHTML = html; markLayout(); };

  /** The API refused: say which permission is needed. The API has already recorded the attempt. */
  function refusedScreen(tab, res) {
    const [, label, permission] = ADMIN_TABS.find(([key]) => key === tab);
    adminShell(tab, `<div class="card empty"><h2>You don't have access to ${esc(label.toLowerCase())}</h2>
      <p>It needs the ${esc(permission)} permission, which your roles do not include. This attempt has been recorded in the audit trail.</p>
      <p class="muted">${esc(res.body?.message ?? '')}</p></div>`);
  }

  /** Send one administration change; handles an expired session (sign in, retry) and shows any refusal in plain words. */
  async function adminChange(method, path, { body, etag, ok, onNotFound } = {}) {
    const attempt = async () => {
      try {
        const r = await api(method, path, { body, etag });
        if (r.status === 404 && onNotFound) return onNotFound(r);
        if (r.status === 412) return notice('<p class="banner bad">This changed since you opened it, so nothing was saved. Reload the page to see the current value.</p>');
        if (r.status >= 400) return notice(`<p class="banner bad">${esc(r.body?.message ?? 'Not saved.')}${r.body?.problems ? ` ${esc(r.body.problems.join('; '))}` : ''}</p>`);
        return ok(r);
      } catch (err) {
        if (err instanceof SessionExpired) return signInAgain(attempt);
        return notice('<p class="banner bad">The system could not be reached, so nothing was changed. Try again.</p>');
      }
    };
    await attempt();
  }

  async function renderAdminUsers(message) {
    adminShell('users', '<p class="muted">Loading users…</p>');
    const [users, roles] = await Promise.all([api('GET', '/users'), api('GET', '/roles')]);
    if (users.status === 403 || users.status === 401) return refusedScreen('users', users);
    if (users.status !== 200) return adminShell('users', `<p class="banner bad">${esc(users.body?.message ?? 'Users could not be loaded.')}</p>`);
    const roleNames = Object.fromEntries((roles.body?.items ?? []).map((r) => [r.id, r.name]));
    const rows = users.body.items.map((u) => `<tr>
      <td>${esc(u.display_name)}<br><span class="muted">${esc(u.email)}</span></td>
      <td><span class="pill ${u.is_active ? 'completed' : 'attention'}">${u.is_active ? 'active' : 'deactivated'}</span></td>
      <td>${u.roles.length ? u.roles.map((r) => `<span class="role-chip">${esc(roleNames[r] ?? r)} <button type="button" class="link-button" data-remove="${esc(u.id)}" data-role="${esc(r)}" aria-label="Remove ${esc(roleNames[r] ?? r)} from ${esc(u.display_name)}">remove</button></span>`).join(' ') : '<span class="muted">no roles: can do nothing</span>'}</td>
      <td><div class="toolbar tight"><select data-grant-select="${esc(u.id)}">${Object.entries(roleNames).filter(([id]) => !u.roles.includes(id)).map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}</select>
        <button type="button" data-grant="${esc(u.id)}">Grant</button></div></td>
      <td><div class="toolbar tight">${u.is_active
        ? `<button type="button" data-deactivate="${esc(u.id)}">Deactivate</button> <button type="button" data-key="${esc(u.id)}">Issue key</button>`
        : `<button type="button" data-reactivate="${esc(u.id)}">Reactivate</button>`}</div></td></tr>`).join('');
    adminShell('users', `<table class="admin-users"><thead><tr><th class="u-name">Person</th><th class="u-status">Status</th><th class="u-roles">Roles</th><th class="u-grant">Grant a role</th><th class="u-actions">Account</th></tr></thead>
      <tbody>${rows}</tbody></table>`);
    if (message) notice(message);

    const gone = () => renderAdminUsers('<p class="banner bad">This user no longer exists, so nothing was changed. The list has been refreshed.</p>');
    const done = (text) => () => renderAdminUsers(`<p class="banner good">${esc(text)}</p>`);
    document.querySelectorAll('[data-grant]').forEach((b) => b.addEventListener('click', () => {
      const roleId = document.querySelector(`[data-grant-select="${b.dataset.grant}"]`).value;
      adminChange('POST', `/users/${encodeURIComponent(b.dataset.grant)}/roles`, { body: { role_id: roleId }, ok: done(`Role granted: ${roleNames[roleId] ?? roleId}.`), onNotFound: gone });
    }));
    document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => adminChange('DELETE',
      `/users/${encodeURIComponent(b.dataset.remove)}/roles/${encodeURIComponent(b.dataset.role)}`, { ok: done(`Role removed: ${roleNames[b.dataset.role] ?? b.dataset.role}.`), onNotFound: gone })));
    document.querySelectorAll('[data-deactivate]').forEach((b) => b.addEventListener('click', () => adminChange('POST',
      `/users/${encodeURIComponent(b.dataset.deactivate)}/deactivate`, { body: {}, ok: done('Deactivated: they are refused from their next request.'), onNotFound: gone })));
    document.querySelectorAll('[data-reactivate]').forEach((b) => b.addEventListener('click', () => adminChange('POST',
      `/users/${encodeURIComponent(b.dataset.reactivate)}/reactivate`, { body: {}, ok: done('Reactivated. Issue them a new key: the old one does not come back.'), onNotFound: gone })));
    document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => adminChange('POST',
      `/users/${encodeURIComponent(b.dataset.key)}/key`, { body: {}, onNotFound: gone, ok: (r) => notice(`<div class="banner warn">New personal key for ${esc(r.body.item.display_name)}. Give it to them now: it is shown once, cannot be shown again, and their old key has stopped working.
        <code class="key-once">${esc(r.body.key)}</code></div>`) })));
  }

  async function renderAdminRoles() {
    adminShell('roles', '<p class="muted">Loading roles…</p>');
    const res = await api('GET', '/roles');
    if (res.status === 403 || res.status === 401) return refusedScreen('roles', res);
    adminShell('roles', `<table class="admin-roles"><thead><tr><th class="r-name">Role</th><th class="r-desc">What it is for</th><th class="r-perms">Permissions</th></tr></thead><tbody>
      ${res.body.items.map((r) => `<tr><td>${esc(r.name)}<br><span class="muted">${r.builtin ? 'built in' : "the city's own"}</span></td><td>${esc(r.description)}</td>
        <td>${r.permissions.map((p) => `<span class="pill open">${esc(p)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table>
      <p class="muted">Built-in roles cannot be changed. Roles the city defines are managed through the roles API (STORY-008).</p>`);
  }

  async function renderAdminSettings(message) {
    adminShell('settings', '<p class="muted">Loading settings…</p>');
    const res = await api('GET', '/settings');
    if (res.status === 403 || res.status === 401) return refusedScreen('settings', res);
    adminShell('settings', `<table class="admin-settings"><thead><tr><th class="s-name">Setting</th><th class="s-value">Value</th><th class="s-default">Default and range</th><th class="s-changed">Last changed</th><th class="s-actions"></th></tr></thead><tbody>
      ${res.body.items.map((s) => `<tr>
        <td>${esc(s.key)}<br><span class="muted">${esc(s.description)}</span>${s.problem ? `<br><span class="field-reason">${esc(s.problem)}</span>` : ''}</td>
        <td><input type="number" class="wide" data-setting="${esc(s.key)}" value="${esc(s.value)}" min="${esc(s.min)}" max="${esc(s.max)}"></td>
        <td>${esc(s.default)}<br><span class="muted">${esc(s.min)} to ${esc(s.max)}</span></td>
        <td>${s.is_default ? '<span class="muted">never: the default</span>' : esc(when(s.updated_at))}<br><span class="muted">version ${esc(s.version)}</span></td>
        <td><div class="toolbar tight"><button type="button" data-save="${esc(s.key)}" data-version="${esc(s.version)}">Save</button>
          ${s.is_default ? '' : `<button type="button" data-reset="${esc(s.key)}" data-version="${esc(s.version)}">Reset</button>`}</div></td></tr>`).join('')}</tbody></table>`);
    if (message) notice(message);
    document.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
      const raw = document.querySelector(`[data-setting="${b.dataset.save}"]`).value;
      const value = raw.trim() === '' ? null : Number(raw);
      adminChange('PUT', `/settings/${encodeURIComponent(b.dataset.save)}`, {
        body: { value }, etag: `"v${b.dataset.version}"`,
        ok: (r) => renderAdminSettings(`<p class="banner good">${r.body.changed ? `Saved: ${esc(b.dataset.save)} is now ${esc(r.body.item.value)}. It applies from the next request.` : 'Already that value: nothing changed.'}</p>`),
      });
    }));
    document.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => adminChange('DELETE', `/settings/${encodeURIComponent(b.dataset.reset)}`, {
      etag: `"v${b.dataset.version}"`, ok: () => renderAdminSettings(`<p class="banner good">${esc(b.dataset.reset)} is back to its default.</p>`),
    })));
  }

  /** The fields that changed between before and after, as short "field: value" text for each side. */
  function auditChange(before, after) {
    const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (!before && !after) return ['—', '—'];
    if (!before || typeof before !== 'object') return ['—', Object.entries(after ?? {}).slice(0, 4).map(([k, v]) => `${k}: ${show(v)}`).join('; ')];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])].filter((k) => show(before[k]) !== show(after?.[k]) && !['version', 'updated_at'].includes(k));
    const side = (o) => keys.slice(0, 4).map((k) => `${k}: ${show(o?.[k])}`).join('; ') || '—';
    return [side(before), side(after)];
  }

  async function renderAdminAudit(params) {
    adminShell('audit', '<p class="muted">Loading the audit trail…</p>');
    const filters = Object.fromEntries(['entity_type', 'action', 'from', 'to', 'cursor'].map((k) => [k, params[k] ?? '']).filter(([, v]) => v));
    const res = await api('GET', `/audit?${new URLSearchParams({ ...filters, limit: '25' })}`);
    if (res.status === 403 || res.status === 401) return refusedScreen('audit', res);
    if (res.status !== 200) return adminShell('audit', `<p class="banner bad">${esc(res.body?.problems?.join('; ') ?? res.body?.message ?? 'The audit trail could not be loaded.')}</p>`);
    const items = res.body.items;
    const short = (v, n = 90) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
    const rows = items.map((e) => {
      const [was, now] = auditChange(e.before, e.after);
      return `<tr><td>${esc(when(e.occurred_at))}</td><td title="${esc(e.actor)}">${esc(e.actor)}</td>
        <td>${esc(e.entity_type.replace(/_/g, ' '))}: <strong>${esc(e.action.replace(/_/g, ' '))}</strong><br><span class="muted">${esc(short(e.entity_id, 40))}</span></td>
        <td title="${esc(was)}">${esc(short(was))}</td><td title="${esc(now)}">${esc(short(now))}</td></tr>`;
    }).join('');
    const filterBar = `<form class="toolbar" id="audit-filters">
      <label class="muted inline-label" for="a-type">Type</label><select id="a-type">${AUDIT_TYPES.map((t) => `<option value="${t}" ${filters.entity_type === t ? 'selected' : ''}>${t ? t.replace(/_/g, ' ') : 'all'}</option>`).join('')}</select>
      <label class="muted inline-label" for="a-action">Action</label><input id="a-action" value="${esc(filters.action ?? '')}" placeholder="e.g. grant">
      <label class="muted inline-label" for="a-from">From</label><input type="date" id="a-from" value="${esc(filters.from ?? '')}">
      <label class="muted inline-label" for="a-to">before</label><input type="date" id="a-to" value="${esc(filters.to ?? '')}">
      <button type="submit">Show</button></form>`;
    adminShell('audit', `${filterBar}${items.length ? `<table class="admin-audit"><thead><tr><th class="a-when">When</th><th class="a-actor">Actor</th><th class="a-what">What</th><th class="a-prev">Previous value</th><th class="a-new">New value</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="toolbar pager"><button type="button" id="a-first" ${filters.cursor ? '' : 'disabled'}>First page</button>
        <button type="button" id="a-next" ${res.body.next_cursor ? '' : 'disabled'}>Next page</button><span class="muted">Oldest first, 25 per page. Reading the audit trail is itself recorded.</span></div>`
      : '<div class="card empty"><h2>No audit entries match</h2><p>Try a different type, action or date range.</p></div>'}`);
    const go = (p) => { location.hash = `#/admin/audit?${new URLSearchParams(Object.entries(p).filter(([, v]) => v))}`; };
    document.getElementById('audit-filters').addEventListener('submit', (e) => {
      e.preventDefault();
      go({ entity_type: document.getElementById('a-type').value, action: document.getElementById('a-action').value.trim(), from: document.getElementById('a-from').value, to: document.getElementById('a-to').value });
    });
    document.getElementById('a-next')?.addEventListener('click', () => go({ ...filters, cursor: res.body.next_cursor }));
    document.getElementById('a-first')?.addEventListener('click', () => go({ ...filters, cursor: '' }));
  }

  // ---------- integrations and operational readiness (STORY-018) ----------
  // One screen a reviewer can be shown: each external connection with its status and last successful
  // call, and the go-live readiness checks with the evidence behind each. The API works every status out
  // from the call records when the screen loads; nothing on this screen is a stored flag.
  const STATUS_PILL = { healthy: ['completed', 'healthy'], failing: ['bad', 'failing'], never_called: ['open', 'never called'] };
  const ERROR_CLASS = {
    timeout: 'timed out', unauthorized: 'credential refused', error: 'call failed', unexpected_payload: 'answered, but with an unexpected shape',
    mismatch: 'records broke the vendor contract', denied: 'access refused', invalid: 'bad request',
  };
  const CONNECTION = { stand_in: 'Stand-in, not the real service', live: 'Live service', 'not declared': 'Not declared' };
  const RESULT_PILL = { pass: ['completed', 'pass'], fail: ['bad', 'fail'], no_evidence: ['attention', 'no evidence'], not_run: ['open', 'not run'] };

  function integrationRow(i) {
    const [cls, label] = STATUS_PILL[i.status] ?? ['open', i.status];
    let details = `<span class="muted">No call on record yet, so there is no last successful call.</span>`;
    if (i.status === 'failing') {
      details = `<strong>${esc(ERROR_CLASS[i.error_class] ?? i.error_class)}</strong> <span class="muted">(${esc(i.error_class)})</span>
        <br>Failing since ${esc(when(i.failing_since))}${i.error ? `<br><span class="muted">${esc(i.error)}</span>` : ''}`;
    } else if (i.status === 'healthy') {
      details = `Last call ${esc(when(i.last_call_at))}<br><span class="muted">${esc(i.calls_on_record)} call(s) on record</span>`;
    }
    return `<tr>
      <td><strong>${esc(i.vendor)}</strong><br><span class="muted">${esc(i.purpose)}</span></td>
      <td>${esc(CONNECTION[i.connection] ?? i.connection)}</td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td>${i.last_success_at ? esc(when(i.last_success_at)) : '<span class="muted">never</span>'}</td>
      <td>${details}</td>
      <td>${i.checkable ? `<button type="button" data-check="${esc(i.name)}">Check now</button>` : '<span class="muted">from its real calls</span>'}</td></tr>`;
  }

  function readinessRow(c) {
    const [cls, label] = RESULT_PILL[c.result] ?? ['open', c.result];
    return `<tr><td>${esc(c.title)}<br><span class="muted">${esc(c.category.replace(/_/g, ' '))} · ${c.kind === 'manual' ? 'recorded by a reviewer' : 'checked by the system'}</span></td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td>${c.result === 'no_evidence' ? `<strong>No evidence recorded.</strong> <span class="muted">Marked ${esc(c.recorded_status ?? 'passed')}, but nothing says what shows it.</span>` : esc(c.evidence)}</td>
      <td>${c.checked_at ? esc(when(c.checked_at)) : '<span class="muted">never</span>'}</td></tr>`;
  }

  async function renderIntegrations(message) {
    mount('integrations', '<p class="muted">Loading connections and readiness…</p>');
    const res = await api('GET', '/console/integrations');
    if (res.status === 403 || res.status === 401) {
      return mount('integrations', `<div class="card empty"><h2>You don't have access to integrations and readiness</h2>
        <p>It needs the readiness:review permission (project managers and administrators). This attempt has been recorded in the audit trail.</p>
        <p class="muted">${esc(res.body?.message ?? '')}</p></div>`);
    }
    if (res.status !== 200) return mount('integrations', `<p class="banner bad">${esc(res.body?.message ?? 'The connections could not be loaded.')}</p>`);
    const { items, readiness, generated_at: at } = res.body;
    const a = readiness.assessment;
    const s = readiness.summary;
    mount('integrations', `<h1>Integrations &amp; readiness</h1>
      <p class="sub">Each connection's status is worked out from its call records when this page loads (${esc(when(at))}); none of it is a stored flag. Reload to see the latest.</p>
      <div id="notice"></div>
      <h2>Connections</h2>
      <table class="integrations"><thead><tr><th class="i-vendor">Connection</th><th class="i-mode">Connected as</th><th class="i-status">Status</th>
        <th class="i-last">Last success</th><th class="i-detail">Details</th><th class="i-action"></th></tr></thead>
        <tbody>${items.map(integrationRow).join('')}</tbody></table>
      <h2>Go-live readiness</h2>
      <div class="toolbar"><p class="muted grow">${a
        ? `Latest assessment ${esc(when(a.finished_at))} by ${esc(a.reviewer_email)}: <strong>${a.verdict === 'ready' ? 'ready' : 'not ready'}</strong>, ${esc(a.days_remaining)} days to the July 1, 2027 go-live.`
        : 'No assessment has been run yet, so the automatic checks have not run.'}
        ${esc(s.passed)} pass, ${esc(s.failed)} fail, ${esc(s.no_evidence)} with no evidence, ${esc(s.not_run)} not run.</p>
        <button type="button" class="primary" id="run-assessment">Run assessment now</button></div>
      <table class="readiness"><thead><tr><th class="r-check">Check</th><th class="r-result">Result</th><th class="r-evidence">Evidence</th><th class="r-when">Checked or recorded</th></tr></thead>
        <tbody>${readiness.checks.map(readinessRow).join('')}</tbody></table>`);
    if (message) notice(message);

    document.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => {
      b.disabled = true;
      b.textContent = 'Checking…';
      adminChange('POST', `/console/integrations/${encodeURIComponent(b.dataset.check)}/check`, {
        ok: (r) => {
          const c = r.body.check;
          renderIntegrations(c.outcome === 'ok'
            ? `<p class="banner good">${esc(r.body.status.vendor)} answered correctly just now. The status below includes this check.</p>`
            : `<p class="banner warn">${esc(r.body.status.vendor)} check: ${esc(ERROR_CLASS[c.outcome] ?? c.outcome)}. ${esc(c.error ?? '')}</p>`);
        },
      });
    }));
    document.getElementById('run-assessment').addEventListener('click', (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Running…';
      adminChange('POST', '/readiness/assessments', {
        body: {},
        ok: (r) => renderIntegrations(`<p class="banner good">Assessment run: ${r.body.item?.verdict === 'ready' ? 'ready' : 'not ready'}. Each check below shows what it found.</p>`),
      });
    });
  }

  // ---------- routing ----------
  async function render() {
    // A session handed over in the address (used by the automatic layout check) is moved into this tab
    // and removed from the address at once, so it does not stay in the browser history.
    const handed = /[#?&]session=([^&]+)/.exec(location.hash);
    if (handed) {
      token = decodeURIComponent(handed[1]);
      store.set('hwo.session', token);
      history.replaceState(null, '', location.hash.replace(/[?&]session=[^&]+/, ''));
    }
    if (!token) return showSignInPage();
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = path.split('/').filter(Boolean);
    try {
      if (!me) {
        const who = await api('GET', '/console/me');
        if (who.status === 200) { me = who.body; store.set('hwo.me', JSON.stringify(me)); }
      }
      if (!parts.length || parts[0] === 'work-orders') {
        if (parts[1]) return await renderDetail(decodeURIComponent(parts[1]));
        return await renderList(Object.fromEntries(new URLSearchParams(query ?? '')));
      }
      if (parts[0] === 'map') return await renderMap(Object.fromEntries(new URLSearchParams(query ?? '')));
      if (parts[0] === 'admin') {
        const tab = parts[1] ?? 'users';
        if (tab === 'roles') return await renderAdminRoles();
        if (tab === 'settings') return await renderAdminSettings();
        if (tab === 'audit') return await renderAdminAudit(Object.fromEntries(new URLSearchParams(query ?? '')));
        return await renderAdminUsers();
      }
      if (parts[0] === 'intake') {
        if (parts[1]) return await renderDraft(decodeURIComponent(parts[1]));
        return await renderIntakeQueue(Object.fromEntries(new URLSearchParams(query ?? '')));
      }
      if (parts[0] === 'integrations') return await renderIntegrations();
      mount('', '<p class="banner bad">No such screen.</p>');
    } catch (err) {
      if (err instanceof SessionExpired) {
        token = null;
        store.del('hwo.session');
        return showSignInPage('Your session expired. Sign in again to carry on.');
      }
      mount('', `<p class="banner bad">The system could not be reached. Try again in a moment.</p>`);
    }
  }

  window.addEventListener('hashchange', render);
  render();
})();
