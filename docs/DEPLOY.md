# gobiz-bridge — Panduan Deploy (Fase B)

Worker Cloudflare yang meniru API kriskris di atas sesi portal GoBiz milik
sendiri. Kode: `src/index.js` (satu file, tanpa build). Kontrak:
`../SPEC-JEMBATAN.md`, `../RECON-API-GOBIZ.md`,
`~/workspace/demo-store-kriskris/API-CONTRACT.md`.

## Mode v3 (folder ini — payload QRIS per-merchant)

- Semua perilaku v2 tetap. Satu-satunya perubahan: pembuatan invoice
  memakai **payload QRIS statis milik merchant itu sendiri** bila kolom
  D1 `merchants.qris_payload` terisi (merchant yang punya outlet GoBiz
  sendiri di akun pemilik yang sama, mis. outlet 'DemoFoundation'), dan
  jatuh ke env `STATIC_QRIS_PAYLOAD` bila kolomnya NULL — jadi semua
  merchant warisan v2 berperilaku persis seperti sebelumnya.
- Pencocokan transaksi TIDAK berubah: semua outlet tetap satu akun
  GoBiz → satu feed → total pending tetap unik secara GLOBAL.
- Deploy v3: `python3 deploy-v3.py` — menerapkan delta kolom
  `migration-v3.sql` (aditif, aman mendahului kode), mengunggah kode,
  memverifikasi jadwal cron + daftar nama secret tidak berubah. Tidak
  ada secret yang ditulis skrip ini.
- Mengatur payload merchant: `python3 update-payload.py --slug <slug>
  --payload-file <berkas>` (atau `--clear` untuk kembali ke fallback).
  Enrol merchant baru juga menerima `--qris-payload-file`.
- Rollback: unggah ulang bundle v2 (`python3 ../worker-v2/deploy.py`);
  kolom `qris_payload` yang tertinggal diabaikan v2 sepenuhnya.

## Mode v2 (multi-merchant)

- **Banyak merchant** dari tabel D1 **`merchants`**: satu baris per
  domain berisi `api_key`, `api_secret`, `callback_secret`,
  `callback_url`, dan flag `active`. Request masuk diresolusi
  BERDASARKAN API KEY; signature diverifikasi dengan secret baris itu;
  callback dikirim ke `callback_url` baris itu dan ditandatangani
  `callback_secret` baris itu (kebijakan retry tidak berubah).
- **Kompatibilitas mundur demo-store (keras):** baris `merchants` id
  `demo-store` di-seed dari nilai env yang sedang live
  (`python3 seed-demo-store.py`, membaca
  `~/workspace/gobiz-bridge/.bridge-secrets.json` tanpa mencetak nilai),
  dan bila barisnya tidak ada, resolusi jatuh kembali ke env persis
  seperti v1. Kredensial demo-store TIDAK berubah.
- **Keputusan v2 yang menggantikan catatan v1:** kredensial per-merchant
  DISIMPAN di D1 (bukan Worker secrets) — Worker secrets per merchant
  tidak terukur untuk banyak domain. Yang tetap di env/secrets hanya
  identitas outlet BERSAMA (`GOBIZ_EMAIL`, `GOBIZ_PASSWORD`,
  `STATIC_QRIS_PAYLOAD`) karena semua merchant memakai satu akun GoBiz
  pemilik yang sama; konsekuensinya keunikan total pending tetap
  GLOBAL per akun GoBiz, bukan per merchant.
- **Menambah domain baru:** `python3 enroll-merchant.py --slug <slug>
  --callback-url <https://…>` — menghasilkan trio kredensial, menyimpan
  baris D1, mencetak trio SEKALI untuk panel admin situs itu.
- Urutan upgrade dari v1 yang live: lihat **MIGRATION-V2.md**
  (migrasi D1 bersifat aditif & aman mendahului deploy kode).

## 1. Isi Worker secrets (dashboard Cloudflare, oleh pemilik)

Workers & Pages → **gobiz-bridge** → Settings → Variables and Secrets →
tambahkan sebagai **Secret** (nilainya tidak lewat chat & tidak di git):

| Nama | Isi |
|---|---|
| `GOBIZ_EMAIL` | Email login portal GoFood Merchant |
| `GOBIZ_PASSWORD` | Kata sandi portal (yang diatur pemilik via reset email portal) |
| `BRIDGE_API_KEY` | API key jembatan — nilai yang sama diisi ke panel admin demo-store (`cfg_kriskris_api_key`) |
| `BRIDGE_API_SECRET` | Secret tanda tangan request — sama dengan `cfg_kriskris_api_secret` di demo-store |
| `BRIDGE_CALLBACK_SECRET` | Secret tanda tangan callback — sama dengan `cfg_kriskris_callback_secret` di demo-store |
| `STATIC_QRIS_PAYLOAD` | String payload EMV QRIS statis outlet apa adanya (dari kode QRIS outlet) |

Yang BUKAN secret (sudah di `wrangler.toml` [vars]): `GOBIZ_APP_VERSION`
(nilai build portal — perbarui di sini bila portal naik versi, tanpa ubah
kode) dan `CALLBACK_URL` (`https://demo-store.example.com/api/webhook-kriskris`).

## 2. Buat database D1 + terapkan skema

Dashboard: Storage & Databases → D1 → Create database → nama
**`gobiz-bridge`** → salin **database_id**-nya ke `wrangler.toml`
(ganti `PLACEHOLDER-...`). Terapkan `schema.sql`: buka database →
Console → tempel isi `schema.sql` → Execute.

Setara wrangler CLI:

```bash
wrangler d1 create gobiz-bridge
wrangler d1 execute gobiz-bridge --file=schema.sql --remote
```

## 3. Deploy

```bash
cd worker
wrangler deploy
```

Atau lewat helper connector Cloudflare yang sudah ada (akun yang sama
dengan PixaBooth): bungkus `src/index.js` sebagai bundle lalu
`cf.py script-put <bundle.js> <metadata.json>` dengan binding D1 `DB`,
vars di atas, dan cron `*/1 * * * *` — pastikan nama script
`gobiz-bridge` dan database_id D1 yang benar di metadata.

Di sisi demo-store (Fase C, terpisah): arahkan base URL `lib/kriskris.js`
ke URL Worker ini dan isi tiga nilai `cfg_kriskris_*` dengan
`BRIDGE_API_KEY` / `BRIDGE_API_SECRET` / `BRIDGE_CALLBACK_SECRET`.

## 4. Smoke test

```bash
curl https://gobiz-bridge.<subdomain>.workers.dev/health
```

Harapan (bukti login password GoBiz bekerja dari egress Cloudflare):

```json
{"ok":true,"data":{"service":"gobiz-bridge","time":"…",
 "merchants":[{"id":"demo-store","active":true,"session":"active","gobiz_merchant_id":"G…"}]}}
```

`session` harus `active` dan `gobiz_merchant_id` terisi id outlet
(`G` + 9 digit). Bila `inactive`: periksa `GOBIZ_EMAIL`/`GOBIZ_PASSWORD`
dan log Worker (dashboard → Logs) — pesan error GoBiz diteruskan apa
adanya ke log, tanpa nilai rahasia.

Lalu uji callback: panggil `POST /admin/test-ping` dengan header auth
API yang sama seperti request kriskris (X-API-Key + timestamp +
signature) → demo-store harus menerima event `test.ping` bertanda tangan
valid dan membalas 2xx.

## TODO yang diketahui

- Rate limit 60 req/menit per API key (kontrak kriskris) belum ditegakkan
  di v1 — klien satu-satunya adalah demo-store sendiri.
