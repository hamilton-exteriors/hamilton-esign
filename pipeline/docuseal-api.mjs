import { loadDocusealSecrets } from './config.mjs';
import { requireUniqueActiveTemplate } from './registry.mjs';

export function createDocusealClient(secrets = loadDocusealSecrets(), fetchImpl = fetch) {
  const headers = {
    'X-Auth-Token': secrets.apiKey,
    'Content-Type': 'application/json',
  };

  async function request(path, init = {}, what = path) {
    let response;
    try {
      response = await fetchImpl(`${secrets.url}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers || {}) },
      });
    } catch (error) {
      throw new Error(`network error reaching ${what}: ${error.message}`);
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch {
        if (response.ok) throw new Error(`${what} returned non-JSON content`);
        body = text;
      }
    }
    if (!response.ok) {
      const detail = typeof body === 'string' ? body.slice(0, 160) : JSON.stringify(body || {}).slice(0, 160);
      throw new Error(`${what} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return body;
  }

  async function listAll(path, { limit = 100, dataKey = 'data', what = path } = {}) {
    const rows = [];
    const seen = new Set();
    let after = null;
    for (let page = 1; page <= 1000; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const cursor = after == null ? '' : `&after=${encodeURIComponent(after)}`;
      const payload = await request(`${path}${separator}limit=${limit}${cursor}`, {}, what);
      const batch = Array.isArray(payload) ? payload : payload?.[dataKey];
      if (!Array.isArray(batch)) throw new Error(`${what} returned no ${dataKey} array`);
      let added = 0;
      for (const row of batch) {
        const key = row?.id == null ? JSON.stringify(row) : String(row.id);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
        added++;
      }
      const next = payload?.pagination?.next ?? payload?.next_page ?? null;
      if (batch.length < limit || next == null) break;
      if (!added || String(next) === String(after)) {
        throw new Error(`${what} pagination made no progress on page ${page}`);
      }
      after = next;
    }
    return rows;
  }

  async function templateByName(title) {
    const templates = await listAll('/api/templates', { what: 'template inventory' });
    return requireUniqueActiveTemplate(templates, title);
  }

  return {
    secrets,
    request,
    listAll,
    templateByName,
    publicUrl: secrets.publicUrl,
  };
}
