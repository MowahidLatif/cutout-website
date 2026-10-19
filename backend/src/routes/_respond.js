/**
 * Shared response helpers so every route uses the same
 * { data, error } envelope. See docs/backend-guide.md.
 */
const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
};

function ok(res, data, status = 200) {
  res.status(status).json({ data, error: null });
}

/** An Error with a known `code` (see STATUS_BY_CODE). */
function appError(message, code) {
  return Object.assign(new Error(message), { code });
}

function fail(res, err) {
  const code = STATUS_BY_CODE[err.code] ? err.code : "INTERNAL_ERROR";
  const status = STATUS_BY_CODE[code] || 500;
  let message = err.message || "Something went wrong.";
  if (status === 500) {
    // Full details stay in the server log. In production the client never
    // sees internal messages (SQL errors, file paths, stack traces).
    console.error(err);
    if (process.env.NODE_ENV === "production") message = "Something went wrong. Please try again.";
  }
  res.status(status).json({ data: null, error: { message, code } });
}

module.exports = { ok, fail, appError, STATUS_BY_CODE };
