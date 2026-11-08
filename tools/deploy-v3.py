#!/usr/bin/env python3
"""Deploy gobiz-bridge v3 (payload QRIS per-merchant) ke produksi.

Perbedaan dari deploy.py (v2): skrip ini HANYA mengunggah kode v3 +
menerapkan delta kolom v3. Ia TIDAK membuat D1 baru, TIDAK menerapkan
ulang skema penuh, dan TIDAK menyentuh Worker secrets sama sekali
(secret yang sudah terpasang di script bertahan lintas unggahan kode —
dibuktikan di sini dengan membandingkan daftar NAMA secret sebelum &
sesudah). Jadwal cron diverifikasi, dan hanya diperbaiki bila hilang.

Metadata unggahan disalin persis dari deploy v2 yang live (binding D1
yang sama, vars yang sama, compatibility_date yang sama) supaya tidak
ada perubahan perilaku selain kode v3 itu sendiri.

Rollback: unggah ulang bundle worker-v2 (python3 ../worker-v2/deploy.py
mengunggah kode v2; kolom qris_payload yang tertinggal di D1 diabaikan
v2 sepenuhnya).

Pakai: python3 deploy-v3.py
"""
import json, os, sys, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy as cf  # noqa: E402 — call(), ok(), ACCOUNT dari perkakas v2
from d1admin import DB_ID_DEFAULT, ensure_v3_columns  # noqa: E402

SCRIPT = "gobiz-bridge"
ROOT = os.path.dirname(os.path.abspath(__file__))
DB_ID = DB_ID_DEFAULT
CRON = "*/1 * * * *"


def list_secret_names():
    status, out = cf.call("GET", f"/accounts/{cf.ACCOUNT}/workers/scripts/{SCRIPT}/secrets")
    if not cf.ok(out):
        print("daftar secret GAGAL dibaca", status, json.dumps(out)[:400])
        return None
    return sorted(s.get("name") for s in (out.get("result") or []))


def get_schedules():
    status, out = cf.call("GET", f"/accounts/{cf.ACCOUNT}/workers/scripts/{SCRIPT}/schedules")
    if not cf.ok(out):
        print("jadwal GAGAL dibaca", status, json.dumps(out)[:400])
        return None
    result = out.get("result") or {}
    return [s.get("cron") for s in (result.get("schedules") or [])]


def upload_script():
    code = open(os.path.join(ROOT, "src/index.js"), "rb").read()
    meta = {
        "main_module": "index.js",
        "compatibility_date": "2025-01-15",
        "bindings": [
            {"type": "d1", "name": "DB", "id": DB_ID},
            {"type": "plain_text", "name": "GOBIZ_APP_VERSION", "text": "platform-v3.128.0-a941d748"},
            {"type": "plain_text", "name": "CALLBACK_URL", "text": "https://example.com/api/webhook"},
        ],
    }
    boundary = "----cf" + uuid.uuid4().hex
    parts = []
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n')
    parts.append(json.dumps(meta).encode() + b"\r\n")
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n')
    parts.append(code + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    status, out = cf.call("PUT", f"/accounts/{cf.ACCOUNT}/workers/scripts/{SCRIPT}",
                          b"".join(parts), ctype=f"multipart/form-data; boundary={boundary}")
    if not cf.ok(out):
        print("script upload FAILED", status, json.dumps(out)[:800])
        sys.exit(1)
    print("script v3 terunggah:", out["result"].get("id"))


def ensure_schedule():
    crons = get_schedules()
    print("jadwal sebelum:", crons)
    if crons and CRON in crons:
        print("jadwal cron utuh — tidak diubah.")
        return
    # Schedules PUT memakai body ARRAY polos (temuan deploy sebelumnya).
    status, out = cf.call("PUT", f"/accounts/{cf.ACCOUNT}/workers/scripts/{SCRIPT}/schedules",
                          [{"cron": CRON}])
    print("jadwal diperbaiki:", status, json.dumps(out)[:300])
    print("jadwal sesudah:", get_schedules())


def main():
    print(f"target: script {SCRIPT}, D1 {DB_ID}")
    names_before = list_secret_names()
    print("nama secret terpasang (sebelum):", names_before)

    print("--- delta kolom v3 ---")
    for line in ensure_v3_columns(DB_ID):
        print(" ", line)

    print("--- unggah kode v3 ---")
    upload_script()

    print("--- jadwal cron ---")
    ensure_schedule()

    names_after = list_secret_names()
    print("nama secret terpasang (sesudah):", names_after)
    if names_before is not None and names_after is not None and names_before != names_after:
        print("PERINGATAN: daftar nama secret BERUBAH setelah unggah kode!")
        return 1
    print("DEPLOY V3 SELESAI (tidak ada secret yang disentuh).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
