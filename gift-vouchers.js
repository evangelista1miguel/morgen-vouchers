// ─────────────────────────────────────────────────────────────
// gift-vouchers.js — Gift voucher sales via Maya Checkout
// Mount in server.js (before other routes):
//   require('./gift-vouchers')(app);
// Env vars: MAYA_PUBLIC_KEY, MAYA_SECRET_KEY, MAYA_ENV=production|sandbox,
//           SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, GIFT_FROM_EMAIL
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireRole } = require('./auth');
const { verifyCsrf } = require('./csrf');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const GIFT_FILE = path.join(DATA_DIR, 'gift-vouchers.json');
const MAYA_BASE = (process.env.MAYA_ENV === 'production')
  ? 'https://pg.paymaya.com'
  : 'https://pg-sandbox.paymaya.com';
const SITE = 'https://morgenkaffee.com';

function load() {
  try { return JSON.parse(fs.readFileSync(GIFT_FILE, 'utf8')); }
  catch { return { orders: {}, vouchers: {}, log: [] }; }
}
function save(db) {
  try { fs.writeFileSync(GIFT_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('gift save failed:', e); }
}
function newCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = n => Array.from(crypto.randomBytes(n)).map(b => chars[b % chars.length]).join('');
  return 'MGV-' + pick(4) + '-' + pick(4);
}
function nowPH() {
  const now = new Date(); const opts = { timeZone: 'Asia/Manila' };
  return {
    date: now.toLocaleDateString('en-PH', { ...opts, year: 'numeric', month: 'short', day: 'numeric' }),
    time: now.toLocaleTimeString('en-PH', { ...opts, hour: '2-digit', minute: '2-digit' }),
  };
}

async function mayaCreateCheckout(body) {
  const res = await fetch(MAYA_BASE + '/checkout/v1/checkouts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(process.env.MAYA_PUBLIC_KEY + ':').toString('base64'),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Maya checkout ' + res.status + ': ' + JSON.stringify(data));
  return data;
}

async function sendVoucherEmail(order) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn('SMTP not configured — voucher email skipped for', order.reference);
    return;
  }
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const forLine = order.recipientName ? '<p>For: <strong>' + order.recipientName + '</strong></p>' : '';
  const msgLine = order.message ? '<p><em>&ldquo;' + order.message + '&rdquo;</em></p>' : '';
  await t.sendMail({
    from: process.env.GIFT_FROM_EMAIL || process.env.SMTP_USER,
    to: order.buyerEmail,
    subject: 'Your Morgen Kaffee gift voucher — ₱' + order.amount,
    html: '<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:12px;">'
      + '<h2 style="margin:0 0 4px;">☕ Morgen Kaffee</h2>'
      + '<p style="color:#777;margin:0 0 20px;">Every minute is morgen.</p>'
      + '<p>Salamat, ' + order.buyerName + '! Here is your gift voucher:</p>'
      + '<div style="background:#faf5ec;border:2px dashed #b98a4e;border-radius:10px;padding:20px;text-align:center;margin:16px 0;">'
      + '<div style="font-size:13px;color:#8a6d3b;letter-spacing:1px;">GIFT VOUCHER · ₱' + order.amount + '</div>'
      + '<div style="font-size:28px;font-weight:bold;letter-spacing:2px;margin-top:6px;">' + order.code + '</div>'
      + '</div>' + forLine + msgLine
      + '<p style="font-size:14px;color:#555;">Show this code at <strong>Morgen Kaffee – Dau</strong> or <strong>Kapebaluan by Morgen – Angeles</strong>. Valid 12 months from purchase. Spend it in one visit or across several — your barista tracks the balance.</p>'
      + '<p style="font-size:12px;color:#999;">Ref: ' + order.reference + '</p></div>',
  });
}

function issueVoucher(db, order, paymentId) {
  let code = newCode();
  while (db.vouchers[code]) code = newCode();
  order.status = 'PAID';
  order.paidAt = new Date().toISOString();
  order.code = code;
  order.paymentId = paymentId || null;
  db.vouchers[code] = {
    amount: order.amount, balance: order.amount,
    buyerEmail: order.buyerEmail, recipientName: order.recipientName,
    reference: order.reference, issuedAt: order.paidAt, redemptions: [],
  };
  db.log.unshift({ type: 'issued', code, amount: order.amount, reference: order.reference, at: nowPH() });
  save(db);
  sendVoucherEmail(order).catch(err => console.error('gift email failed (code still issued):', err.message));
  console.log('gift voucher issued:', code, 'for', order.reference);
  return code;
}

async function verifyPaidWithMaya(reference) {
  const res = await fetch(MAYA_BASE + '/payments/v1/payment-rrns/' + encodeURIComponent(reference), {
    headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.MAYA_SECRET_KEY + ':').toString('base64') },
  });
  if (!res.ok) return null;
  const payments = await res.json().catch(() => null);
  if (!Array.isArray(payments)) return null;
  const paid = payments.find(p => p.status === 'PAYMENT_SUCCESS');
  return paid ? (paid.id || 'verified') : null;
}

async function reconcileOrder(db, order) {
  if (!order || order.status === 'PAID') return null;
  try {
    const paymentId = await verifyPaidWithMaya(order.reference);
    if (paymentId) return issueVoucher(db, order, paymentId);
  } catch (e) {
    console.error('gift reconcile error for', order.reference, e.message);
  }
  return null;
}

module.exports = function giftVouchers(app) {

  // Customer: create Maya checkout
  app.post('/api/gift/checkout', async (req, res) => {
    try {
      const { amount, buyerName, buyerEmail, recipientName, message } = req.body || {};
      const amt = Math.round(Number(amount));
      if (!(amt >= 200 && amt <= 5000)) return res.status(400).json({ error: 'invalid_amount' });
      if (!buyerName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyerEmail || ''))
        return res.status(400).json({ error: 'invalid_buyer' });

      const reference = 'GV-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const checkout = await mayaCreateCheckout({
        totalAmount: { value: amt, currency: 'PHP' },
        buyer: { firstName: String(buyerName).slice(0, 80), contact: { email: buyerEmail } },
        items: [{ name: 'Morgen Kaffee Gift Voucher ₱' + amt, quantity: 1, totalAmount: { value: amt } }],
        requestReferenceNumber: reference,
        redirectUrl: {
          success: SITE + '/voucher-thank-you?ref=' + reference,
          failure: SITE + '/vouchers?payment=failed',
          cancel: SITE + '/vouchers?payment=cancelled',
        },
      });

      const db = load();
      db.orders[reference] = {
        reference, amount: amt,
        buyerName: String(buyerName).slice(0, 80),
        buyerEmail: String(buyerEmail).slice(0, 120),
        recipientName: String(recipientName || '').slice(0, 80),
        message: String(message || '').slice(0, 120),
        checkoutId: checkout.checkoutId || null,
        status: 'PENDING', createdAt: new Date().toISOString(),
      };
      save(db);
      res.json({ checkoutUrl: checkout.redirectUrl, reference });
    } catch (e) {
      console.error('gift/checkout error:', e.message);
      res.status(500).json({ error: 'checkout_failed' });
    }
  });

  // Maya webhook (register in Maya Manager: PAYMENT_SUCCESS →
  // https://vouchers.morgenkaffee.com/api/gift/webhook)
  app.post('/api/gift/webhook', (req, res) => {
    res.status(200).end(); // ack fast; Maya retries on non-200
    try {
      const evt = req.body || {};
      const reference = evt.requestReferenceNumber;
      const paid = evt.status === 'PAYMENT_SUCCESS' || evt.paymentStatus === 'PAYMENT_SUCCESS';
      console.log('gift webhook received:', reference || '(no ref)', evt.status || evt.paymentStatus || '(no status)');
      if (!reference || !paid) return;
      const db = load();
      const order = db.orders[reference];
      if (!order || order.status === 'PAID') return;
      issueVoucher(db, order, evt.id || evt.paymentId || null);
    } catch (e) {
      console.error('gift/webhook error:', e.message);
    }
  });

  // Customer: poll order status (self-healing: verifies with Maya if still pending)
  app.get('/api/gift/status/:reference', async (req, res) => {
    const db = load();
    const order = db.orders[req.params.reference];
    if (!order) return res.status(404).json({ status: 'NOT_FOUND' });
    if (order.status !== 'PAID') await reconcileOrder(db, order);
    res.json({ status: order.status, amount: order.amount, code: order.status === 'PAID' ? order.code : null });
  });

  // Resend the voucher email for a paid order (reference acts as the secret)
  app.get('/api/gift/resend/:reference', async (req, res) => {
    const db = load();
    const order = db.orders[req.params.reference];
    if (!order) return res.status(404).json({ ok: false, reason: 'not_found' });
    if (order.status !== 'PAID' || !order.code) return res.status(400).json({ ok: false, reason: 'not_paid' });
    try {
      await sendVoucherEmail(order);
      res.json({ ok: true, sentTo: order.buyerEmail });
    } catch (e) {
      console.error('gift resend failed:', e.message);
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  // Member lookup: MGV- gift codes show balance in the public Member tab.
  // Registered before the original /vouchers/check route; other codes fall through.
  app.get('/vouchers/check/:code', (req, res, next) => {
    const code = req.params.code.toUpperCase().trim();
    if (!code.startsWith('MGV-')) return next('route');
    const v = load().vouchers[code];
    if (!v) return res.json({ valid: false, reason: 'not_found' });
    const last = v.redemptions[v.redemptions.length - 1] || null;
    res.json({
      valid: v.balance > 0, gift: true,
      status: v.balance > 0 ? 'unused' : 'used',
      amount: v.amount, balance: v.balance,
      recipientName: v.recipientName || null,
      date: last ? last.date : null, branch: last ? last.branch : null,
    });
  });

  // Reconcile all pending orders against Maya (safe to call any time)
  app.get('/api/gift/reconcile', async (req, res) => {
    const db = load();
    const pending = Object.values(db.orders).filter(o => o.status !== 'PAID');
    const issued = [];
    for (const order of pending) {
      const code = await reconcileOrder(db, order);
      if (code) issued.push(order.reference);
    }
    res.json({ ok: true, checked: pending.length, issued: issued.length, references: issued });
  });

  // Staff: redeem MGV- gift codes through the EXISTING staff tool.
  // Registered before the original /vouchers/redeem route; non-gift codes fall through.
  app.post('/vouchers/redeem', requireRole('staff'), verifyCsrf, (req, res, next) => {
    const code = (req.body.code || '').toUpperCase().trim();
    if (!code.startsWith('MGV-')) return next('route');
    const branch = (req.body.branch || '').trim();
    const amount = parseFloat(req.body.amount);
    if (!branch) return res.status(400).json({ ok: false, reason: 'missing_branch' });
    if (!amount || amount < 1) return res.status(400).json({ ok: false, reason: 'invalid_amount' });
    const db = load();
    const v = db.vouchers[code];
    if (!v) return res.json({ ok: false, reason: 'invalid_code' });
    if (v.balance <= 0) return res.json({ ok: false, reason: 'already_used' });
    const deduction = Math.min(v.balance, amount);
    v.balance = +(v.balance - deduction).toFixed(2);
    const { date, time } = nowPH();
    v.redemptions.push({ amount: deduction, order: amount, branch, date, time });
    db.log.unshift({ type: 'redeemed', code, discount: deduction, balance: v.balance, branch, date, time });
    save(db);
    res.json({
      ok: true, code, label: 'Gift voucher ₱' + v.amount + (v.balance > 0 ? ' (₱' + v.balance + ' left)' : ' (fully used)'),
      discount: deduction, final: +(amount - deduction).toFixed(2), branch, date, time,
    });
  });

  // Admin: sales + voucher overview
  app.get('/api/gift/orders', requireRole('admin'), (req, res) => {
    const db = load();
    res.json({ ok: true, orders: db.orders, vouchers: db.vouchers, log: db.log });
  });
};
