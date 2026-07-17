// ─────────────────────────────────────────────────────────────
// server.js — Morgen Coffee Group Voucher System
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { readSession, requireRole, signSession, setSessionCookie, clearSessionCookie } = require('./auth');
const { issueCsrfToken, verifyCsrf } = require('./csrf');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Set it in your environment before starting the server.');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct req.ip and secure cookies
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(readSession);
app.use(issueCsrfToken);
app.use(express.static(path.join(__dirname, 'public')));

// ── STORE ────────────────────────────────────────────────────
const store = {
    vouchers: {},   // code -> { tier, prefix, discount, minOrder, status, branch, date, time, amount }
    tiers: {},      // tierKey -> { prefix, discount, minOrder, limit, label }
    log: [],
    users: {}       // username -> { passwordHash, role: 'staff'|'admin' }
};

// ── PERSISTENCE ─────────────────────────────────────────────
// NOTE: Render's free-tier disk is ephemeral across deploys (it survives
// simple restarts/sleep, but a new deploy wipes it). For real durability,
// move this to a proper database (e.g. a free Render Postgres instance).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function loadStore() {
    try {
          if (fs.existsSync(DATA_FILE)) {
                  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                  store.vouchers = raw.vouchers || {};
                  store.tiers    = raw.tiers    || {};
                  store.log      = raw.log      || [];
                  store.users    = raw.users    || {};
                  return true;
          }
    } catch (err) {
          console.error('Failed to load data.json, starting fresh:', err);
    }
    return false;
}

function saveStore() {
    try {
          fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
          console.error('Failed to save data.json:', err);
    }
}

// ── DEFAULT TIERS (only applied if no saved data exists yet) ─
const loadedExisting = loadStore();
if (!loadedExisting) {
    store.tiers['50'] = { prefix: 'MCG50-2026', discount: 50,  minOrder: 300, limit: 50,  label: '₱50 off' };
    saveStore();
}

// ── HELPERS ──────────────────────────────────────────────────
function randomCode(length = 5) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
          result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
function getTierFromCode(code) {
    for (const [key, t] of Object.entries(store.tiers)) {
          if (code.startsWith(t.prefix + '-')) return key;
    }
    return null;
}
function nowPH() {
    const now  = new Date();
    const opts = { timeZone: 'Asia/Manila' };
    const date = now.toLocaleDateString('en-PH', { ...opts, year: 'numeric', month: 'short', day: 'numeric' });
    const time = now.toLocaleTimeString('en-PH', { ...opts, hour: '2-digit', minute: '2-digit' });
    return { date, time };
}
// ── AUTH ROUTES ──────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, reason: 'too_many_attempts' },
});

// Client fetches this once on page load and sends the token back as
// the x-csrf-token header on every state-changing request.
app.get('/csrf', (req, res) => res.json({ csrfToken: req.csrfToken }));

app.post('/login', loginLimiter, verifyCsrf, (req, res) => {
    const { username, password } = req.body || {};
    const user = store.users[username];
    const valid = user && bcrypt.compareSync(password || '', user.passwordHash);

    if (!valid) {
        store.log.unshift({ type: 'login_failed', username: username || '(blank)', ip: req.ip, at: nowPH() });
        saveStore();
        return res.status(401).json({ ok: false, reason: 'invalid_credentials' });
    }

    const token = signSession({ username, role: user.role });
    setSessionCookie(res, token);
    res.json({ ok: true, username, role: user.role });
});

app.post('/logout', verifyCsrf, (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

// Lets the front-end check for an existing valid session on page load,
// so staff/admin don't need to re-enter a password every reload.
app.get('/me', (req, res) => {
    if (!req.user) return res.json({ ok: false });
    res.json({ ok: true, username: req.user.sub, role: req.user.role });
});

// ── ROUTES ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'morgen-vouchers' }));

// Member: check code
app.get('/vouchers/check/:code', (req, res) => {
    const code = req.params.code.toUpperCase().trim();
    const v    = store.vouchers[code];
    if (!v) return res.json({ valid: false, reason: 'not_found' });
    const t = store.tiers[v.tier];
    res.json({
          valid:    v.status === 'unused',
          status:   v.status,
          tier:     v.tier,
          label:    t.label,
          discount: t.discount,
          minOrder: t.minOrder,
          branch:   v.branch || null,
          date:     v.date   || null,
    });
});

// Staff: redeem
app.post('/vouchers/redeem', requireRole('staff'), verifyCsrf, (req, res) => {
    const code   = (req.body.code   || '').toUpperCase().trim();
    const branch = (req.body.branch || '').trim();
    const amount =  parseFloat(req.body.amount);
    if (!code)               return res.status(400).json({ ok: false, reason: 'missing_code' });
    if (!branch)             return res.status(400).json({ ok: false, reason: 'missing_branch' });
    if (!amount || amount<1) return res.status(400).json({ ok: false, reason: 'invalid_amount' });
    const tierKey = getTierFromCode(code);
    const v       = store.vouchers[code];
    if (!tierKey || !v)      return res.json({ ok: false, reason: 'invalid_code' });
    if (v.status === 'used') return res.json({ ok: false, reason: 'already_used', branch: v.branch, date: v.date });
    const t = store.tiers[tierKey];
    if (amount < t.minOrder) {
          return res.json({ ok: false, reason: 'below_minimum', minOrder: t.minOrder, discount: t.discount });
    }
    const { date, time } = nowPH();
    store.vouchers[code] = { ...v, status: 'used', branch, date, time, amount };
    store.log.unshift({ code, tier: tierKey, label: t.label, discount: t.discount, branch, date, time, amount });
    saveStore();
    res.json({ ok: true, code, tier: tierKey, label: t.label, discount: t.discount, final: +(amount - t.discount).toFixed(2), branch, date, time });
});

// Admin: add a new tier / voucher batch
app.post('/vouchers/tiers', requireRole('admin'), verifyCsrf, (req, res) => {
    const { prefix, discount, minOrder, limit } = req.body;
    if (!prefix || !discount || !minOrder || !limit)
          return res.status(400).json({ ok: false, reason: 'missing_fields' });
    const cleanPrefix = prefix.toUpperCase().trim();
    const disc  = parseInt(discount);
    const minOrd = parseInt(minOrder);
    const lim   = parseInt(limit);
    if (isNaN(disc) || disc < 1)   return res.status(400).json({ ok: false, reason: 'invalid_discount' });
    if (isNaN(minOrd) || minOrd < 1) return res.status(400).json({ ok: false, reason: 'invalid_min_order' });
    if (isNaN(lim) || lim < 1 || lim > 500) return res.status(400).json({ ok: false, reason: 'invalid_limit' });
    // Use discount amount as tier key, append timestamp if already exists
           const tierKey = `${disc}_${Date.now()}`;
    store.tiers[tierKey] = { prefix: cleanPrefix, discount: disc, minOrder: minOrd, limit: lim, label: `₱${disc} off` };
    saveStore();
    res.json({ ok: true, tierKey, tier: store.tiers[tierKey] });
});

// Admin: delete a tier and its vouchers
app.delete('/vouchers/tiers/:tierKey', requireRole('admin'), verifyCsrf, (req, res) => {
    const { tierKey } = req.params;
    if (!store.tiers[tierKey]) return res.status(404).json({ ok: false, reason: 'tier_not_found' });
    delete store.tiers[tierKey];
    Object.keys(store.vouchers).forEach(code => {
        if (store.vouchers[code].tier === tierKey) delete store.vouchers[code];
    });
    saveStore();
    res.json({ ok: true });
});

// Admin: generate batch for a tier
app.post('/vouchers/generate', requireRole('admin'), verifyCsrf, (req, res) => {
    const { tier } = req.body;
    if (!store.tiers[tier]) return res.status(400).json({ ok: false, reason: 'invalid_tier' });
    const t        = store.tiers[tier];
    const existing = Object.values(store.vouchers).filter(v => v.tier === tier).length;
    const toCreate = t.limit - existing;
    if (toCreate <= 0) return res.json({ ok: true, created: 0, message: 'Batch limit already reached.' });
    const codes = [];
    let attempts = 0;
    while (codes.length < toCreate && attempts < toCreate * 20) {
          const code = `${t.prefix}-${randomCode(5)}`;
          if (!store.vouchers[code] && !codes.includes(code)) codes.push(code);
          attempts++;
    }
    codes.forEach(code => {
          store.vouchers[code] = { tier, status: 'unused', branch: '', date: '', time: '', amount: 0 };
    });
    saveStore();
    res.json({ ok: true, created: codes.length, sample: codes.slice(0, 3) });
});

// Admin: get all tiers
app.get('/vouchers/tiers', requireRole('admin'), (req, res) => {
    res.json({ ok: true, tiers: store.tiers });
});

// Admin: list all voucher codes (optional ?tier=KEY or ?status=unused|used filters)
app.get('/vouchers/list', requireRole('admin'), (req, res) => {
    const { tier, status } = req.query;
    let codes = Object.entries(store.vouchers).map(([code, v]) => ({ code, ...v }));
    if (tier)   codes = codes.filter(v => v.tier === tier);
    if (status) codes = codes.filter(v => v.status === status);
    res.json({ ok: true, count: codes.length, vouchers: codes });
});

// Admin: summary + log
app.get('/vouchers/summary', requireRole('admin'), (req, res) => {
    const summary = {};
    for (const [key, t] of Object.entries(store.tiers)) {
          const all  = Object.values(store.vouchers).filter(v => v.tier === key);
          const used = all.filter(v => v.status === 'used');
          summary[key] = {
                  tier: key, prefix: t.prefix, label: t.label, discount: t.discount, minOrder: t.minOrder,
                  limit: t.limit, issued: all.length, redeemed: used.length,
                  available: all.length - used.length,
                  totalDiscount: used.length * t.discount,
          };
    }
    res.json({ ok: true, summary, log: store.log });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Morgen Voucher System running on port ${PORT}`));
