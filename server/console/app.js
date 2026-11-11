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
    { route: 'intake', label: 'AI intake', story: 'STORY-015', soon: 'The agent drafts a work order from a request; a person approves it.',
      basis: 'The drafting agent is new work. Approved drafts will become work orders through the work order API that already exists.' },
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
    const { item: wo, history, gis_status: gisStatus, gis_records: gisRecords } = res.body;
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
