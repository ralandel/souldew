// Thin fetch wrapper for the local server. The x-soullink header is the server's CSRF guard.
import { serverErrorText } from './errors.mjs';
import { diag } from './diag.mjs';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-soullink': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(serverErrorText(data && typeof data === 'object' ? data : {}, res.status));
    err.code = data?.code;
    err.vars = data?.vars;
    err.status = res.status;
    // diagnostics: which call failed and how (the randomizer's stack frames among it – vars.trace, server/lib/toolchain.mjs)
    // (a file error also which file, reading or writing, and the free space then – toolchain.mjs ioFailure)
    const io = data?.vars?.where !== undefined ? { where: data.vars.where, op: data.vars.op ?? null, free: data.vars.free ?? null } : {};
    diag('api', { method, url: String(url).split('?')[0], status: res.status, code: data?.code ?? null, what: data?.vars?.what ?? null, trace: data?.vars?.trace ?? null, ...io });
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url, body) => request('DELETE', url, body),
  patch: (url, body) => request('PATCH', url, body),
};

/** Server-sent events with auto-reconnect (EventSource does that natively). */
export function events(handlers) {
  const es = new EventSource('/api/events');
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.error('event handler failed', name, err);
      }
    });
  }
  return () => es.close();
}
