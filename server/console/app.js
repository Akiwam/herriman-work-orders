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
    { route: 'map', label: 'Map', story: 'STORY-016', soon: 'Work order activity on a map, with heat maps by type and area.',
      basis: 'The heat maps it will show already exist in the system\'s API.' },
    { route: 'admin', label: 'Administration', story: 'STORY-017', soon: 'Users, roles, settings and workflows in one place.',
      basis: 'Everything it will manage already exists in the system\'s API.' },
    { route: 'integrations', label: 'Integrations & readiness', story: 'STORY-018', soon: 'Vendor feeds, GIS and Blue Stakes, and the go-live readiness assessment.',
      basis: 'Everything it will show already exists in the system\'s API.' },
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

  // ---------- screens still to come ----------
  function renderPlaceholder(route) {
    const n = NAV.find((x) => x.route === route);
    mount(route, `<div class="placeholder card"><p class="story">${esc(n.story)} · coming next</p><h1>${esc(n.label)}</h1>
      <p>${esc(n.soon)}</p><p class="muted">This screen will be built in ${esc(n.story)}. ${esc(n.basis)}</p></div>`);
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
      if (parts[0] === 'intake') {
        if (parts[1]) return await renderDraft(decodeURIComponent(parts[1]));
        return await renderIntakeQueue(Object.fromEntries(new URLSearchParams(query ?? '')));
      }
      if (NAV.some((n) => n.route === parts[0])) return renderPlaceholder(parts[0]);
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
