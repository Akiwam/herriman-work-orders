// Public page behaviour. Talks only to /api/v1/public/… on the same server.
// Everything from the server is put on the page with textContent, never as HTML.

const API = '/api/v1/public';
const TIMEOUT_MS = 10000;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
};
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** Call the API. Always resolves to { ok, status, body }; a network failure is status 0. */
async function call(method, path, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, body: data };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** A plain-language message for any failed call. */
function failureMessage(result, notFoundText) {
  if (result.status === 400 && Array.isArray(result.body?.problems)) {
    return el('div', { className: 'message err' },
      el('strong', { textContent: 'Please check the form:' }),
      el('ul', {}, ...result.body.problems.map((p) => el('li', { textContent: p }))));
  }
  const text = {
    404: notFoundText,
    429: 'You have sent several reports in a short time. Please wait an hour and try again.',
  }[result.status] ?? 'The service is temporarily unavailable. Please try again in a few minutes.';
  return el('div', { className: 'message err', textContent: text });
}

// Friendly names for categories, taken from the report form's own list so there is one source.
const CATEGORY_LABELS = Object.fromEntries([...$('category').options].filter((o) => o.value).map((o) => [o.value, o.textContent]));
const categoryLabel = (value) => CATEGORY_LABELS[value] ?? (value === 'citizen_request' ? 'General request' : value?.replace(/_/g, ' '));

function renderItem(item, { showReference = false } = {}) {
  const heading = el('h3', { textContent: item.title }, el('span', { className: 'status', textContent: item.status }));
  const meta = el('p', { className: 'muted small', textContent: [categoryLabel(item.category), item.location].filter(Boolean).join(' · ') });
  const timeline = el('ol', { className: 'timeline' },
    ...item.history.map((h) => el('li', {}, el('time', { dateTime: h.at, textContent: when(h.at) }), h.event)));
  const parts = [heading, meta, timeline];
  if (showReference && item.reference) parts.unshift(el('p', { className: 'muted small', textContent: `Reference ${item.reference}` }));
  return el('article', { className: 'item' }, ...parts);
}

// ---------- report a problem ----------

let submissionId = crypto.randomUUID(); // one per report: a double-click or retry cannot make two

$('report-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('report-button');
  const out = $('report-result');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Sending…';
  out.replaceChildren();

  const data = Object.fromEntries(new FormData(form));
  const body = { ...data, submission_id: submissionId };
  for (const key of ['category', 'contact']) if (!body[key]) delete body[key];
  const result = await call('POST', '/requests', body);

  if (result.ok) {
    out.replaceChildren(el('div', { className: 'message ok' },
      el('p', { textContent: 'Thank you — your report has been received. Your tracking code is:' }),
      el('p', { className: 'code', textContent: result.body.tracking_code }),
      el('p', { textContent: 'Keep this code to check on your request below.' })));
    form.reset();
    $('tracking_code').value = result.body.tracking_code;
    submissionId = crypto.randomUUID(); // the next report is a new one
  } else {
    out.replaceChildren(failureMessage(result, 'Something went wrong. Please try again.'));
  }
  button.disabled = false;
  button.textContent = 'Send report';
});

// ---------- check my request ----------

$('track-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const out = $('track-result');
  const code = $('tracking_code').value.trim();
  if (!code) {
    out.replaceChildren(el('div', { className: 'message err', textContent: 'Enter the tracking code you were given.' }));
    return;
  }
  out.replaceChildren(el('p', { className: 'muted', textContent: 'Checking…' }));
  const result = await call('GET', `/requests/${encodeURIComponent(code)}`);
  out.replaceChildren(result.ok
    ? renderItem(result.body.item, { showReference: true })
    : failureMessage(result, 'We could not find a request with that tracking code. Check the code and try again.'));
});

// ---------- recent public work ----------

async function loadRecent() {
  const out = $('recent-list');
  const result = await call('GET', '/work-orders?limit=10');
  if (!result.ok) {
    out.replaceChildren(failureMessage(result, 'No public work to show yet.'));
    return;
  }
  out.replaceChildren(...(result.body.items.length
    ? result.body.items.map((item) => renderItem(item))
    : [el('p', { className: 'muted', textContent: 'No public work to show yet.' })]));
}
loadRecent();
