/**
 * Shared response helpers so every route uses the same
 * { data, error } envelope. See docs/backend-guide.md.
 */
const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
};

function ok(res, data, status = 200) {
  res.status(status).json({ data, error: null });
}

function fail(res, err) {
  const code = err.code || "INTERNAL_ERROR";
  const status = STATUS_BY_CODE[code] || 500;
  if (status === 500) {
    console.error(err);
  }
  res.status(status).json({
    data: null,
    error: { message: err.message || "Something went wrong.", code },
  });
}

module.exports = { ok, fail };
