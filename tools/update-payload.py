#!/usr/bin/env python3
"""Pasang / ganti / kosongkan payload QRIS statis SATU merchant (v3).

Menulis kolom `merchants.qris_payload` saja — kredensial, callback_url,
dan flag active TIDAK disentuh. Worker v3 memakai payload baris ini saat
membuat invoice untuk merchant tersebut; NULL berarti jatuh kembali ke
payload bersama di env STATIC_QRIS_PAYLOAD (outlet asal 'winz Digital').

Nilai payload TIDAK PERNAH dicetak — output hanya slug + panjang lama →
baru. Payload dibaca dari --payload-file (disarankan: tidak masuk
riwayat shell) atau --payload.

Pakai:
  python3 update-payload.py --slug demo-foundation --payload-file payload-demo-foundation.txt
  python3 update-payload.py --slug demo-foundation --clear
  python3 update-payload.py --slug demo-foundation            # tampilkan status saja
"""
import argparse, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1admin import DB_ID_DEFAULT, ensure_v3_columns, query, sql_str  # noqa: E402


def current_payload(dbid, slug):
    rows = query(dbid, f"""
SELECT CASE WHEN qris_payload IS NULL THEN NULL ELSE length(qris_payload) END AS payload_len
FROM merchants WHERE id = {sql_str(slug)}""")
    if not rows:
        return None, False
    return rows[0]["payload_len"], True


def len_text(n):
    return "NULL (fallback env)" if n is None else f"{n} karakter"


def main():
    ap = argparse.ArgumentParser(description="Pasang/ganti payload QRIS per-merchant (v3)")
    ap.add_argument("--slug", required=True, help="id merchant, mis. 'demo-foundation'")
    ap.add_argument("--payload", help="payload QRIS statis (string EMV)")
    ap.add_argument("--payload-file", help="baca payload QRIS statis dari berkas teks")
    ap.add_argument("--clear", action="store_true",
                    help="kosongkan payload (NULL — kembali ke fallback env)")
    ap.add_argument("--db-id", default=DB_ID_DEFAULT, help="uuid database D1 gobiz-bridge")
    args = ap.parse_args()

    slug = args.slug.strip().lower()

    for line in ensure_v3_columns(args.db_id):
        print(" ", line)

    old_len, exists = current_payload(args.db_id, slug)
    if not exists:
        print(f"ERROR: merchant '{slug}' belum terdaftar — enrol dulu lewat enroll-merchant.py.")
        return 1
    print(f"merchant '{slug}': payload saat ini = {len_text(old_len)}")

    raw = None
    if args.payload_file:
        try:
            with open(args.payload_file) as f:
                raw = f.read()
        except OSError as e:
            print(f"ERROR: gagal membaca --payload-file: {e}")
            return 1
    elif args.payload is not None:
        raw = args.payload

    if args.clear:
        query(args.db_id, f"UPDATE merchants SET qris_payload = NULL WHERE id = {sql_str(slug)}")
        print(f"merchant '{slug}': payload dikosongkan → NULL (fallback env).")
        return 0

    if raw is None:
        print("tidak ada perubahan (berikan --payload/--payload-file untuk memasang, "
              "atau --clear untuk mengosongkan).")
        return 0

    payload = raw.strip()
    if not payload.startswith("000201") or len(payload) < 50:
        print("ERROR: payload tidak tampak valid (harus string EMV yang diawali '000201').")
        return 1

    query(args.db_id, f"""
UPDATE merchants SET qris_payload = {sql_str(payload)} WHERE id = {sql_str(slug)}""")
    new_len, _ = current_payload(args.db_id, slug)
    print(f"merchant '{slug}': payload diperbarui {len_text(old_len)} → {len_text(new_len)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
