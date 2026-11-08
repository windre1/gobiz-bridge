# SPEC — Jembatan GoBiz Sendiri (Fase B)

Tujuan: Cloudflare Worker yang meniru kontrak kriskris PERSIS, supaya integrasi
demo-store yang sudah live (lib/kriskris.js) cukup ganti base URL + key/secret.
Sumber kontrak: ~/workspace/demo-store-kriskris/API-CONTRACT.md dan
~/workspace/gobiz-bridge/RECON-API-GOBIZ.md. Fase A terbukti 2026-10-29:
login portal email+password tanpa OTP, data transaksi terbaca.

## Komponen

1. **Worker `gobiz-bridge`** (satu script, account Cloudflare yang sama dengan
   PixaBooth). Bindings: D1 database baru `gobiz-bridge` + Cron Trigger tiap 1 menit.
2. **Secrets (diisi owner di dashboard Cloudflare, tidak lewat chat)**:
   `GOBIZ_EMAIL`, `GOBIZ_PASSWORD`, `BRIDGE_API_KEY`, `BRIDGE_API_SECRET`,
   `BRIDGE_CALLBACK_SECRET`, `STATIC_QRIS_PAYLOAD` (payload EMV QRIS statis outlet).
   Nilai BRIDGE_* digenerate Muse sekali, ditampilkan ke owner SEKALI untuk
   disalin ke dashboard + panel admin demo-store (kriskris section).
3. **Config non-secret (vars)**: `GOBIZ_APP_VERSION` (default versi portal live,
   bisa diubah tanpa deploy ulang kode — baca dari wrangler vars),
   `CALLBACK_URL` default `https://demo-store.example.com/api/webhook-kriskris`.

## API publik (tiruan kriskris, path & header sama persis)

- `POST /api/v1/external/invoices` — header `X-API-Key`, `X-Kriskris-Timestamp`
  (RFC3339 UTC, toleransi ±5 menit), `X-Kriskris-Signature: v1=<hex>`
  (canonical 5 baris: timestamp, METHOD, path, raw query, hex(sha256(body));
  HMAC-SHA256 dengan BRIDGE_API_SECRET). Body `{amount, label}` →
  201 `{ok:true, data:{id:"inv-…", status:"pending", amount:<total>,
  base_amount, unique_code, label, qr_payload, expires_at}}`.
  Kode unik acak 10–99; total = base + kode; satu total pending yang sama tidak
  boleh ganda (coba kode lain, maks 90 → 422 duplicate_pending). Umur 15 menit.
  `qr_payload` = STATIC_QRIS_PAYLOAD dengan tag 54 (amount) diisi total +
  CRC16-CCITT dihitung ulang (EMVCo). Min amount Rp1.000 → 422 invalid_amount.
- `GET /api/v1/external/invoices/{id}` → status invoice.
- `GET /api/v1/external/invoices/status?ids=a,b` (maks 50) → per id `{id, found, status?...}`;
  id tak dikenal `{id, found:false}`.
- `POST /api/v1/external/invoices/{id}/cancel` → status cancelled.
- Envelope error `{ok:false, error}`; 401 auth gagal; 429 rate limit per key
  (60/menit, longgar saja via D1 counter atau abaikan di v1 — catat sebagai TODO).
- Event callback keluar: POST ke CALLBACK_URL, header `X-Kriskris-Event`
  (`invoice.paid` | `invoice.expired` | `test.ping`), `X-Kriskris-Delivery`
  (uuid), `X-Kriskris-Signature: sha256=<hex>` = HMAC-SHA256 atas RAW body
  dengan BRIDGE_CALLBACK_SECRET. Payload paid: `{event, delivery_id,
  invoice_id, merchant_id, amount:<TOTAL>, base_amount, unique_code, label,
  status:"paid", paid_at}`. Retry ≤5× (1m, 5m, 30m, 2h, 12h) delivery_id sama —
  antrian retry diproses cron.
- Endpoint kecil tambahan: `POST /admin/test-ping` (auth sama) → kirim
  test.ping ke CALLBACK_URL. (Dipakai saat penyambungan; demo-store tidak butuh.)

## Sesi GoBiz (di dalam Worker)

- Header set persis kavionn (lihat RECON § header /goid/*), auth host
  `https://api.gobiz.co.id`, client_id `go-biz-web-new`, X-AppVersion dari vars.
- Login: `POST /goid/login/request {email, login_type:"password", client_id}`
  lalu `POST /goid/token {client_id, grant_type:"password", data:{email, password}}`.
- Simpan access+refresh di D1 tabel `session` (satu baris). Urutan pakai:
  cache → kalau 401: refresh (grant_type refresh_token; ROTASI — simpan pair
  baru) → kalau gagal: login password ulang.
- Merchant discovery sekali: `POST /v1/merchants/search {from:0,size:20}` →
  simpan merchant_id (G…) di D1 config. Probe sesi = endpoint yang sama.

## Polling & pencocokan (cron tiap 1 menit)

1. Kalau tidak ada invoice pending & tidak ada retry callback jatuh tempo →
   langsung selesai (tanpa menyentuh Gojek).
2. Ambil transaksi: `GET api.gojekapi.com/merchant-analytics/v2/merchants/
   transactions` jendela [invoice tertua pending − 5 menit, sekarang],
   statuses SETTLEMENT,CAPTURE (tambah REFUND dsb. seperti RECON),
   payment_types QRIS,GOPAY,…, merchant_ids=<id>. gross_amount CENTS → /100.
3. Cocokkan: transaksi yang `gross_amount/100` == invoice.total dan
   transaction_time >= invoice.created_at − toleransi, belum pernah dipakai
   (dedupe by transaction id di D1). Satu transaksi = satu invoice.
4. Ketemu → invoice `paid` (paid_at dari settlement/transaction time),
   buat baris callback (delivery_id baru) & kirim segera; gagal kirim →
   jadwal retry.
5. Invoice lewat expires_at tanpa pasangan → `expired` + callback expired.
6. Jeda etis: cron 1 menit hanya saat ada pending — sesuai pola anti-ban RECON.

## Skema D1

- `invoices(id TEXT PK, label, base_amount INT, unique_code INT, total INT,
  status, created_at, expires_at, paid_at, matched_tx_id, created_via)`
- `session(id INTEGER PK CHECK(id=1), access_token, refresh_token, updated_at)`
- `config(key PK, value)` — merchant_id, dll.
- `callbacks(delivery_id PK, invoice_id, event, payload, attempts,
  next_attempt_at, delivered_at, last_status)`
- `used_tx(tx_id PK, invoice_id, seen_at)`

## Urutan bangun

1. Scaffold Worker + D1 schema + handler sesi (login/refresh/search) +
   endpoint `GET /health` yang melaporkan status sesi (tanpa rahasia).
2. Deploy → smoke test dari Cloudflare: /health harus menunjukkan sesi hidup
   + merchant_id ketemu (BUKTI password grant dari egress Cloudflare).
3. API invoice + QR payload + polling + callback.
4. Uji lokal logika EMV/CRC + signature dengan test vectors kriskris yang ada
   (stage1/test-kriskris-local.js pola yang sama).
5. Fase C terpisah: demo-store tambah setting base URL, arahkan, uji bayar.
