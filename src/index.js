/**
 * gobiz-bridge — Jembatan GoBiz milik sendiri (Fase B).
 *
 * Satu Cloudflare Worker tanpa build step & tanpa dependensi luar yang
 * meniru kontrak API kriskris PERSIS (lihat
 * docs/API-CONTRACT.md), supaya integrasi website merchant
 * yang sudah live (lib/kriskris.js) cukup mengganti base URL + key/secret:
 *
 *   POST /api/v1/external/invoices            buat tagihan (kode unik 10–99)
 *   GET  /api/v1/external/invoices/{id}       status satu tagihan
 *   GET  /api/v1/external/invoices/status     status batch (?ids=a,b)
 *   POST /api/v1/external/invoices/{id}/cancel
 *   GET  /health                              status sesi (tanpa rahasia)
 *   POST /admin/test-ping                     kirim callback test.ping
 *
 * Di belakangnya, Worker ini login ke portal GoBiz (GoFood Merchant)
 * memakai email + kata sandi (TANPA OTP — jalur OTP portal terbukti
 * ditahan Gojek untuk permintaan dari server, lihat RECON-API-GOBIZ.md),
 * lalu mencocokkan mutasi QRIS outlet dengan total tagihan
 * (harga dasar + kode unik) lewat cron 1 menit, dan mengirim callback
 * bertanda tangan ke merchant (invoice.paid / invoice.expired).
 * Uang TIDAK pernah singgah di jembatan — selalu langsung ke GoBiz.
 *
 * MULTI-MERCHANT (v2 — AKTIF):
 * Semua kode berjalan di atas "merchant context". Konteks dibangun oleh
 * resolveMerchant()/resolveMerchantById()/listMerchants(), yang membaca
 * tabel D1 `merchants` (satu baris per domain: api_key, api_secret,
 * callback_secret, callback_url, active). Resolusi request masuk adalah
 * BERDASARKAN API KEY: key → baris merchant → secret baris itu yang
 * memverifikasi signature, callback_url baris itu yang menerima callback,
 * callback_secret baris itu yang menandatanganinya.
 *
 * PAYLOAD QRIS PER-MERCHANT (v3 — AKTIF): baris merchant boleh membawa
 * `qris_payload` sendiri (payload statis outlet GoBiz-nya); pembuatan
 * invoice memakai payload itu, dan jatuh ke env STATIC_QRIS_PAYLOAD
 * bila kolomnya NULL. Lihat catatan v3 di blok merchant context.
 *
 * KOMPATIBILITAS MUNDUR (keras): merchant 'default' tetap bekerja dengan
 * nilai key/secret/callback-secret + callback URL yang SUDAH live. Dua
 * jalur menghasilkan konteks yang identik:
 *   (a) baris `merchants` id 'default' yang di-seed satu kali dari nilai
 *       env yang berjalan (lihat tools/enroll-merchant.py), dan
 *   (b) FALLBACK env murni (BRIDGE_API_KEY/SECRET/CALLBACK_SECRET +
 *       CALLBACK_URL) bila barisnya tidak ada — persis perilaku v1.
 * Baris D1 menang atas env untuk merchant yang sama; env hanya untuk
 * merchant default yang belum punya baris.
 *
 * Identitas outlet GoBiz (GOBIZ_EMAIL/PASSWORD) BUKAN per-merchant:
 * semua merchant berbagi SATU akun GoBiz pemilik, jadi keduanya tetap
 * dari env dan ikut di setiap konteks. Konsekuensinya sesi GoBiz per
 * merchant jembatan berbagi kredensial yang sama — sama seperti v1 —
 * dan keunikan total pending tetap GLOBAL per akun GoBiz (lihat
 * invariant di getPendingTotals).
 *
 * PAYLOAD QRIS PER-MERCHANT (v3 — AKTIF):
 * STATIC_QRIS_PAYLOAD env kini hanya FALLBACK (outlet asal 'winz
 * Digital'). Merchant yang punya outlet GoBiz sendiri di akun yang sama
 * dapat menyimpan payload statis outletnya di kolom D1
 * `merchants.qris_payload`; pembuatan invoice memakai payload baris itu
 * bila terisi, env bila NULL/kosong. Outlet-outlet itu tetap satu akun
 * GoBiz → satu feed transaksi → pencocokan berdasarkan total tetap
 * global dan tidak berubah sedikit pun.
 *
 * Quirk GoBiz yang menentukan desain (RECON-API-GOBIZ.md):
 *  - Set header "device" penuh HANYA untuk panggilan /goid/*; panggilan
 *    data memakai set ramping. X-AppVersion versi build portal yang
 *    BERGERAK → dibaca dari vars (GOBIZ_APP_VERSION), bukan hardcode.
 *  - Respons token TIDAK memuat expires_in → 401 = sesi mati: coba
 *    refresh sekali, gagal → login password ulang.
 *  - Refresh token BEROTASI — pasangan baru WAJIB selalu disimpan.
 *  - gross_amount transaksi dalam SEN (minor unit) → bagi 100.
 *  - Polling HANYA saat ada tagihan pending (anti-ban).
 */

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

const GOBIZ_API = 'https://api.gobiz.co.id';       // auth + data portal
const GOJEK_API = 'https://api.gojekapi.com';      // merchant-analytics
const PORTAL_ORIGIN = 'https://portal.gofoodmerchant.co.id';
const CLIENT_ID = 'go-biz-web-new';
const DEFAULT_APP_VERSION = 'platform-v3.128.0-a941d748'; // fallback bila vars kosong
const DEFAULT_MERCHANT_ID = 'default';

const INVOICE_TTL_MS = 15 * 60 * 1000;              // umur tagihan kriskris: 15 menit
const MIN_AMOUNT = 1000;                            // minimum kriskris: Rp1.000
const UNIQUE_CODE_MIN = 10;                         // kode unik 10–99 (90 kemungkinan)
const UNIQUE_CODE_COUNT = 90;
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;       // toleransi timestamp ±5 menit
const TX_TIME_TOLERANCE_MS = 120 * 1000;            // transaksi boleh 120 dtk sebelum invoice dibuat

// Retry callback kriskris: maks 5× setelah kirim awal, jeda 1m/5m/30m/2h/12h,
// delivery_id TETAP. Total kirim maksimum = 1 + 5 = 6.
const CALLBACK_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const MAX_CALLBACK_SENDS = 1 + CALLBACK_BACKOFF_MS.length;

const PORTAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Util kripto (WebCrypto — sama di Workers & Node ≥18, dipakai test lokal)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(text ?? '')));
  return bytesToHex(digest);
}

async function hmacSha256Hex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', textEncoder.encode(String(secret ?? '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(String(text ?? '')));
  return bytesToHex(sig);
}

/** Perbandingan string waktu-konstan (untuk API key & signature). */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// EMV QRIS — parse TLV, tulis nominal (tag 54), hitung ulang CRC (tag 63)
// ---------------------------------------------------------------------------

/**
 * Parse payload EMV level atas: rangkaian [tag 2 char][panjang 2 digit
 * desimal][value]. Template bersarang (tag 26–51, 62, 64) diperlakukan
 * sebagai value buram — panjangnya tetap benar di level atas.
 * Payload QRIS murni ASCII sehingga panjang string == panjang byte.
 */
function parseEmvTlv(payload) {
  const out = [];
  const s = String(payload ?? '');
  let i = 0;
  while (i < s.length) {
    if (i + 4 > s.length) throw new Error('EMV TLV terpotong (header)');
    const tag = s.slice(i, i + 2);
    const len = Number.parseInt(s.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len)) throw new Error(`EMV TLV panjang tidak valid pada tag ${tag}`);
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length !== len) throw new Error(`EMV TLV terpotong (tag ${tag})`);
    out.push({ tag, value });
    i += 4 + len;
  }
  return out;
}

function serializeEmvTlv(parts) {
  return parts
    .map(({ tag, value }) => tag + String(value.length).padStart(2, '0') + value)
    .join('');
}

/** CRC16-CCITT (CCITT-FALSE): poly 0x1021, init 0xFFFF, tanpa refleksi. */
function crc16Ccitt(text) {
  let crc = 0xFFFF;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    crc ^= (s.charCodeAt(i) & 0xFF) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

/**
 * Ubah payload QRIS STATIS outlet menjadi payload DINAMIS bertotal persis:
 *  - tag "01" (point of initiation) → "12" (dinamis), bila ada;
 *  - tag "54" (nominal transaksi) → total (harga + kode unik), disisipkan
 *    pada posisi urut EMV bila belum ada;
 *  - tag "63" (CRC) dibuang lalu dihitung ulang atas seluruh payload
 *    termasuk penanda "6304" (standar EMVCo).
 */
function buildDynamicQrPayload(staticPayload, totalAmount) {
  if (!staticPayload) throw new Error('STATIC_QRIS_PAYLOAD belum diisi');
  const parts = parseEmvTlv(staticPayload).filter((p) => p.tag !== '63');
  const poi = parts.find((p) => p.tag === '01');
  if (poi) poi.value = '12';
  const amount = String(Math.round(Number(totalAmount)));
  const amt = parts.find((p) => p.tag === '54');
  if (amt) {
    amt.value = amount;
  } else {
    const successor = parts.findIndex((p) => Number.parseInt(p.tag, 10) > 54);
    const entry = { tag: '54', value: amount };
    if (successor === -1) parts.push(entry);
    else parts.splice(successor, 0, entry);
  }
  const body = serializeEmvTlv(parts) + '6304';
  return body + crc16Ccitt(body).toString(16).toUpperCase().padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Tanda tangan kontrak kriskris
// ---------------------------------------------------------------------------

/**
 * String kanonis request masuk: 5 baris digabung '\n' —
 * timestamp, METHOD, path, query mentah ('' bila tak ada),
 * hex(sha256(body mentah)). Persis lib/kriskris.js sisi default.
 */
async function buildCanonicalString({ timestamp, method, path, query = '', rawBody = '' }) {
  return [
    String(timestamp),
    String(method || '').toUpperCase(),
    String(path),
    String(query || ''),
    await sha256Hex(rawBody ?? ''),
  ].join('\n');
}

/** Signature callback keluar: 'sha256=<hex>' = HMAC-SHA256 atas body mentah. */
async function buildCallbackSignature(callbackSecret, rawBody) {
  return 'sha256=' + (await hmacSha256Hex(callbackSecret, rawBody));
}

/**
 * Pilih kode unik 10–99 agar total (base + kode) tidak menabrak total
 * pending yang sudah ada. Mengembalikan null bila 90 kode habis
 * (→ 422 duplicate_pending, sama seperti kriskris).
 * `rng` dapat diinjeksi untuk test.
 */
function pickUniqueCode(baseAmount, pendingTotals, rng = Math.random) {
  const tried = new Set();
  while (tried.size < UNIQUE_CODE_COUNT) {
    const code = UNIQUE_CODE_MIN + Math.floor(rng() * UNIQUE_CODE_COUNT);
    if (tried.has(code)) continue;
    tried.add(code);
    if (!pendingTotals.has(baseAmount + code)) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merchant context — SATU-SATUNYA tempat kredensial merchant dibaca.
// v2: sumber utama tabel D1 `merchants`; env hanya fallback merchant
// default 'default' (kompatibilitas mundur v1) + identitas outlet bersama.
// ---------------------------------------------------------------------------

/**
 * Konteks merchant default dari env (perilaku v1, kini jadi FALLBACK).
 * Field konteks: {id, name, domain, apiKey, apiSecret, callbackSecret,
 * callbackUrl, active, gobizEmail, gobizPassword, qrisPayload, appVersion}.
 * qrisPayload di sini adalah payload FALLBACK bersama (env
 * STATIC_QRIS_PAYLOAD); baris merchant dapat menimpanya (v3, lihat
 * rowToMerchantContext). appVersion ikut konteks karena per-outlet /
 * per-merchant secara konseptual.
 */
function envMerchant(env) {
  return {
    id: DEFAULT_MERCHANT_ID,
    name: DEFAULT_MERCHANT_ID,
    domain: null,
    apiKey: env.BRIDGE_API_KEY || '',
    apiSecret: env.BRIDGE_API_SECRET || '',
    callbackSecret: env.BRIDGE_CALLBACK_SECRET || '',
    callbackUrl: env.CALLBACK_URL || '',
    active: true,
    gobizEmail: env.GOBIZ_EMAIL || '',
    gobizPassword: env.GOBIZ_PASSWORD || '',
    qrisPayload: env.STATIC_QRIS_PAYLOAD || '',
    appVersion: env.GOBIZ_APP_VERSION || DEFAULT_APP_VERSION,
  };
}

// Nama lama dipertahankan agar test v1 tetap bisa mengimpornya.
const defaultMerchant = envMerchant;

/**
 * Petakan satu baris tabel `merchants` ke konteks merchant. Kredensial
 * API + callback berasal dari baris; identitas outlet GoBiz berasal
 * dari env karena BERSAMA untuk semua merchant (satu akun GoBiz
 * pemilik). Payload QRIS statis (v3): payload baris
 * (`merchants.qris_payload`) menang bila terisi — merchant itu punya
 * outlet sendiri — dan env STATIC_QRIS_PAYLOAD menjadi fallback bila
 * kolomnya NULL/kosong (semua merchant warisan v2 persis di posisi ini,
 * jadi perilaku mereka tidak berubah).
 */
function rowToMerchantContext(row, env) {
  const shared = envMerchant(env);
  const rowPayload =
    typeof row.qris_payload === 'string' && row.qris_payload.trim()
      ? row.qris_payload
      : '';
  return {
    id: row.id,
    name: row.name || row.id,
    domain: row.domain || null,
    apiKey: row.api_key || '',
    apiSecret: row.api_secret || '',
    callbackSecret: row.callback_secret || '',
    callbackUrl: row.callback_url || '',
    // Kolom active: 0 = nonaktif. NULL (baris lama) diperlakukan aktif.
    active: !(row.active === 0 || row.active === false),
    gobizEmail: shared.gobizEmail,
    gobizPassword: shared.gobizPassword,
    qrisPayload: rowPayload || shared.qrisPayload,
    appVersion: shared.appVersion,
  };
}

/** Baca baris merchant dari D1; null bila tidak ada / D1 belum siap. */
async function getMerchantRowByApiKey(env, apiKey) {
  try {
    return await env.DB.prepare('SELECT * FROM merchants WHERE api_key = ?')
      .bind(String(apiKey)).first();
  } catch (e) {
    return null; // binding/tabel belum ada (pra-migrasi) → fallback env
  }
}

async function getMerchantRowById(env, merchantId) {
  try {
    return await env.DB.prepare('SELECT * FROM merchants WHERE id = ?')
      .bind(String(merchantId)).first();
  } catch (e) {
    return null;
  }
}

/**
 * Resolusi merchant dari API key request masuk (v2):
 *  1. Tabel `merchants` BERDASARKAN API KEY — key menentukan merchant,
 *     secret baris itulah yang memverifikasi signature. Baris nonaktif
 *     (active = 0) DITOLAK seperti key tidak dikenal.
 *  2. Fallback env untuk merchant default 'default' (kompatibilitas
 *     mundur: key/secret yang live hari ini tetap berlaku walau baris
 *     D1-nya belum di-seed / terhapus).
 * Perbandingan selalu waktu-konstan.
 */
async function resolveMerchant(env, apiKey) {
  if (!apiKey) return null;
  const row = await getMerchantRowByApiKey(env, apiKey);
  if (row) {
    if (!timingSafeEqualStr(String(apiKey), String(row.api_key))) return null;
    const ctx = rowToMerchantContext(row, env);
    return ctx.active ? ctx : null;
  }
  if (!env.BRIDGE_API_KEY) return null;
  if (!timingSafeEqualStr(String(apiKey), String(env.BRIDGE_API_KEY))) return null;
  return envMerchant(env);
}

/**
 * Resolusi merchant dari id internal (antrean callback & cron).
 * Baris D1 menang; tanpa baris, hanya merchant default yang dikenal
 * (dari env). Merchant nonaktif TETAP diresolusi di sini: callback untuk
 * invoice lamanya yang sudah terlanjur dibuat harus tetap terkirim —
 * flag active hanya menutup auth API baru, bukan penyelesaian kewajiban.
 */
async function resolveMerchantById(env, merchantId) {
  if (!merchantId) return null;
  const row = await getMerchantRowById(env, merchantId);
  if (row) return rowToMerchantContext(row, env);
  return merchantId === DEFAULT_MERCHANT_ID ? envMerchant(env) : null;
}

/**
 * Daftar semua merchant yang dilayani jembatan (cron & /health):
 * semua baris tabel `merchants`, ditambah merchant default dari env
 * bila barisnya tidak ada (supaya default tidak pernah hilang dari
 * daftar walau seed belum jalan).
 */
async function listMerchants(env) {
  const byId = new Map();
  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM merchants ORDER BY id ASC'
    ).all();
    for (const row of results || []) byId.set(row.id, rowToMerchantContext(row, env));
  } catch (e) {
    /* tabel belum ada → hanya fallback env di bawah */
  }
  if (!byId.has(DEFAULT_MERCHANT_ID)) byId.set(DEFAULT_MERCHANT_ID, envMerchant(env));
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Respons JSON (amplop kriskris: {ok:true,data} / {ok:false,error[,data.code]})
// ---------------------------------------------------------------------------

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const jsonOk = (data, status = 200) => jsonResponse(status, { ok: true, data });
const jsonFail = (status, error, code) =>
  jsonResponse(status, code ? { ok: false, error, data: { code } } : { ok: false, error });

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

async function getConfig(env, key) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setConfig(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run();
}

async function getInvoiceRow(env, invoiceId) {
  return env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(invoiceId).first();
}

// ---------------------------------------------------------------------------
// Sesi GoBiz (per merchant) — login password, refresh berotasi, probe murah
// ---------------------------------------------------------------------------

function getSession(env, merchantId) {
  return env.DB.prepare(
    'SELECT merchant_id, access_token, refresh_token, updated_at FROM session WHERE merchant_id = ?'
  ).bind(merchantId).first();
}

async function saveSession(env, merchant, accessToken, refreshToken) {
  // Refresh token BEROTASI: pasangan baru selalu menimpa yang lama persis
  // seperti diterima — menyimpan token lama = sesi mati permanen.
  await env.DB.prepare(
    `INSERT INTO session (merchant_id, access_token, refresh_token, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       updated_at = excluded.updated_at`
  ).bind(merchant.id, accessToken, refreshToken ?? null, Date.now()).run();
}

/**
 * Set header "device" portal — HANYA untuk panggilan /goid/* (temuan HAR:
 * header seperti X-AppVersion tidak muncul di panggilan data).
 * Pasangan UA ↔ X-PhoneModel harus konsisten; X-AppVersion dari konteks
 * merchant (vars GOBIZ_APP_VERSION) karena build portal terus bergerak
 * dan build basi bisa kena version-gate senyap.
 */
function gobizAuthHeaders(merchant, accessToken, uniqueId) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'id',
    'Authentication-Type': 'go-id',
    'Authorization': accessToken ? `Bearer ${accessToken}` : 'Bearer',
    'Connection': 'keep-alive',
    'Content-Type': 'application/json',
    'Gojek-Country-Code': 'ID',
    'Gojek-Timezone': 'Asia/Jakarta',
    'Origin': PORTAL_ORIGIN,
    'Referer': PORTAL_ORIGIN + '/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': PORTAL_UA,
    'X-AppVersion': merchant.appVersion,
    'X-PhoneMake': 'Windows 10 64-bit',
    'X-PhoneModel': 'Chrome 149.0.0.0 on Windows 10 64-bit',
    'X-Platform': 'Web',
    'X-User-Locale': 'en-US',
    'X-User-Type': 'merchant',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'x-DeviceOS': 'Web',
    'x-appId': 'go-biz-web-dashboard',
    'x-uniqueid': uniqueId || crypto.randomUUID(),
  };
}

/** Set header ramping untuk panggilan data (search / analytics). */
function gobizDataHeaders(accessToken) {
  return {
    'Accept': 'application/json',
    'Authentication-Type': 'go-id',
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Origin': PORTAL_ORIGIN,
    'Referer': PORTAL_ORIGIN + '/',
    'User-Agent': PORTAL_UA,
  };
}

function gobizErrorText(data) {
  const msg = data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message;
  return msg ? `: ${msg}` : '';
}

/**
 * Login password portal (TANPA OTP):
 *   POST /goid/login/request {email, login_type:"password", client_id}
 *   POST /goid/token {client_id, grant_type:"password", data:{email,password}}
 * Langkah pertama hanya memvalidasi/mem-priming alur (responsnya tidak
 * membawa token); langkah kedua yang menentukan.
 */
async function passwordLogin(env, merchant) {
  if (!merchant.gobizEmail || !merchant.gobizPassword) {
    throw new Error(`GOBIZ_EMAIL/GOBIZ_PASSWORD belum diisi (merchant ${merchant.id})`);
  }
  const uniqueId = crypto.randomUUID(); // satu identitas klien per sesi login
  try {
    await fetch(`${GOBIZ_API}/goid/login/request`, {
      method: 'POST',
      headers: gobizAuthHeaders(merchant, null, uniqueId),
      body: JSON.stringify({
        email: merchant.gobizEmail,
        login_type: 'password',
        client_id: CLIENT_ID,
      }),
    });
  } catch (e) {
    /* priming gagal tidak fatal — pertukaran token di bawah yang menentukan */
  }
  const res = await fetch(`${GOBIZ_API}/goid/token`, {
    method: 'POST',
    headers: gobizAuthHeaders(merchant, null, uniqueId),
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'password',
      data: { email: merchant.gobizEmail, password: merchant.gobizPassword },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`login password GoBiz gagal (HTTP ${res.status})${gobizErrorText(data)}`);
  }
  await saveSession(env, merchant, data.access_token, data.refresh_token);
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

/** Refresh sesi; pasangan token baru (rotasi) selalu disimpan. */
async function refreshSession(env, merchant, session) {
  if (!session || !session.refresh_token) throw new Error('tidak ada refresh token tersimpan');
  const res = await fetch(`${GOBIZ_API}/goid/token`, {
    method: 'POST',
    headers: gobizAuthHeaders(merchant, null, crypto.randomUUID()),
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      data: { refresh_token: session.refresh_token },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`refresh sesi GoBiz gagal (HTTP ${res.status})${gobizErrorText(data)}`);
  }
  await saveSession(env, merchant, data.access_token, data.refresh_token);
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

/**
 * Jalankan satu panggilan data ber-token dengan rantai pemulihan sesi:
 * cache → (401) refresh sekali → (gagal) login password ulang → ulangi
 * panggilan sekali. Respons token tidak memuat expires_in, jadi 401
 * adalah satu-satunya sinyal sesi mati yang bisa diandalkan.
 */
async function gobizCall(env, merchant, makeRequest) {
  let session = await getSession(env, merchant.id);
  if (!session || !session.access_token) session = await passwordLogin(env, merchant);
  let res = await makeRequest(session.access_token);
  if (res.status === 401) {
    let renewed = null;
    try {
      renewed = await refreshSession(env, merchant, session);
    } catch (e) {
      renewed = null; // refresh mati (revoked/expired) → login penuh di bawah
    }
    if (!renewed) renewed = await passwordLogin(env, merchant);
    res = await makeRequest(renewed.access_token);
  }
  return res;
}

/**
 * Penemuan merchant/outlet GoBiz: POST /v1/merchants/search — panggilan
 * ber-auth termurah, sekaligus probe validitas sesi (401 = sesi mati,
 * ditangani gobizCall). Hasil hits[0].id ("G" + 9 digit) di-cache di
 * config per merchant jembatan: kunci `gobiz_merchant_id:<id>`.
 */
async function ensureGobizMerchantId(env, merchant, { probe = false } = {}) {
  const key = `gobiz_merchant_id:${merchant.id}`;
  const cached = await getConfig(env, key);
  if (cached && !probe) return cached;
  const res = await gobizCall(env, merchant, (token) =>
    fetch(`${GOBIZ_API}/v1/merchants/search`, {
      method: 'POST',
      headers: gobizDataHeaders(token),
      body: JSON.stringify({ from: 0, size: 20 }),
    })
  );
  if (!res.ok) throw new Error(`merchants/search gagal (HTTP ${res.status})`);
  const data = await res.json().catch(() => ({}));
  const hits = Array.isArray(data.hits) ? data.hits : [];
  if (!hits.length || !hits[0].id) throw new Error('merchants/search tidak mengembalikan merchant');
  const gobizId = String(hits[0].id);
  await setConfig(env, key, gobizId);
  return gobizId;
}

/** Satu halaman transaksi Merchant Analytics (query persis portal). */
async function fetchTransactionsPage(env, merchant, gobizMerchantId, startMs, endMs, from, size) {
  const qs =
    `from=${from}&size=${size}` +
    '&statuses=SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND' +
    '&payment_types=QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD' +
    `&start_time=${new Date(startMs).toISOString()}&end_time=${new Date(endMs).toISOString()}` +
    `&merchant_ids=${encodeURIComponent(gobizMerchantId)}`;
  const res = await gobizCall(env, merchant, (token) =>
    fetch(`${GOJEK_API}/merchant-analytics/v2/merchants/transactions?${qs}`, {
      headers: gobizDataHeaders(token),
    })
  );
  if (!res.ok) throw new Error(`merchant-analytics gagal (HTTP ${res.status})`);
  return res.json();
}

/** Ambil semua transaksi dalam jendela (halaman 50, maks 20 halaman). */
async function fetchAllTransactions(env, merchant, gobizMerchantId, startMs, endMs) {
  const size = 50;
  const all = [];
  let from = 0;
  for (let page = 0; page < 20; page++) {
    const data = await fetchTransactionsPage(env, merchant, gobizMerchantId, startMs, endMs, from, size);
    const txs = Array.isArray(data.transactions) ? data.transactions : [];
    all.push(...txs);
    from += txs.length;
    const total = Number(data.total ?? all.length);
    if (!txs.length || from >= total) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Tagihan (invoice) — serialisasi & handler API publik
// ---------------------------------------------------------------------------

function invoiceToApi(merchant, inv) {
  let qrPayload = null;
  try {
    qrPayload = buildDynamicQrPayload(merchant.qrisPayload, inv.total);
  } catch (e) {
    qrPayload = null; // payload statis belum diisi — status tetap bisa dibaca
  }
  return {
    id: inv.id,
    status: inv.status,
    amount: inv.total,
    base_amount: inv.base_amount,
    unique_code: inv.unique_code,
    label: inv.label ?? '',
    qr_payload: qrPayload,
    expires_at: new Date(inv.expires_at).toISOString(),
    paid_at: inv.paid_at ? new Date(inv.paid_at).toISOString() : null,
  };
}

/**
 * INVARIANT MULTI-MERCHANT (penting, ditegakkan v2): keunikan total
 * pending berlaku per AKUN GoBiz (outlet), BUKAN per merchant/domain.
 * Beberapa domain berbagi satu outlet yang sama, jadi dua domain tidak
 * boleh pernah memegang total pending yang sama — mutasi masuk tidak
 * membawa label domain. Pemeriksaan global atas SEMUA invoice pending
 * (query di bawah, SENGAJA tanpa filter merchant) adalah cakupan yang
 * benar; JANGAN disempitkan per merchant.
 */
async function getPendingTotals(env) {
  const { results } = await env.DB.prepare(
    "SELECT total FROM invoices WHERE status = 'pending'"
  ).all();
  return new Set((results || []).map((r) => r.total));
}

async function createInvoiceHandler(env, merchant, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch (e) {
    return jsonFail(400, 'invalid_json');
  }
  const amountRaw = Number(body?.amount);
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) return jsonFail(400, 'amount_required');
  const amount = Math.round(amountRaw);
  if (amount < MIN_AMOUNT) return jsonFail(422, 'amount_below_minimum', 'invalid_amount');
  if (!merchant.qrisPayload) return jsonFail(500, 'bridge_misconfigured_qris_payload');

  const label = String(body?.label ?? '').slice(0, 64);
  const pendingTotals = await getPendingTotals(env); // global per akun GoBiz — lihat invariant di atas
  const code = pickUniqueCode(amount, pendingTotals);
  if (code === null) return jsonFail(422, 'duplicate_pending', 'duplicate_pending');

  const now = Date.now();
  const inv = {
    id: 'inv-' + crypto.randomUUID(),
    merchant_id: merchant.id,
    label,
    base_amount: amount,
    unique_code: code,
    total: amount + code,
    status: 'pending',
    created_at: now,
    expires_at: now + INVOICE_TTL_MS,
    paid_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO invoices (id, merchant_id, label, base_amount, unique_code, total,
       status, created_at, expires_at, paid_at, matched_tx_id, created_via)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 'api')`
  ).bind(inv.id, inv.merchant_id, inv.label, inv.base_amount, inv.unique_code,
    inv.total, inv.created_at, inv.expires_at).run();

  return jsonOk(invoiceToApi(merchant, inv), 201);
}

async function getInvoiceHandler(env, merchant, invoiceId) {
  const inv = await getInvoiceRow(env, invoiceId);
  // Invoice milik merchant lain diperlakukan tidak ada (kontrak: 404).
  if (!inv || inv.merchant_id !== merchant.id) return jsonFail(404, 'invoice_not_found');
  return jsonOk(invoiceToApi(merchant, inv));
}

async function batchStatusHandler(env, merchant, url) {
  const idsParam = url.searchParams.get('ids') || '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const items = [];
  for (const id of ids) {
    const inv = await getInvoiceRow(env, id);
    if (!inv || inv.merchant_id !== merchant.id) {
      items.push({ id, found: false });
    } else {
      items.push({ id, found: true, ...invoiceToApi(merchant, inv) });
    }
  }
  return jsonOk(items);
}

async function cancelInvoiceHandler(env, merchant, invoiceId) {
  const inv = await getInvoiceRow(env, invoiceId);
  if (!inv || inv.merchant_id !== merchant.id) return jsonFail(404, 'invoice_not_found');
  if (inv.status === 'pending') {
    await env.DB.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .bind(invoiceId).run();
    inv.status = 'cancelled';
  }
  // Status non-pending dikembalikan apa adanya: invoice lunas TIDAK boleh
  // ikut terbatalkan oleh panggilan cancel yang terlambat.
  return jsonOk(invoiceToApi(merchant, inv));
}

// ---------------------------------------------------------------------------
// Callback keluar — antrean D1 + kirim segera + retry backoff (cron)
// ---------------------------------------------------------------------------

function paidCallbackPayload(merchant, inv) {
  return {
    event: 'invoice.paid',
    invoice_id: inv.id,
    merchant_id: merchant.id,
    amount: inv.total, // amount selalu TOTAL (base + kode unik)
    base_amount: inv.base_amount,
    unique_code: inv.unique_code,
    label: inv.label ?? '',
    status: 'paid',
    paid_at: new Date(inv.paid_at).toISOString(),
  };
}

function expiredCallbackPayload(merchant, inv) {
  return {
    event: 'invoice.expired',
    invoice_id: inv.id,
    merchant_id: merchant.id,
    amount: inv.total,
    base_amount: inv.base_amount,
    unique_code: inv.unique_code,
    label: inv.label ?? '',
    status: 'expired',
  };
}

/**
 * Satu percobaan kirim callback. delivery_id stabil per baris; signature
 * dihitung ulang dari payload tersimpan (body mentah yang sama persis).
 * Gagal → jadwalkan retry berikutnya dari CALLBACK_BACKOFF_MS; setelah
 * kirim ke-MAX_CALLBACK_SENDS berhenti (next_attempt_at NULL).
 */
async function attemptCallbackDelivery(env, merchant, row) {
  const sends = (row.attempts || 0) + 1;
  let httpStatus = 0;
  let delivered = false;
  if (merchant && merchant.callbackUrl) {
    try {
      const res = await fetch(merchant.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kriskris-Event': row.event,
          'X-Kriskris-Delivery': row.delivery_id,
          'X-Kriskris-Signature': await buildCallbackSignature(merchant.callbackSecret, row.payload),
        },
        body: row.payload,
      });
      httpStatus = res.status;
      delivered = httpStatus >= 200 && httpStatus < 300;
    } catch (e) {
      httpStatus = 0; // kegagalan jaringan — retry terjadwal di bawah
    }
  }
  const now = Date.now();
  if (delivered) {
    await env.DB.prepare(
      'UPDATE callbacks SET attempts = ?, delivered_at = ?, last_status = ? WHERE delivery_id = ?'
    ).bind(sends, now, httpStatus, row.delivery_id).run();
  } else {
    const nextAttemptAt =
      sends >= MAX_CALLBACK_SENDS ? null : now + CALLBACK_BACKOFF_MS[sends - 1];
    await env.DB.prepare(
      'UPDATE callbacks SET attempts = ?, last_status = ?, next_attempt_at = ? WHERE delivery_id = ?'
    ).bind(sends, httpStatus, nextAttemptAt, row.delivery_id).run();
  }
  return delivered;
}

/**
 * Buat baris callback (delivery_id baru, ikut tertanam di body agar
 * penerima bisa dedupe) lalu LANGSUNG coba kirim sekali; kegagalan
 * diteruskan ke antrean retry cron.
 */
async function enqueueCallback(env, merchant, { invoiceId, event, payload }) {
  const deliveryId = crypto.randomUUID();
  const rawPayload = JSON.stringify({ ...payload, delivery_id: deliveryId });
  await env.DB.prepare(
    `INSERT INTO callbacks (delivery_id, invoice_id, merchant_id, event, payload, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(deliveryId, invoiceId ?? null, merchant.id, event, rawPayload, Date.now()).run();
  const delivered = await attemptCallbackDelivery(env, merchant, {
    delivery_id: deliveryId, event, payload: rawPayload, attempts: 0,
  });
  return { deliveryId, delivered };
}

/** Proses callback jatuh tempo (dipanggil cron). Merchant diikuti dari
 * kolom merchant_id baris callback; baris lama (NULL) diikuti lewat
 * invoice; sisanya (test.ping pra-v2) → merchant default. */
async function processDueCallbacks(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM callbacks
     WHERE delivered_at IS NULL AND attempts < ?
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY next_attempt_at ASC LIMIT 50`
  ).bind(MAX_CALLBACK_SENDS, now).all();
  for (const row of results || []) {
    let merchant = null;
    if (row.merchant_id) {
      merchant = await resolveMerchantById(env, row.merchant_id);
    }
    if (!merchant && row.invoice_id) {
      const inv = await getInvoiceRow(env, row.invoice_id);
      if (inv) merchant = await resolveMerchantById(env, inv.merchant_id);
    }
    merchant = merchant || envMerchant(env);
    await attemptCallbackDelivery(env, merchant, row);
  }
}

// ---------------------------------------------------------------------------
// Pencocokan transaksi (cron)
// ---------------------------------------------------------------------------

/**
 * Satu transaksi cocok untuk satu invoice bila:
 *  - belum pernah dipakai (used_tx / set in-memory),
 *  - statusnya bukan REFUND/PARTIAL_REFUND (refund BUKAN pembayaran —
 *    status itu ikut diambil hanya karena query portal memang begitu),
 *  - gross_amount/100 == total invoice PERSIS (gross_amount dalam SEN),
 *  - transaction_time >= created_at invoice − toleransi 120 detik.
 * Pencocokan berlaku per AKUN GoBiz: transaksi outlet yang sama tidak
 * boleh dipakai dua invoice dari domain mana pun (lihat invariant unik
 * di getPendingTotals).
 */
function isMatchableTx(tx, inv, usedTxIds) {
  if (!tx || tx.id == null) return false;
  if (usedTxIds.has(String(tx.id))) return false;
  const status = String(tx.transaction_status || '');
  if (status === 'REFUND' || status === 'PARTIAL_REFUND') return false;
  if (Math.round(Number(tx.gross_amount) / 100) !== inv.total) return false;
  const txTime = Date.parse(tx.transaction_time);
  if (Number.isNaN(txTime)) return false;
  return txTime >= inv.created_at - TX_TIME_TOLERANCE_MS;
}

async function markInvoicePaid(env, inv, txId, paidMs) {
  await env.DB.prepare(
    "UPDATE invoices SET status = 'paid', paid_at = ?, matched_tx_id = ? WHERE id = ? AND status = 'pending'"
  ).bind(paidMs, txId, inv.id).run();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO used_tx (tx_id, invoice_id, seen_at) VALUES (?, ?, ?)'
  ).bind(txId, inv.id, Date.now()).run();
}

async function runMerchantCron(env, merchant, now) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM invoices WHERE merchant_id = ? AND status = 'pending' ORDER BY created_at ASC"
  ).bind(merchant.id).all();
  const pendings = results || [];
  if (!pendings.length) return; // tanpa pending: JANGAN sentuh Gojek sama sekali

  let remaining = pendings;
  try {
    const gobizId = await ensureGobizMerchantId(env, merchant);
    const oldest = Math.min(...pendings.map((p) => p.created_at));
    // Jendela: invoice pending tertua − 5 menit s.d. sekarang.
    const txs = await fetchAllTransactions(env, merchant, gobizId, oldest - 5 * 60 * 1000, now);
    const { results: usedRows } = await env.DB.prepare('SELECT tx_id FROM used_tx').all();
    const used = new Set((usedRows || []).map((r) => String(r.tx_id)));
    remaining = [];
    for (const inv of pendings) { // tertua dulu — antrean adil
      const tx = txs.find((t) => isMatchableTx(t, inv, used));
      if (tx) {
        used.add(String(tx.id));
        const paidMs =
          Date.parse(tx.settlement_time || tx.transaction_time) ||
          Date.parse(tx.transaction_time) ||
          now;
        await markInvoicePaid(env, inv, String(tx.id), paidMs);
        await enqueueCallback(env, merchant, {
          invoiceId: inv.id,
          event: 'invoice.paid',
          payload: paidCallbackPayload(merchant, { ...inv, paid_at: paidMs }),
        });
      } else {
        remaining.push(inv);
      }
    }
  } catch (e) {
    // GoBiz sedang tidak bisa dijangkau: invoice JANGAN di-expire-kan
    // secara membabi buta pada menit ini bila belum sempat dicocokkan —
    // kecuali yang sudah lewat expires_at tetap di-expire di bawah,
    // sesuai kontrak kriskris (tagihan mati pada 15 menit).
    console.error(`[gobiz-bridge] polling merchant ${merchant.id} gagal: ${e.message}`);
    remaining = pendings;
  }

  for (const inv of remaining) {
    if (inv.expires_at <= now) {
      await env.DB.prepare(
        "UPDATE invoices SET status = 'expired' WHERE id = ? AND status = 'pending'"
      ).bind(inv.id).run();
      await enqueueCallback(env, merchant, {
        invoiceId: inv.id,
        event: 'invoice.expired',
        payload: expiredCallbackPayload(merchant, inv),
      });
    }
  }
}

async function runCron(env) {
  const now = Date.now();
  // Retry callback jatuh tempo diproses terpisah dari polling; keduanya
  // murah saat kosong. Bila tidak ada pending & tidak ada retry jatuh
  // tempo, run ini selesai tanpa menyentuh Gojek sama sekali.
  await processDueCallbacks(env, now);
  for (const merchant of await listMerchants(env)) {
    try {
      await runMerchantCron(env, merchant, now);
    } catch (e) {
      console.error(`[gobiz-bridge] cron merchant ${merchant.id} gagal: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// /health & /admin/test-ping
// ---------------------------------------------------------------------------

/**
 * GET /health — TANPA auth, TANPA rahasia/token di respons. Ringkasan
 * merchant hanya memuat id + status aktif + status sesi (+ id outlet
 * GoBiz yang memang publik di payload QRIS). Mem-probe sesi GoBiz
 * secara live (merchants/search): inilah smoke test bahwa login
 * password bekerja dari egress Cloudflare.
 */
async function healthHandler(env) {
  const merchants = [];
  for (const merchant of await listMerchants(env)) {
    let session = 'inactive';
    let gobizMerchantId = await getConfig(env, `gobiz_merchant_id:${merchant.id}`);
    try {
      gobizMerchantId = await ensureGobizMerchantId(env, merchant, { probe: true });
      session = 'active';
    } catch (e) {
      session = 'inactive';
    }
    merchants.push({
      id: merchant.id,
      active: merchant.active !== false,
      session,
      gobiz_merchant_id: gobizMerchantId || null,
    });
  }
  return jsonOk({
    service: 'gobiz-bridge',
    time: new Date().toISOString(),
    merchants,
  });
}

/** POST /admin/test-ping — auth API yang sama; kirim callback test.ping. */
async function testPingHandler(env, merchant) {
  if (!merchant.callbackUrl) return jsonFail(500, 'callback_url_not_configured');
  const { deliveryId, delivered } = await enqueueCallback(env, merchant, {
    invoiceId: null,
    event: 'test.ping',
    payload: { event: 'test.ping', merchant_id: merchant.id },
  });
  return jsonOk({ event: 'test.ping', delivery_id: deliveryId, delivered });
}

// ---------------------------------------------------------------------------
// Auth request masuk (kontrak kriskris) & router
// ---------------------------------------------------------------------------

/**
 * Verifikasi: X-API-Key → resolveMerchant (konteks merchant),
 * X-Kriskris-Timestamp RFC3339 dalam ±5 menit, X-Kriskris-Signature
 * 'v1=<hex>' atas string kanonis 5 baris dengan apiSecret merchant itu.
 */
async function authenticate(env, req, rawBody, url) {
  const merchant = await resolveMerchant(env, req.headers.get('x-api-key'));
  if (!merchant) return { ok: false, status: 401, error: 'invalid_api_key' };

  const timestamp = req.headers.get('x-kriskris-timestamp') || '';
  const tsMs = Date.parse(timestamp);
  if (!timestamp || Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, status: 401, error: 'timestamp_out_of_range' };
  }

  const canonical = await buildCanonicalString({
    timestamp,
    method: req.method,
    path: url.pathname,
    query: url.search ? url.search.slice(1) : '',
    rawBody,
  });
  const expected = 'v1=' + (await hmacSha256Hex(merchant.apiSecret, canonical));
  const given = (req.headers.get('x-kriskris-signature') || '').trim();
  if (!timingSafeEqualStr(given, expected)) {
    return { ok: false, status: 401, error: 'invalid_signature' };
  }
  return { ok: true, merchant };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/health') return await healthHandler(env);

      const isInvoicePath =
        path === '/api/v1/external/invoices' || path.startsWith('/api/v1/external/invoices/');
      if (isInvoicePath || path === '/admin/test-ping') {
        const rawBody = await req.text();
        const auth = await authenticate(env, req, rawBody, url);
        if (!auth.ok) return jsonFail(auth.status, auth.error);
        const merchant = auth.merchant;

        if (path === '/admin/test-ping' && req.method === 'POST') {
          return await testPingHandler(env, merchant);
        }
        if (path === '/api/v1/external/invoices' && req.method === 'POST') {
          return await createInvoiceHandler(env, merchant, rawBody);
        }
        // '/status' literal HARUS didahulukan dari pola '/{id}'.
        if (path === '/api/v1/external/invoices/status' && req.method === 'GET') {
          return await batchStatusHandler(env, merchant, url);
        }
        const cancelMatch = path.match(/^\/api\/v1\/external\/invoices\/([^/]+)\/cancel$/);
        if (cancelMatch && req.method === 'POST') {
          return await cancelInvoiceHandler(env, merchant, decodeURIComponent(cancelMatch[1]));
        }
        const getMatch = path.match(/^\/api\/v1\/external\/invoices\/([^/]+)$/);
        if (getMatch && req.method === 'GET') {
          return await getInvoiceHandler(env, merchant, decodeURIComponent(getMatch[1]));
        }
        return jsonFail(404, 'not_found');
      }

      return jsonFail(404, 'not_found');
    } catch (e) {
      console.error('[gobiz-bridge] error:', e);
      return jsonFail(500, 'internal_error');
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

// Ekspor untuk test lokal (Node, tanpa jaringan) — tidak dipakai runtime.
export {
  crc16Ccitt,
  parseEmvTlv,
  serializeEmvTlv,
  buildDynamicQrPayload,
  sha256Hex,
  hmacSha256Hex,
  buildCanonicalString,
  buildCallbackSignature,
  pickUniqueCode,
  resolveMerchant,
  resolveMerchantById,
  listMerchants,
  rowToMerchantContext,
  envMerchant,
  defaultMerchant,
  authenticate,
  enqueueCallback,
  processDueCallbacks,
  CALLBACK_BACKOFF_MS,
  MAX_CALLBACK_SENDS,
};
