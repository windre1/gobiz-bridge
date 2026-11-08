# gobiz-bridge

**Turn your own GoBiz (GoPay Merchant) account into a programmable QRIS payment API.**

`gobiz-bridge` is a self-hosted [Cloudflare Worker](https://workers.cloudflare.com/)
that sits in front of a GoBiz merchant session and exposes a clean,
[kriskris](https://kriskris.id)-compatible API for your websites: create an
invoice, get a dynamic QRIS code, and receive a signed callback the moment the
payment lands. It was built to run real production checkouts — and it does,
every day, for several live Indonesian websites.

> **No custody, ever.** Payments settle directly into *your own* GoPay merchant
> balance. The bridge never holds, routes, or touches your money. The name a
> payer sees when scanning the QR code is *your own outlet name*.

---

## Why this exists

Indonesian micro and small businesses that sell through their own websites have
no official self-serve API for GoBiz/GoPay Merchant. The practical choices are
manual transfer checks, or third-party aggregator accounts where the merchant
of record is someone else. `gobiz-bridge` is a third option: a small piece of
infrastructure you run yourself, on your own Cloudflare account, against your
own GoBiz account.

## How it works

```
your website ──► gobiz-bridge (Worker + D1) ──► GoBiz merchant session
     ▲                    │
     └──── signed callback when an invoice is matched as paid
```

1. Your website creates an invoice through the bridge API
   (`X-API-Key` / `X-API-Secret` per merchant).
2. The bridge builds a **dynamic QRIS payload** from your outlet's static QRIS:
   the amount tag is rewritten to `invoice total + unique code (10–99)` and the
   CRC16 is recomputed, so every pending invoice has a globally unique total.
3. A 1-minute cron polls the GoBiz transaction list **only while invoices are
   pending**, and matches incoming payments by exact total.
4. On a match, the invoice flips to `paid` and the bridge fires an
   **HMAC-signed callback** to your website (with retries), so orders,
   licences, or donations activate automatically.

## Features

- **Multi-merchant** — one bridge instance serves many websites; each merchant
  gets its own API key/secret/callback secret trio and its own callback URL.
- **Per-merchant QRIS payload (v3)** — merchants with their own outlet store
  their own static QRIS payload; the rest fall back to the instance default.
- **Session resilience** — the GoBiz session is kept alive with refresh-token
  rotation stored in D1; the merchant password itself is only used at setup
  time via the secrets store and is never written to the database.
- **Idempotent fulfilment contract** — signed callbacks with amount checks on
  the receiving side; duplicate deliveries are safe.
- **Cheap to run** — a Worker + D1 + a 1-minute cron that exits immediately
  when there is nothing pending. Fits comfortably in Cloudflare's free tier
  for small merchants.
- **Tested** — `node test-local.mjs` runs a 20-case local suite (v1 API
  contract, v2 multi-merchant, v3 per-merchant payloads) against fetch stubs.
  No network, no real account needed.

## Quick start

Prerequisites: a Cloudflare account, an active **GoBiz Merchant** account with
a static QRIS for your outlet, and Node 18+.

```bash
# 1. Create the D1 database and apply the schema
wrangler d1 create gobiz-bridge
wrangler d1 execute gobiz-bridge --remote --file schema.sql

# 2. Configure
cp wrangler.toml.example wrangler.toml   # fill in your D1 database id

# 3. Set the secrets (never commit these)
wrangler secret put GOBIZ_EMAIL
wrangler secret put GOBIZ_PASSWORD
wrangler secret put STATIC_QRIS_PAYLOAD   # your outlet's static QRIS string

# 4. Deploy
wrangler deploy
```

Then enrol your first merchant (generates its API trio) and wire your website's
checkout + webhook to the contract in [docs/API-CONTRACT.md](docs/API-CONTRACT.md):

```bash
python3 tools/enroll-merchant.py --id my-shop --callback-url https://example.com/api/webhook
```

Full walkthrough: [docs/DEPLOY.md](docs/DEPLOY.md).

## Repository layout

| Path | What |
|---|---|
| `src/index.js` | The Worker: API, QRIS builder, matcher cron, callback dispatcher |
| `schema.sql`, `migration-v2.sql`, `migration-v3.sql` | D1 schema and migrations |
| `test-local.mjs` | 20-case offline test suite (`npm test`) |
| `tools/` | Operator scripts: deploy, merchant enrolment, D1 admin, QRIS payload update |
| `docs/` | API contract, deployment guide, v2 migration notes |
| `wrangler.toml.example` | Configuration template (the real `wrangler.toml` is git-ignored) |

## Honest limitations

- **Unofficial.** This project is **not affiliated with, endorsed by, or
  supported by Gojek, GoTo, GoPay, or kriskris.id.** It talks to the GoBiz
  merchant portal the same way the official web dashboard does. That is a
  grey area under GoBiz's terms: if Gojek changes the portal or closes a
  session, the bridge can stop working until it is reconnected or updated.
  Run it with that risk in mind — it is a tool for merchants who accept the
  trade-off, not a guaranteed payment rail.
- **One GoBiz account per instance.** A bridge instance holds exactly one
  GoBiz session. Multiple outlets under one account are fine; separate
  accounts need separate instances.
- You are responsible for your own tax, bookkeeping, and compliance duties as
  a merchant. The bridge is bookkeeping-neutral infrastructure.

## Ringkasan (Bahasa Indonesia)

`gobiz-bridge` adalah jembatan pembayaran QRIS yang Anda pasang sendiri:
sebuah Cloudflare Worker yang mengubah akun GoBiz (GoPay Merchant) milik Anda
menjadi API pembayaran bergaya kriskris — buat invoice, tampilkan QRIS
dinamis berkode unik, dan terima callback bertanda tangan saat pembayaran
masuk. Dana selalu masuk langsung ke GoPay Anda sendiri; jembatan ini tidak
pernah memegang uang Anda. Satu instance bisa melayani banyak website
(multi-merchant), dan biaya jalannya cukup di tier gratis Cloudflare untuk
skala UMKM. Proyek ini tidak berafiliasi dengan Gojek/GoTo/GoPay/kriskris.id
dan memakai sesi portal GoBiz — baca bagian *Honest limitations* di atas
sebelum memakai.

## Contributing

Issues and pull requests are welcome — especially reports of GoBiz portal
changes (app version bumps, response-shape changes), which are the main
maintenance burden of this project. Please never include real credentials,
QRIS payloads, or transaction data in issues or PRs.

## License

[MIT](LICENSE)
