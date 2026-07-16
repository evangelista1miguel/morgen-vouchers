// ─────────────────────────────────────────────────────────────
// server.js — Morgen Coffee Group Voucher System
// ─────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── IN-MEMORY STORE (persists while server is running) ───────
// On free Render, the server sleeps after inactivity but data
// survives as long as it's awake. For a voucher system used
// daily at the counter this is perfectly fine.
const store = {
  vouchers: {},   // code -> { tier, status, branch, date, time, amount }
  log: []
};

// ── CONFIG ───────────────────────────────────────────────────
const TIERS = {
  '50': { prefix: 'MCG50-2026', discount: 50,  minOrder: 300, limit: 50  },
  '20': { prefix: 'MCG20-2026', discount: 20,  minOrder: 230, limit: 150 }
};

const ADMIN_KEY = process.env.VOUCHER_ADMIN_KEY || 'morgen-admin-2026';

// ── HELPERS ──────────────────────────────────────────────────
function getTierFromCode(code) {
  for (const [key, t] of Object.entries(TIERS)) {
    if (code.startsWith(t.prefix)) return key;
  }
  return null;
}

function randomCode(length = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function nowPH() {
  const now  = new Date();
  const opts = { timeZone: 'Asia/Manila' };
  const date = now.toLocaleDateString('en-PH', { ...opts, year: 'numeric', month: 'short', day: 'numeric' });
  const time = now.toLocaleTimeString('en-PH', { ...opts, hour: '2-digit', minute: '2-digit' });
  return { date, time };
}

function authAdmin(req, res) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey || req.query?.adminKey;
  if (key !== ADMIN_KEY) {
    res.status(403).json({ ok: false, reason: 'unauthorized' });
    return false;
  }
  return true;
}

// ── ROUTES ───────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, service: 'morgen-vouchers' }));

// Member: check a code
app.get('/vouchers/check/:code', (req, res) => {
  const code = req.params.code.toUpperCase().trim();
  const v    = store.vouchers[code];

  if (!v) return res.json({ valid: false, reason: 'not_found' });

  const tier = TIERS[v.tier];
  res.json({
    valid:    v.status === 'unused',
    status:   v.status,
    tier:     v.tier,
    discount: tier.discount,
    minOrder: tier.minOrder,
    branch:   v.branch || null,
    date:     v.date   || null,
  });
});

// Staff: redeem a code
app.post('/vouchers/redeem', (req, res) => {
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

  const tier = TIERS[tierKey];
  if (amount < tier.minOrder) {
    return res.json({ ok: false, reason: 'below_minimum', minOrder: tier.minOrder, discount: tier.discount });
  }

  const { date, time } = nowPH();
  store.vouchers[code] = { ...v, status: 'used', branch, date, time, amount };
  store.log.unshift({ code, tier: tierKey, discount: tier.discount, branch, date, time, amount });

  res.json({ ok: true, code, tier: tierKey, discount: tier.discount, final: +(amount - tier.discount).toFixed(2), branch, date, time });
});

// Admin: generate batch
app.post('/vouchers/generate', (req, res) => {
  if (!authAdmin(req, res)) return;

  const { tier } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ ok: false, reason: 'invalid_tier' });

  const t        = TIERS[tier];
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

  res.json({ ok: true, created: codes.length, sample: codes.slice(0, 3) });
});

// Admin: summary + log
app.get('/vouchers/summary', (req, res) => {
  if (!authAdmin(req, res)) return;

  const summary = {};
  for (const [key, t] of Object.entries(TIERS)) {
    const all  = Object.values(store.vouchers).filter(v => v.tier === key);
    const used = all.filter(v => v.status === 'used');
    summary[key] = {
      tier: key, discount: t.discount, minOrder: t.minOrder, limit: t.limit,
      issued: all.length, redeemed: used.length, available: all.length - used.length,
      totalDiscount: used.length * t.discount,
    };
  }

  res.json({ ok: true, summary, log: store.log });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Morgen Voucher System running on port ${PORT}`));
