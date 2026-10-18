/**
 * Tiny fetch() wrapper for talking to the backend.
 * Loaded as a plain <script> tag — attaches to `window.Api`.
 *
 * Set `window.API_BASE_URL` before this script runs (e.g. in each page's
 * inline <script> block) to point at the backend, or leave it unset to
 * default to a same-origin "/api".
 */
(function () {
  const BASE_URL = window.API_BASE_URL || "/api";

  async function request(path, options) {
    const res = await fetch(BASE_URL + path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });

    let body;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }

    if (!res.ok || (body && body.error)) {
      const message =
        (body && body.error && body.error.message) ||
        `Request failed (${res.status})`;
      throw new Error(message);
    }

    return body ? body.data : null;
  }

  function get(path) {
    return request(path, { method: "GET" });
  }

  function post(path, data) {
    return request(path, { method: "POST", body: JSON.stringify(data) });
  }

  function patch(path, data) {
    return request(path, { method: "PATCH", body: JSON.stringify(data) });
  }

  window.Api = { get, post, patch };
})();
