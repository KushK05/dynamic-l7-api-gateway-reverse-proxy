// Thin client for the loopback admin API. Every write sends JSON with
// Content-Type: application/json (the server rejects anything else with 415).

export class ApiError extends Error {
  constructor(status, error, body) {
    super(error || `request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status; // HTTP status, or 0 for a network failure
    this.error = error || ''; // the server's {"error"} text when present
    this.body = body ?? null;
  }

  // conflict is true for 412: the config changed since it was read.
  get conflict() {
    return this.status === 412;
  }
}

async function request(method, url, { body, headers } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, cache: 'no-store' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(0, `network error: ${e.message}`);
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = data && typeof data.error === 'string' ? data.error : `${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, msg, data);
  }
  return data;
}

// getConfig returns {revision, config}.
export function getConfig() {
  return request('GET', '/admin/v1/config');
}

// putConfig replaces the config conditionally on the revision the caller read.
// A stale revision throws an ApiError whose status is 412 (err.conflict).
export function putConfig(config, revision) {
  return request('PUT', '/admin/v1/config', { body: config, headers: { 'If-Match': `"${revision}"` } });
}

// getLoad returns the generator LoadStatus.
export function getLoad() {
  return request('GET', '/admin/v1/load');
}

const LOAD_KEYS = ['rps', 'concurrency', 'invalid_token_percent'];

// putLoad applies generator settings. The server requires the complete
// LoadSettings object, so a partial update is merged onto the current settings
// first: putLoad({rps: 200}) keeps concurrency, mix and invalid token percent.
export async function putLoad(settings) {
  let full = settings;
  if (!LOAD_KEYS.every((k) => k in settings)) {
    const cur = await getLoad();
    full = { ...cur.settings, ...settings };
  }
  return request('PUT', '/admin/v1/load', { body: full });
}

// getUpstreams returns the upstream list [{id,url,in_config,known,health,fault}].
export async function getUpstreams() {
  const data = await request('GET', '/admin/v1/upstreams');
  return data.upstreams || [];
}

// injectFault sets {delay_ms, status, unhealthy, error_rate_percent} on an upstream.
export function injectFault(id, body) {
  return request('POST', `/admin/v1/upstreams/${encodeURIComponent(id)}/fault`, { body });
}

// resetFault clears every fault on an upstream.
export function resetFault(id) {
  return request('POST', `/admin/v1/upstreams/${encodeURIComponent(id)}/reset`, { body: {} });
}

// getSeries returns the last N seconds of SeriesPoints, oldest first.
export async function getSeries(seconds = 120) {
  const data = await request('GET', `/admin/v1/series?seconds=${encodeURIComponent(seconds)}`);
  return data.points || [];
}
