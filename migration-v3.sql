-- gobiz-bridge — MIGRASI v2 → v3 (jalankan SEKALI pada D1 yang live)
-- ---------------------------------------------------------------------
-- SQLite TIDAK mendukung ADD COLUMN IF NOT EXISTS. Sebelum menjalankan
-- file ini, periksa dulu kolom yang sudah ada:
--   PRAGMA table_info(merchants);
-- dan HAPUS baris ALTER bila kolomnya sudah ada. Alternatif yang aman
-- dijalankan berulang: perkakas v3 (enroll-merchant.py /
-- update-payload.py / deploy-v3.py) — mereka memeriksa PRAGMA secara
-- terprogram dan menerapkan hanya ALTER yang kurang.
--
-- Pernyataan bersifat ADITIF MURNI: satu kolom TEXT nullable baru.
-- Semua baris lama otomatis bernilai NULL = perilaku lama persis
-- (payload QRIS dari env STATIC_QRIS_PAYLOAD). Kode v2 mengabaikan
-- kolom ini sepenuhnya, jadi migrasi aman diterapkan SEBELUM deploy
-- kode v3 (nol downtime).

ALTER TABLE merchants ADD COLUMN qris_payload TEXT;
