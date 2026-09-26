const BASE = '/api/audit-entries';

async function request(method, path = '', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = payload.details;
    throw err;
  }
  return payload;
}

export const api = {
  list: () => request('GET'),
  get: (id) => request('GET', `/${id}`),
  create: (entry) => request('POST', '', entry),
  update: (id, patch) => request('PUT', `/${id}`, patch),
  similar: (id) => request('POST', `/${id}/similar`),
  retry: (id) => request('POST', `/${id}/retry`),
  health: () => fetch('/api/health').then((r) => r.json()),
  drain: () => fetch('/api/worker/drain', { method: 'POST' }).then((r) => r.json()),
  eventsUrl: `${BASE}/events`,
};
