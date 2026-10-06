'use strict';
/* Tiny fetch wrapper for the letzControl API */
window.api = (() => {
  async function request(path, opts = {}) {
    const r = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts
    });
    if (r.status === 401 && !path.startsWith('/auth/')) {
      location.href = '/login.html';
      throw new Error('Session expired');
    }
    let body = {};
    try { body = await r.json(); } catch { /* empty body */ }
    if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status, body });
    return body;
  }
  return {
    get: (p) => request(p),
    post: (p, data) => request(p, { method: 'POST', body: JSON.stringify(data || {}) }),
    put: (p, data) => request(p, { method: 'PUT', body: JSON.stringify(data || {}) }),
    del: (p) => request(p, { method: 'DELETE' }),
    upload: (p, formData) => request(p, { method: 'POST', body: formData, headers: {} }),

    /* Real upload progress needs XMLHttpRequest: fetch() has no upload
     * progress event, so a plain fetch silently stalls at 0% until the whole
     * body is in. XHR exposes upload.onprogress with bytes sent/total.
     *
     * onProgress({ loaded, total, pct })  - bytes handed to the socket
     * onStart({ total })                 - real body size, 0 when unknown
     * Returns { promise, abort } so the caller can cancel a transfer. */
    uploadXhr(p, formData, { onProgress, onStart } = {}) {
      const xhr = new XMLHttpRequest();
      let started = false;
      const promise = new Promise((resolve, reject) => {
        xhr.open('POST', '/api' + p);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => {
          if (!started) { started = true; onStart && onStart({ total: e.lengthComputable ? e.total : 0 }); }
          if (onProgress) {
            onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : 0, pct: e.lengthComputable && e.total ? (e.loaded / e.total) * 100 : 0 });
          }
        };
        xhr.onload = () => {
          if (xhr.status === 401) { location.href = '/login.html'; return reject(new Error('Session expired')); }
          let body = {};
          try { body = JSON.parse(xhr.responseText); } catch { /* empty or non-JSON body */ }
          if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
          reject(Object.assign(new Error(body.error || `Upload failed (HTTP ${xhr.status})`), { status: xhr.status, body }));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { aborted: true }));
        xhr.send(formData);
      });
      return { promise, abort: () => xhr.abort() };
    }
  };
})();
