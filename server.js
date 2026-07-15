// ─────────────────────────────────────────────────────────────
// server.js — Morgen Coffee Group Voucher System
// Standalone Express + SQLite backend
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ─────────────────────────────────────────────────
// Render free tier: use /tmp for ephemeral or mount a disk.
// Default: stores db beside server.js (persists if disk mounted)
const DB_DIR  = process.env.DB_DIR || __dirname;
const DB_PATH = path.join(DB_DIR, 'vouchers.db');

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS vouchers (
    code          TEXT PRIMARY KEY,
    tier          TEXT NOT NULL,
    status        TEXT DEFAULT 'unused',
    branch        TEXT DEFAULT '',
    date_redeemed TEXT DEFAULT '',
    time_redeemed TEXT DEFAULT '',
    order_amount  REAL DEFAULT 0
  );
`);

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

function pad(n) { return String(n).padStart(3, '0'); }

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

// Health check
app.get('/health', (req, res) => res.json({ ok: true, service: 'morgen-vouchers' }));

// GET /vouchers/check/:code — member lookup (read-only)
app.get('/vouchers/check/:code', (req, res) => {
  const code = req.params.code.toUpperCase().trim();
  const row  = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);

  if (!row) return res.json({ valid: false, reason: 'not_found' });

  const tier = TIERS[row.tier];
  res.json({
    valid:    row.status === 'unused',
    status:   row.status,
    tier:     row.tier,
    discount: tier.discount,
    minOrder: tier.minOrder,
    branch:   row.branch   || null,
    date:     row.date_redeemed || null,
  });
});

// POST /vouchers/redeem — staff: validate + redeem
app.post('/vouchers/redeem', (req, res) => {
  const code   = (req.body.code   || '').toUpperCase().trim();
  const branch = (req.body.branch || '').trim();
  const amount =  parseFloat(req.body.amount);

  if (!code)               return res.status(400).json({ ok: false, reason: 'missing_code' });
  if (!branch)             return res.status(400).json({ ok: false, reason: 'missing_branch' });
  if (!amount || amount<1) return res.status(400).json({ ok: false, reason: 'invalid_amount' });

  const tierKey = getTierFromCode(code);
  const row     = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);

  if (!tierKey || !row)      return res.json({ ok: false, reason: 'invalid_code' });
  if (row.status === 'used') return res.json({ ok: false, reason: 'already_used', branch: row.branch, date: row.date_redeemed });

  const tier = TIERS[tierKey];
  if (amount < tier.minOrder) {
    return res.json({ ok: false, reason: 'below_minimum', minOrder: tier.minOrder, discount: tier.discount });
  }

  const { date, time } = nowPH();
  db.prepare(`
    UPDATE vouchers SET status='used', branch=?, date_redeemed=?, time_redeemed=?, order_amount=?
    WHERE code=?
  `).run(branch, date, time, amount, code);

  res.json({
    ok:       true,
    code,
    tier:     tierKey,
    discount: tier.discount,
    final:    +(amount - tier.discount).toFixed(2),
    branch,
    date,
    time,
  });
});

// POST /vouchers/generate — admin: generate batch
app.post('/vouchers/generate', (req, res) => {
  if (!authAdmin(req, res)) return;

  const { tier } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ ok: false, reason: 'invalid_tier' });

  const t        = TIERS[tier];
  const existing = db.prepare('SELECT COUNT(*) as n FROM vouchers WHERE tier=?').get(tier).n;
  const toCreate = t.limit - existing;

  if (toCreate <= 0) return res.json({ ok: true, created: 0, message: 'Batch limit already reached.' });

  const insert = db.prepare('INSERT OR IGNORE INTO vouchers (code, tier) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 0; i < toCreate; i++) {
      insert.run(`${t.prefix}-${pad(existing + i + 1)}`, tier);
    }
  })();

  res.json({
    ok:      true,
    created: toCreate,
    from:    `${t.prefix}-${pad(existing + 1)}`,
    to:      `${t.prefix}-${pad(t.limit)}`,
  });
});

// GET /vouchers/summary — admin dashboard
app.get('/vouchers/summary', (req, res) => {
  if (!authAdmin(req, res)) return;

  const summary = {};
  for (const [key, t] of Object.entries(TIERS)) {
    const rows  = db.prepare('SELECT * FROM vouchers WHERE tier=?').all(key);
    const used  = rows.filter(r => r.status === 'used');
    summary[key] = {
      tier:          key,
      discount:      t.discount,
      minOrder:      t.minOrder,
      limit:         t.limit,
      issued:        rows.length,
      redeemed:      used.length,
      available:     rows.length - used.length,
      totalDiscount: used.length * t.discount,
    };
  }

  const log = db.prepare(`
    SELECT * FROM vouchers WHERE status='used'
    ORDER BY date_redeemed DESC, time_redeemed DESC
  `).all();

  res.json({ ok: true, summary, log });
});

// Fallback — serve index.html for any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Morgen Voucher System running on port ${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
