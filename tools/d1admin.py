#!/usr/bin/env python3
"""Bagian bersama skrip admin jembatan (seed-demo-store.py, enroll-merchant.py,
update-payload.py, deploy-v3.py).

Membungkus helper konektor Cloudflare dari deploy.py (call/ok/ACCOUNT)
dan pola migrasi kolom yang aman-diulang: SQLite tidak punya
ADD COLUMN IF NOT EXISTS, jadi kolom yang kurang ditemukan lewat
PRAGMA table_info lebih dulu, baru ALTER diterapkan untuk yang kurang
saja. Tidak ada nilai rahasia yang dicetak oleh modul ini.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy  # noqa: E402  — menyediakan call(), ok(), ACCOUNT

ACCOUNT = deploy.ACCOUNT
DB_ID_DEFAULT = "YOUR-D1-DATABASE-ID"  # D1 'gobiz-bridge' yang live


def query(dbid, sql):
    status, out = deploy.call(
        "POST", f"/accounts/{ACCOUNT}/d1/database/{dbid}/query", {"sql": sql}
    )
    if not deploy.ok(out):
        raise RuntimeError(f"D1 query gagal (HTTP {status}): {str(out)[:400]}")
    result = out.get("result") or [{}]
    return result[0].get("results") or []


def table_columns(dbid, table):
    rows = query(dbid, f"PRAGMA table_info({table})")
    return {r["name"] for r in rows}


# Kolom yang ditambahkan v2: (tabel, nama kolom, definisi untuk ALTER)
V2_COLUMNS = [
    ("merchants", "api_secret", "TEXT"),
    ("merchants", "callback_secret", "TEXT"),
    ("merchants", "active", "INTEGER NOT NULL DEFAULT 1"),
    ("callbacks", "merchant_id", "TEXT"),
]


def ensure_v2_columns(dbid, dry_run=False):
    """Terapkan ALTER yang kurang saja. Mengembalikan daftar aksi."""
    actions = []
    cache = {}
    for table, column, definition in V2_COLUMNS:
        if table not in cache:
            cache[table] = table_columns(dbid, table)
        if column in cache[table]:
            actions.append(f"kolom {table}.{column}: sudah ada, lewati")
            continue
        stmt = f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
        if dry_run:
            actions.append(f"AKAN dijalankan: {stmt}")
        else:
            query(dbid, stmt)
            cache[table].add(column)
            actions.append(f"ditambahkan: {stmt}")
    return actions


# Kolom yang ditambahkan v3: (tabel, nama kolom, definisi untuk ALTER)
V3_COLUMNS = [
    ("merchants", "qris_payload", "TEXT"),
]


def ensure_columns(dbid, columns, dry_run=False):
    """Terapkan ALTER yang kurang saja dari daftar `columns`.

    Mengembalikan daftar aksi (string) — pola yang sama seperti
    ensure_v2_columns, digeneralisasi untuk delta v3 dan seterusnya.
    """
    actions = []
    cache = {}
    for table, column, definition in columns:
        if table not in cache:
            cache[table] = table_columns(dbid, table)
        if column in cache[table]:
            actions.append(f"kolom {table}.{column}: sudah ada, lewati")
            continue
        stmt = f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
        if dry_run:
            actions.append(f"AKAN dijalankan: {stmt}")
        else:
            query(dbid, stmt)
            cache[table].add(column)
            actions.append(f"ditambahkan: {stmt}")
    return actions


def ensure_v3_columns(dbid, dry_run=False):
    """Delta v3: merchants.qris_payload (payload QRIS per-merchant)."""
    return ensure_columns(dbid, V3_COLUMNS, dry_run=dry_run)


def sql_str(value):
    """Literal string SQL yang aman (untuk nilai yang kita generate)."""
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"
