#!/usr/bin/env python3
"""Daftarkan (enrol) merchant/domain BARU ke jembatan gobiz-bridge v3.

Menghasilkan trio kredensial baru (format sama seperti demo-store:
api_key 'gob_' + 32 hex, api_secret 64 hex, callback_secret 64 hex),
menyimpan/ memperbarui baris `merchants` di D1, lalu mencetak trio-nya
SEKALI ke stdout supaya disalin ke panel admin situs yang bersangkutan
(pola yang sama seperti cfg_kriskris_* di demo-store). Script TIDAK
menulis nilai ke berkas mana pun; yang tersimpan hanya di D1.

Merchant yang sama yang di-enrol ulang TIDAK menimpa kredensial lama
kecuali diberi --rotate (rotasi sadar). --deactivate/--activate hanya
mengubah flag active tanpa menyentuh kredensial.

v3: --qris-payload '<string EMV statis>' atau --qris-payload-file
<path> menyimpan payload QRIS statis outlet merchant ini ke kolom
`merchants.qris_payload` (dipakai Worker v3 saat membuat invoice;
NULL = fallback payload env). Tanpa argumen itu, enrol baru berpayload
NULL dan rotasi MEMPERTAHANKAN payload lama; --clear-qris-payload
mengosongkannya secara eksplisit. Nilai payload tidak pernah dicetak —
hanya status + panjangnya. Untuk mengganti payload merchant yang sudah
ada tanpa menyentuh kredensial, pakai update-payload.py.

Pakai:
  python3 enroll-merchant.py --slug demo-shop --callback-url https://demo-shop.my.id/api/webhook-kriskris \
      [--name "Shove"] [--domain demo-shop.my.id] [--db-id <uuid>] [--rotate] \
      [--qris-payload-file payload-demo-foundation.txt]
  python3 enroll-merchant.py --slug demo-shop --deactivate
  python3 enroll-merchant.py --slug demo-shop --activate
"""
import argparse, os, re, secrets, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d1admin import DB_ID_DEFAULT, ensure_v2_columns, ensure_v3_columns, query, sql_str  # noqa: E402

BRIDGE_BASE_URL = "https://gobiz-bridge.your-subdomain.workers.dev"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")


def get_merchant(dbid, slug):
    rows = query(dbid, f"SELECT id, active FROM merchants WHERE id = {sql_str(slug)}")
    return rows[0] if rows else None


def load_payload(args):
    """Kembalikan (payload|None, error|None). None = tidak diberikan."""
    if args.clear_qris_payload:
        return "", None  # penanda eksplisit: kosongkan (NULL)
    raw = None
    if args.qris_payload_file:
        try:
            with open(args.qris_payload_file) as f:
                raw = f.read()
        except OSError as e:
            return None, f"ERROR: gagal membaca --qris-payload-file: {e}"
    elif args.qris_payload is not None:
        raw = args.qris_payload
    if raw is None:
        return None, None
    payload = raw.strip()
    if not payload.startswith("000201") or len(payload) < 50:
        return None, ("ERROR: payload QRIS tidak tampak valid (harus string EMV "
                      "yang diawali '000201'). Periksa kembali salinannya.")
    return payload, None


def payload_status_text(payload):
    """Status payload untuk dicetak — nilainya sendiri TIDAK ditampilkan."""
    if payload is None:
        return "payload QRIS: (dipertahankan / NULL — fallback env)"
    if payload == "":
        return "payload QRIS: dikosongkan (NULL — fallback env)"
    return f"payload QRIS: terpasang ({len(payload)} karakter)"


def main():
    ap = argparse.ArgumentParser(description="Enrol merchant baru gobiz-bridge v2")
    ap.add_argument("--slug", required=True, help="id merchant, mis. 'demo-shop' (huruf kecil, angka, strip)")
    ap.add_argument("--callback-url", help="URL webhook situs, mis. https://demo-shop.my.id/api/webhook-kriskris")
    ap.add_argument("--name", help="nama tampil merchant (default: slug)")
    ap.add_argument("--domain", help="domain situs (default: slug)")
    ap.add_argument("--db-id", default=DB_ID_DEFAULT, help="uuid database D1 gobiz-bridge")
    ap.add_argument("--rotate", action="store_true",
                    help="ganti kredensial merchant yang sudah ada dengan trio baru")
    ap.add_argument("--qris-payload", help="payload QRIS statis outlet merchant ini (string EMV)")
    ap.add_argument("--qris-payload-file", help="baca payload QRIS statis dari berkas teks")
    ap.add_argument("--clear-qris-payload", action="store_true",
                    help="kosongkan qris_payload (kembali ke fallback env)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--deactivate", action="store_true", help="nonaktifkan merchant (active=0)")
    mode.add_argument("--activate", action="store_true", help="aktifkan lagi merchant (active=1)")
    args = ap.parse_args()

    slug = args.slug.strip().lower()
    if not SLUG_RE.match(slug):
        print("ERROR: --slug harus pola [a-z0-9][a-z0-9-]{1,31}")
        return 1
    if slug == "demo-store" and not (args.deactivate or args.activate):
        print("ERROR: 'demo-store' adalah merchant default yang sudah live — "
              "seed/rotasinya lewat seed-demo-store.py, bukan enrol.")
        return 1

    for line in ensure_v2_columns(args.db_id):
        print(" ", line)
    for line in ensure_v3_columns(args.db_id):
        print(" ", line)
    existing = get_merchant(args.db_id, slug)

    if args.deactivate or args.activate:
        if not existing:
            print(f"ERROR: merchant '{slug}' belum terdaftar.")
            return 1
        target = 0 if args.deactivate else 1
        query(args.db_id, f"UPDATE merchants SET active = {target} WHERE id = {sql_str(slug)}")
        print(f"merchant '{slug}': active = {target}")
        return 0

    if not args.callback_url or not args.callback_url.startswith("https://"):
        print("ERROR: --callback-url wajib dan harus https://")
        return 1
    if existing and not args.rotate:
        print(f"ERROR: merchant '{slug}' sudah terdaftar (active={existing['active']}). "
              "Gunakan --rotate bila memang mau mengganti kredensialnya.")
        return 1

    payload, payload_err = load_payload(args)
    if payload_err:
        print(payload_err)
        return 1

    api_key = "gob_" + secrets.token_hex(16)        # 36 char — format sama dengan demo-store
    api_secret = secrets.token_hex(32)              # 64 hex
    callback_secret = secrets.token_hex(32)         # 64 hex
    name = args.name or slug
    domain = args.domain or slug
    now_ms = int(time.time() * 1000)

    if existing:  # --rotate: ganti trio + callback_url, pertahankan created_at
        # Payload: hanya berubah bila diberikan/dikosongkan secara eksplisit.
        payload_clause = ""
        if payload is not None:
            payload_clause = f",\n  qris_payload = {sql_str(payload or None)}"
        query(args.db_id, f"""
UPDATE merchants SET api_key = {sql_str(api_key)}, api_secret = {sql_str(api_secret)},
  callback_secret = {sql_str(callback_secret)}, callback_url = {sql_str(args.callback_url)},
  name = {sql_str(name)}, domain = {sql_str(domain)}, active = 1{payload_clause}
WHERE id = {sql_str(slug)}""")
        action = "di-rotasi"
    else:
        query(args.db_id, f"""
INSERT INTO merchants (id, name, domain, api_key, api_secret, callback_secret,
                       callback_url, qris_payload, active, created_at)
VALUES ({sql_str(slug)}, {sql_str(name)}, {sql_str(domain)}, {sql_str(api_key)},
        {sql_str(api_secret)}, {sql_str(callback_secret)}, {sql_str(args.callback_url)},
        {sql_str(payload or None)}, 1, {now_ms})""")
        action = "terdaftar"

    # Trio dicetak SEKALI di sini — tidak disimpan ke berkas mana pun.
    print()
    print(f"=== Merchant '{slug}' {action} — salin ke panel admin situs SEKARANG (hanya tampil sekali) ===")
    print(f"Base URL API     : {BRIDGE_BASE_URL}")
    print(f"API Key          : {api_key}")
    print(f"API Secret       : {api_secret}")
    print(f"Callback Secret  : {callback_secret}")
    print(f"Callback URL     : {args.callback_url}")
    print(payload_status_text(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
