// Usage:
//   node scripts/create-user.js <username> <password> <role: staff|admin>
//
// Run this on your machine or Render's Shell tab — never commit
// plaintext passwords, and never run this by pasting a password into
// this chat. Hashes the password with bcrypt before it touches disk.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const [, , username, password, role] = process.argv;
if (!username || !password || !['staff', 'admin'].includes(role)) {
  console.error('Usage: node scripts/create-user.js <username> <password> <staff|admin>');
  process.exit(1);
}

let store = { vouchers: {}, tiers: {}, log: [], users: {} };
if (fs.existsSync(DATA_FILE)) {
  store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store.users = store.users || {};
}

store.users[username] = {
  passwordHash: bcrypt.hashSync(password, 12),
  role,
};

fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
console.log(`Saved user "${username}" (role: ${role}) to ${DATA_FILE}`);
