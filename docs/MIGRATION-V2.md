# gobiz-bridge v2 — Multi-Merchant: Delta Desain, Rencana Migrasi, Checklist Deploy

Status: **STAGED** di folder `worker-v2/` (salinan `worker/` + perubahan).
Belum ada yang di-deploy dan belum ada mutasi ke D1/Worker live.
Kode v1 di `worker/` tidak disentuh sama sekali.

## 1. Delta desain vs v1

| Aspek | v1 (live) | v2 (staged) |
|---|---|---|
| Sumber kredensial merchant | Env saja (`BRIDGE_API_KEY/SECRET/CALLBACK_SECRET` + `CALLBACK_URL`), satu merchant `demo-store` | Tabel D1 `merchants` per baris: `api_key`, `api_secret`, `callback_secret`, `callback_url`, `active`. Env menjadi **fallback khusus `demo-store`** |
| Resolusi request masuk | Bandingkan key dengan satu env key | **Berdasarkan API key**: `SELECT … WHERE api_key = ?` → secret baris itu yang memverifikasi signature; baris menang atas env; tidak ada baris → fallback env (perilaku v1 persis) |
| Callback keluar | `CALLBACK_URL` env tunggal | `callback_url` + `callback_secret` **milik merchant invoice itu**; kebijakan retry sama (1 awal + 5 retry: 1m/5m/30m/2h/12h, delivery_id stabil) |
| Antrean callback | Merchant diikuti lewat invoice; test.ping → default | Kolom baru `callbacks.merchant_id` dicatat saat enqueue → retry selalu tahu pemiliknya; baris lama (NULL) tetap diikuti lewat invoice, lalu default (kompatibel) |
| Merchant nonaktif | — | `active = 0` → auth API ditolak seperti key tak dikenal; resolusi by-id tetap jalan supaya callback invoice lamanya tetap diselesaikan |
| Identitas GoBiz & QRIS statis | Env | **Tetap env, bersama untuk semua merchant** — semua domain memakai SATU akun GoBiz pemilik (outlet `G010974358`). Sesi per merchant jembatan berbagi kredensial yang sama, seperti v1 |
| Keunikan total pending | Global per akun GoBiz | **Dipertahankan & ditegaskan** — `getPendingTotals()` sengaja TANPA filter merchant; transaksi satu akun tidak membawa label domain |
| Invoice | `merchant_id` sudah ada | Tidak berubah; payload callback tetap memuat `merchant_id` (kontrak kriskris) |
| `/health` | `{id, session, gobiz_merchant_id}` per merchant | Ditambah `active` per merchant; tetap tanpa rahasia (dijaga test) |
| Enrol merchant baru | Manual | `enroll-merchant.py`: generate trio (format sama: `gob_`+32 hex, secret 64 hex), upsert baris D1, cetak trio **sekali** ke stdout, tidak menulis berkas |
| Keputusan yang diganti | v1 menahan secret per-merchant di Worker secrets | v2 menyimpan kredensial per-merchant **di D1** — secret Worker per merchant tidak terukur untuk banyak domain; D1 sudah memegang data setara-sensitif (token sesi GoBiz) |

Fungsi yang berubah di `src/index.js` hanya sekitar resolusi merchant:
`envMerchant()` (nama baru untuk `defaultMerchant`, alias dipertahankan),
`rowToMerchantContext()`, `resolveMerchant()` / `resolveMerchantById()` /
`listMerchants()` (kini async, membaca D1), `processDueCallbacks()`
(resolusi per baris), `healthHandler()` (flag active), dan INSERT
`callbacks` (kolom `merchant_id`). Handler invoice, sesi GoBiz, polling,
pencocokan, dan format signature **tidak berubah**.

## 2. Rencana migrasi D1 live (pernyataan persis)

Database: `gobiz-bridge` = `YOUR-D1-DATABASE-ID`.
Satu-satunya kendaraan migrasi yang disarankan: **`python3 seed-demo-store.py`**
(atau `--dry-run` dulu). Ia melakukan, berurutan:

1. Memeriksa `PRAGMA table_info(merchants)` dan `PRAGMA table_info(callbacks)`,
   lalu menerapkan HANYA ALTER yang kurang dari daftar ini (identik dengan
   isi `migration-v2.sql`):

   ```sql
   ALTER TABLE merchants ADD COLUMN api_secret TEXT;
   ALTER TABLE merchants ADD COLUMN callback_secret TEXT;
   ALTER TABLE merchants ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE callbacks ADD COLUMN merchant_id TEXT;
   ```

2. Meng-upsert baris merchant `demo-store` dengan nilai yang SEDANG live
   (`BRIDGE_API_KEY`, `BRIDGE_API_SECRET`, `BRIDGE_CALLBACK_SECRET` dibaca
   dari `~/workspace/gobiz-bridge/.bridge-secrets.json` — file yang sama
   yang dipakai `deploy.py` untuk Worker secrets — plus
   `callback_url = https://demo-store.example.com/api/webhook-kriskris`,
   `name = 'Gama Pro'`, `domain = 'demo-store.example.com'`, `active = 1`).
   Nilai tidak pernah dicetak oleh script.

Catatan: langkah `schema.sql` di `deploy.py` TIDAK menerapkan delta ini
(`CREATE TABLE IF NOT EXISTS` tidak menambah kolom ke tabel yang sudah
ada) — karena itu urutannya seed dulu, deploy kode sesudahnya.

### Argumen nol-downtime

- Semua perubahan D1 bersifat **aditif murni**: 4 kolom baru, tanpa
  penghapusan/penamaan-ulang/perubahan tipe, tanpa menyentuh baris lama.
  Baris callback lama mendapat `merchant_id = NULL` → resolusi v2
  memperlakukannya persis seperti v1 (lewat invoice, lalu default).
- Kode **v1 mengabaikan** tabel `merchants` dan kolom-kolom baru
  sepenuhnya, jadi migrasi D1 aman dijalankan saat v1 masih melayani
  trafik — tidak ada jendela di mana skema dan kode tidak cocok.
- Setelah deploy kode v2, auth demo-store menghasilkan konteks yang
  **identik** lewat dua jalur independen (baris D1 hasil seed = nilai
  env; atau fallback env bila baris hilang) — key/secret/callback URL
  yang dipakai panel demo-store tidak berubah sama sekali.
- Invoice pending yang sedang berjalan tidak disentuh migrasi;
  pencocokan + callback-nya berjalan dengan konteks merchant yang sama.
- Rollback = upload ulang bundle v1 (`worker/src/index.js`); kolom dan
  baris seed yang tertinggal di D1 bersifat inert bagi v1.

## 3. Hasil verifikasi (lokal, tanpa jaringan keluar)

- `node --check src/index.js` ✅
- `node test-local.mjs` → **16/16 LULUS**: 9 test v1 tidak berubah hasil
  (CRC, EMV ×2, signature masuk ×3, signature callback, pickUniqueCode,
  resolusi env) + 7 test v2 baru:
  resolusi by-key & prioritas D1 > env & fallback utuh; signature
  lintas-merchant ditolak; merchant nonaktif ditolak; callback_url +
  secret per merchant pada test.ping DAN retry cron (termasuk baris
  model lama); tabrakan total global lintas merchant dicegah (kode
  bergeser 30 → 31); isolasi invoice antar-merchant (404/found:false);
  /health tanpa kebocoran rahasia.
- `python3 -m py_compile` untuk `d1admin.py`, `seed-demo-store.py`,
  `enroll-merchant.py` ✅ (tidak dijalankan — staging).
- Pemindaian kebocoran: tidak ada nilai dari `.bridge-secrets.json`
  yang muncul di berkas mana pun di `worker-v2/` ✅.
- `worker/` (v1) utuh: checksum `src/index.js` sama seperti sebelum
  staging, dan suite v1 di folder itu tetap 9/9 ✅.

## 4. Checklist deploy (UNTUK DIJALANKAN NANTI — jangan sekarang)

1. `cd ~/workspace/gobiz-bridge/worker-v2 && node --check src/index.js && node test-local.mjs` → 16/16.
2. `python3 seed-demo-store.py --dry-run` → tinjau rencana (4 ALTER bila belum ada + upsert demo-store), lalu `python3 seed-demo-store.py`.
3. Verifikasi baris tanpa rahasia via API D1:
   `SELECT id, domain, callback_url, active FROM merchants` → satu baris `demo-store`, active 1.
4. Upload bundle v2 memakai alur `deploy.py` di folder ini (ROOT sudah diarahkan ke `worker-v2`): bindings/vars/schedule/subdomain sama; Worker secrets TIDAK diubah (env fallback tetap sama).
5. `curl https://gobiz-bridge.your-subdomain.workers.dev/health` → merchants memuat `demo-store` dengan `active: true`, `session: "active"`, `gobiz_merchant_id: "G010974358"`.
6. Panel admin demo-store → Tes Koneksi kriskris → sukses (invoice uji Rp1.000 dibuat + dibatalkan terhadap bridge).
7. Pantau pesanan nyata pertama setelah deploy: invoice → paid, baris `callbacks` terkirim `last_status` 200 (jalur produksi yang sama seperti bukti Fase C).
8. Untuk domain berikutnya (mis. demo-shop): `python3 enroll-merchant.py --slug demo-shop --callback-url https://demo-shop.my.id/api/webhook-kriskris --domain demo-shop.my.id` → salin trio yang tercetak SEKALI ke panel admin situs itu, lalu uji test.ping dari sisi situs.
