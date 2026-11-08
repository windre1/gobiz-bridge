-- gobiz-bridge — MIGRASI v1 → v2 (jalankan SEKALI pada D1 yang live)
-- ---------------------------------------------------------------------
-- SQLite TIDAK mendukung ADD COLUMN IF NOT EXISTS. Sebelum menjalankan
-- file ini, periksa dulu kolom yang sudah ada:
--   PRAGMA table_info(merchants);
--   PRAGMA table_info(callbacks);
-- dan HAPUS baris ALTER untuk kolom yang sudah ada. Alternatif yang
-- aman dijalankan berulang: `python3 tools/enroll-merchant.py` — ia memeriksa
-- PRAGMA secara terprogram, menerapkan hanya ALTER yang kurang, lalu
-- meng-upsert baris merchant 'default' dari nilai yang sedang live.
--
-- Semua pernyataan bersifat ADITIF: tidak ada kolom/tabel yang dihapus
-- atau diubah tipenya, tidak ada baris yang disentuh. Kode v1 mengabaikan
-- kolom-kolom baru ini sepenuhnya, jadi migrasi aman diterapkan SEBELUM
-- deploy kode v2 (nol downtime — lihat MIGRATION-V2.md).

ALTER TABLE merchants ADD COLUMN api_secret TEXT;
ALTER TABLE merchants ADD COLUMN callback_secret TEXT;
ALTER TABLE merchants ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE callbacks ADD COLUMN merchant_id TEXT;
