/**
 * Tiny fetch() wrapper for talking to the backend.
 * Loaded as a plain <script> tag — attaches to `window.Api`.
 *
 * The backend serves the site and the API from the same origin, so calls go
 * to "/api" and nothing needs configuring. (Only if the frontend is ever
 * hosted elsewhere: set `window.API_BASE_URL` before this script runs, and
 * FRONTEND_ORIGIN on the backend for CORS.)
 */
(function () {
  const BASE_URL = window.API_BASE_URL || "/api";

  async function request(path, { method, body, headers }) {
    const isForm = body instanceof FormData;
    const res = await fetch(BASE_URL + path, {
      method,
      // Let the browser set the multipart boundary for FormData uploads.
      headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...headers },
      body: isForm || body === undefined ? body : JSON.stringify(body),
    });

    let resBody;
    try {
      resBody = await res.json();
    } catch (e) {
      resBody = null;
    }

    if (!res.ok || (resBody && resBody.error)) {
      const message =
        (resBody && resBody.error && resBody.error.message) ||
        `Request failed (${res.status})`;
      throw Object.assign(new Error(message), {
        status: res.status,
        retryAfter: Number(res.headers.get("Retry-After")) || null, // seconds, on 429
      });
    }

    return resBody ? resBody.data : null;
  }

  function get(path, headers) {
    return request(path, { method: "GET", headers });
  }

  function post(path, data, headers) {
    return request(path, { method: "POST", body: data, headers });
  }

  function patch(path, data, headers) {
    return request(path, { method: "PATCH", body: data, headers });
  }

  /** POSTs a FormData (multipart) body, e.g. a file upload. */
  function upload(path, formData, headers) {
    return request(path, { method: "POST", body: formData, headers });
  }

  /**
   * GETs a file (e.g. the admin's supplier zip) and returns { blob, filename }.
   * Errors come back as the usual JSON envelope and are thrown like request().
   */
  async function download(path, headers) {
    const res = await fetch(BASE_URL + path, { headers: { ...headers } });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch (e) {
        // not JSON
      }
      throw Object.assign(new Error(message), {
        status: res.status,
        retryAfter: Number(res.headers.get("Retry-After")) || null,
      });
    }
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob: await res.blob(), filename: match ? match[1] : "download" };
  }

  window.Api = { get, post, patch, upload, download };
})();
