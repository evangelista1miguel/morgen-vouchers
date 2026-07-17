// ─────────────────────────────────────────────────────────────
// auth.js — server-side session auth (replaces the old hardcoded
// STAFF_PWD/ADMIN_PWD/SERVER_KEY that used to live in public/index.html)
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'mcg_session';
const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8h

function signSession(user) {
  return jwt.sign(
    { sub: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: TOKEN_TTL_SECONDS * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Populates req.user if a valid session cookie is present.
function readSession(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      req.user = null;
    }
  }
  next();
}

function requireRole(role) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ ok: false, reason: 'not_authenticated' });
    const ok = req.user.role === role || req.user.role === 'admin';
    if (!ok) return res.status(403).json({ ok: false, reason: 'forbidden' });
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  requireRole,
};
