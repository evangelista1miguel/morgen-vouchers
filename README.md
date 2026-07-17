# Morgen Vouchers — auth system (updated)

## What changed

The old version had two serious problems, both now fixed:

1. **`STAFF_PWD`, `ADMIN_PWD`, and `SERVER_KEY` were hardcoded in
   `public/index.html`** — anyone could view-source the live site and
   read the real admin password and API key. All gone now.
2. **`POST /vouchers/redeem` had no authentication at all** — anyone
   who found the URL could mark real vouchers as redeemed, no
   password needed. It now requires a logged-in `staff` or `admin`
   session.

## How auth works now

- **Sessions**: JWT signed server-side, stored in an `httpOnly`,
  `Secure` (in production), `SameSite=Strict` cookie — never touches
  client-readable storage.
- **Passwords**: bcrypt-hashed, stored in `data.json` alongside your
  existing vouchers/tiers/log (same file, same persistence you already
  have via the Render Disk).
- **CSRF**: a double-submit-cookie token, fetched once via `GET /csrf`
  and sent back as the `x-csrf-token` header on every state-changing
  request.
- **Rate limiting**: 5 login attempts / 15 min per IP.
- **Roles**: `staff` can redeem vouchers; `admin` can do that plus
  create/delete tiers, generate batches, and view the dashboard/log.
  Admins can do anything staff can.

Routes changed:
| Route | Before | Now |
|---|---|---|
| `POST /vouchers/redeem` | open to anyone | requires `staff` login |
| `POST /vouchers/tiers` | `x-admin-key` header | requires `admin` login |
| `DELETE /vouchers/tiers/:key` | `x-admin-key` header | requires `admin` login |
| `POST /vouchers/generate` | `x-admin-key` header | requires `admin` login |
| `GET /vouchers/tiers` | `x-admin-key` header | requires `admin` login |
| `GET /vouchers/list` | `x-admin-key` header | requires `admin` login |
| `GET /vouchers/summary` | `x-admin-key` header | requires `admin` login |
| `GET /vouchers/check/:code` | public | **unchanged** — still public, this is the customer-facing lookup |

## Before you deploy

**Create real accounts.** The old shared passwords (`morgen-staff`,
`morgen2026admin`) are gone — nobody can log in until you create real
accounts:

```bash
node scripts/create-user.js admin "a-strong-real-password" admin
node scripts/create-user.js yourbaristaname "another-real-password" staff
```

Run this once locally (with the same `DATA_DIR` your production
service uses, or via Render's Shell tab after deploying) for every
staff member and admin who needs access. Give each person their own
account rather than going back to one shared password — it's more
secure and lets you see who did what in the log.

**Set environment variables on Render:**
- `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `NODE_ENV=production`
- `DATA_DIR` — confirm this already points at your Disk's mount path (check Render → this service → Disk, and → Environment, to make sure they match). If it's not set, data won't survive the next deploy.

## After deploying

Tell your staff their new individual username + password — the old
shared passwords won't work anymore.
