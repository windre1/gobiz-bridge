-- gobiz-bridge — skema D1 (v3, multi-merchant + payload QRIS per-merchant)
-- Semua timestamp disimpan sebagai INTEGER epoch milidetik (UTC).
-- File ini idempoten untuk instalasi BARU maupun pemeriksaan ulang
-- (CREATE TABLE/INDEX IF NOT EXISTS). Untuk database yang SUDAH
-- berjalan, jalankan delta di migration-v3.sql (atau update-payload.py /
-- enroll-merchant.py v3 yang menerapkannya secara terprogram).
--
-- Catatan multi-merchant v2: tabel `merchants` kini SUMBER KEBENARAN
-- kredensial per domain — api_key, api_secret, dan callback_secret
-- disimpan per baris (keputusan v2; menggantikan catatan v1 yang
-- menahan secret di Worker secrets). Yang TETAP di Worker secrets/env
-- hanya identitas outlet bersama (GOBIZ_EMAIL, GOBIZ_PASSWORD) dan
-- payload FALLBACK (STATIC_QRIS_PAYLOAD) karena semua merchant memakai
-- SATU akun GoBiz pemilik yang sama. Merchant default 'default' juga
-- tetap bisa diresolusi dari env (BRIDGE_API_KEY/SECRET/CALLBACK_SECRET
-- + CALLBACK_URL) sebagai fallback kompatibilitas mundur.
-- Catatan v3: kolom `merchants.qris_payload` (NULL = pakai fallback
-- env) memungkinkan merchant dengan outlet GoBiz sendiri memakai
-- payload statis outletnya; pencocokan transaksi tetap global per akun.

CREATE TABLE IF NOT EXISTS merchants (
  id                TEXT PRIMARY KEY,          -- id internal jembatan, mis. 'default', 'demo-shop'
  name              TEXT,
  domain            TEXT,
  api_key           TEXT UNIQUE,               -- X-API-Key milik domain ini
  api_secret        TEXT,                      -- secret tanda tangan request domain ini (v2)
  callback_secret   TEXT,                      -- secret tanda tangan callback domain ini (v2)
  callback_url      TEXT,
  qris_payload      TEXT,                      -- v3: payload QRIS statis outlet merchant ini; NULL = fallback env STATIC_QRIS_PAYLOAD
  active            INTEGER NOT NULL DEFAULT 1, -- 0 = auth API ditolak; callback lama tetap diselesaikan (v2)
  gobiz_merchant_id TEXT,                      -- id outlet GoBiz ('G' + 9 digit), terisi saat discovery
  created_at        INTEGER
);

CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,              -- 'inv-' + uuid
  merchant_id   TEXT NOT NULL DEFAULT 'default',
  label         TEXT,
  base_amount   INTEGER NOT NULL,              -- harga dasar (rupiah)
  unique_code   INTEGER NOT NULL,              -- 10–99
  total         INTEGER NOT NULL,              -- base_amount + unique_code
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|paid|expired|cancelled
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,              -- created_at + 15 menit
  paid_at       INTEGER,
  matched_tx_id TEXT,                          -- id transaksi GoBiz yang cocok
  created_via   TEXT DEFAULT 'api'
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_merchant_status ON invoices (merchant_id, status);

-- Sesi GoBiz per merchant jembatan (satu baris per merchant).
-- access/refresh token adalah JWE dari portal; refresh token BEROTASI —
-- pasangan tersimpan selalu yang terbaru. Perlakukan tabel ini sebagai
-- rahasia: isinya setara kata sandi akun.
CREATE TABLE IF NOT EXISTS session (
  merchant_id   TEXT PRIMARY KEY,
  access_token  TEXT,
  refresh_token TEXT,
  updated_at    INTEGER
);

-- Konfigurasi non-rahasia per kunci, mis. 'gobiz_merchant_id:default' → 'G…'.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Antrean callback keluar. merchant_id dicatat sejak v2 agar retry
-- selalu memakai callback_url + callback_secret merchant yang benar;
-- baris lama (NULL) diikuti lewat invoice_id → invoices.merchant_id,
-- sisanya jatuh ke merchant default (perilaku v1).
-- delivery_id stabil lintas retry; attempts = jumlah kirim yang sudah
-- dilakukan; delivered_at NULL + next_attempt_at NULL = menyerah (maks).
CREATE TABLE IF NOT EXISTS callbacks (
  delivery_id     TEXT PRIMARY KEY,
  invoice_id      TEXT,
  merchant_id     TEXT,                        -- v2: pemilik callback ini
  event           TEXT NOT NULL,               -- invoice.paid|invoice.expired|test.ping
  payload         TEXT NOT NULL,               -- JSON mentah persis seperti dikirim
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  delivered_at    INTEGER,
  last_status     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_callbacks_due ON callbacks (delivered_at, next_attempt_at);

-- Transaksi GoBiz yang sudah dipakai mencocokkan invoice (dedupe global
-- per akun GoBiz — satu transaksi tidak boleh membayar dua invoice).
CREATE TABLE IF NOT EXISTS used_tx (
  tx_id      TEXT PRIMARY KEY,
  invoice_id TEXT,
  seen_at    INTEGER
);

-- =====================================================================
-- MIGRASI dari skema v1 (database yang SUDAH berjalan) — pernyataan di
-- bawah ini SENGAJA dikomentari di file skema utama: SQLite tidak punya
-- ADD COLUMN IF NOT EXISTS, jadi jalankan SEKALI saja lewat
-- migration-v2.sql / tools/enroll-merchant.py (yang memeriksa PRAGMA lebih dulu).
-- =====================================================================
-- ALTER TABLE merchants ADD COLUMN api_secret TEXT;
-- ALTER TABLE merchants ADD COLUMN callback_secret TEXT;
-- ALTER TABLE merchants ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE callbacks ADD COLUMN merchant_id TEXT;
--
-- Delta v3 (database v2 yang sudah berjalan) — sama: jalankan SEKALI
-- saja lewat migration-v3.sql / perkakas v3 (PRAGMA lebih dulu):
-- ALTER TABLE merchants ADD COLUMN qris_payload TEXT;
