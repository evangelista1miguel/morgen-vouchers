// ─────────────────────────────────────────────────────────────
// csrf.js — double-submit-cookie CSRF protection.
// The old `csurf` npm package is deprecated, so this is a small
// hand-rolled equivalent: a random token goes into a readable
// (non-httpOnly) cookie AND is returned from GET /csrf. The client
// JS reads it from the response and sends it back as a header on
// every state-changing request. A cross-site request can't read
// the cookie's value, so it can't forge that header.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');

const CSRF_COOKIE = 'mcg_csrf';
const CSRF_HEADER = 'x-csrf-token';

function issueCsrfToken(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    });
  }
  req.csrfToken = token;
  next();
}

function verifyCsrf(req, res, next) {
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ ok: false, reason: 'invalid_csrf_token' });
  }
  next();
}

module.exports = { issueCsrfToken, verifyCsrf, CSRF_HEADER };
