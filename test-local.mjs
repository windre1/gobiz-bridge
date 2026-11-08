/**
 * test-local.mjs — Test LOKAL gobiz-bridge v2 (jaringan hanya fetch-stub
 * internal; tidak ada panggilan keluar sama sekali).
 *
 * Bagian v1 (9 test pertama):
 *  (a) EMV TLV: tulis ulang nominal (tag 54) + validitas CRC16-CCITT,
 *  (b) tanda tangan request masuk (kanonis 5 baris kriskris): round-trip
 *      sign/verify memakai penanda tangan INDEPENDEN (node:crypto, sama
 *      seperti lib/kriskris.js sisi default) + penolakan tamper,
 *  (c) format signature callback keluar: 'sha256=<hex>' atas body mentah,
 *  (d) logika hindar-tabrakan kode unik (pickUniqueCode),
 *  (e) resolusi merchant fallback env (perilaku v1).
 *
 * Bagian v2 (multi-merchant, memakai D1 PALSU in-memory):
 *  (f) resolusi BERDASARKAN API KEY dari tabel merchants + prioritas
 *      baris D1 di atas env + fallback env default tetap utuh,
 *  (g) penolakan signature lintas-merchant (key A + secret B → 401),
 *  (h) merchant nonaktif ditolak di auth API,
 *  (i) callback_url + callback_secret dipilih PER MERCHANT (kirim
 *      langsung test.ping & antrean retry cron),
 *  (j) tabrakan total pending GLOBAL lintas merchant dicegah,
 *  (k) isolasi invoice antar-merchant (GET/batch → 404/found:false),
 *  (l) /health merangkum semua merchant tanpa membocorkan rahasia.
 *
 * Bagian v3 (payload QRIS per-merchant):
 *  (m) buildDynamicQrPayload di atas payload statis KEDUA yang berbeda
 *      (nama outlet lain + tag 54 warisan) → nominal terganti + CRC valid,
 *  (n) pembuatan invoice memakai payload baris merchant pemiliknya,
 *      dan jatuh ke payload env bila kolomnya NULL,
 *  (o) keunikan total GLOBAL tetap berlaku lintas merchant yang
 *      payload-nya BERBEDA.
 *
 * Jalankan: node test-local.mjs
 */

import assert from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import worker, {
  crc16Ccitt,
  parseEmvTlv,
  buildDynamicQrPayload,
  buildCallbackSignature,
  pickUniqueCode,
  resolveMerchant,
  resolveMerchantById,
  listMerchants,
  enqueueCallback,
  processDueCallbacks,
  authenticate,
} from './src/index.js';

let lolos = 0;
async function ok(nama, fn) {
  await fn();
  lolos++;
  console.log('PASS:', nama);
}

const tlv = (tag, value) => tag + String(value.length).padStart(2, '0') + value;
const crcHex = (s) => crc16Ccitt(s).toString(16).toUpperCase().padStart(4, '0');

// ---------------------------------------------------------------- (a) EMV
await ok('CRC16-CCITT: vektor baku "123456789" = 0x29B1', () => {
  assert.strictEqual(crc16Ccitt('123456789'), 0x29B1);
});

// Payload QRIS statis contoh (tanpa nominal, POI statis "11").
const merchantTemplate =
  tlv('00', 'ID.CO.QRIS.WWW') + tlv('01', '936009153456789012') +
  tlv('02', 'UMI') + tlv('03', 'ID1020001234567');
const staticBody =
  tlv('00', '01') + tlv('01', '11') + tlv('26', merchantTemplate) +
  tlv('52', '5411') + tlv('53', '360') + tlv('55', '01') +
  tlv('58', 'ID') + tlv('59', 'WINZ DIGITAL') + tlv('60', 'JAKARTA') +
  tlv('61', '10110') + '6304';
const staticPayload = staticBody + crcHex(staticBody);

await ok('EMV: sisip tag 54 + POI jadi "12" + CRC valid (vektor baku & hitung ulang EMVCo)', () => {
  const dyn = buildDynamicQrPayload(staticPayload, 65050);
  const parts = parseEmvTlv(dyn);
  const byTag = Object.fromEntries(parts.map((p) => [p.tag, p.value]));
  assert.strictEqual(byTag['54'], '65050');       // nominal = total persis
  assert.strictEqual(byTag['01'], '12');          // point of initiation dinamis
  assert.strictEqual(byTag['53'], '360');          // field lain utuh
  assert.strictEqual(byTag['59'], 'WINZ DIGITAL');
  // CRC terverifikasi cara EMVCo: hitung ulang atas seluruh payload
  // termasuk penanda "6304" (payload minus 4 char CRC) == 4 char CRC di
  // ekor. (Properti "residu 0" tidak berlaku di sini karena CRC QRIS
  // ditempel sebagai karakter hex ASCII, bukan byte mentah.)
  assert.strictEqual(crcHex(dyn.slice(0, -4)), dyn.slice(-4));
  // Urutan EMV: tag 54 duduk di antara 53 dan 55.
  const tags = parts.map((p) => p.tag);
  assert.ok(tags.indexOf('53') < tags.indexOf('54') && tags.indexOf('54') < tags.indexOf('55'));
});

await ok('EMV: tag 54 yang sudah ada diganti (panjang berubah) + CRC tetap valid', () => {
  const withAmtBody =
    tlv('00', '01') + tlv('01', '11') + tlv('26', merchantTemplate) +
    tlv('52', '5411') + tlv('53', '360') + tlv('54', '1000') +
    tlv('58', 'ID') + tlv('59', 'WINZ DIGITAL') + tlv('60', 'JAKARTA') + '6304';
  const withAmt = withAmtBody + crcHex(withAmtBody);
  const dyn = buildDynamicQrPayload(withAmt, 297123);
  const byTag = Object.fromEntries(parseEmvTlv(dyn).map((p) => [p.tag, p.value]));
  assert.strictEqual(byTag['54'], '297123');
  assert.strictEqual(crcHex(dyn.slice(0, -4)), dyn.slice(-4));
});

// ------------------------------------------------------- (b) signature masuk
const ENV = {
  BRIDGE_API_KEY: 'key-uji',
  BRIDGE_API_SECRET: 'secret-uji',
  BRIDGE_CALLBACK_SECRET: 'cb-secret-uji',
  CALLBACK_URL: 'https://example.invalid/callback',
  GOBIZ_EMAIL: 'uji@example.invalid',
  GOBIZ_PASSWORD: 'tidak-dipakai-di-test',
  STATIC_QRIS_PAYLOAD: staticPayload,
  GOBIZ_APP_VERSION: 'platform-vTest',
};

// Penanda tangan independen — replikasi persis lib/kriskris.js default.
function signIndependent({ secret, timestamp, method, path, query = '', rawBody = '' }) {
  const digest = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const canonical = [timestamp, method, path, query, digest].join('\n');
  return 'v1=' + createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}
const rfc3339 = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function reqFor({ url, method = 'GET', body = '', timestamp, signature, apiKey = 'key-uji' }) {
  return new Request(url, {
    method,
    headers: {
      'x-api-key': apiKey,
      'x-kriskris-timestamp': timestamp,
      'x-kriskris-signature': signature,
      'content-type': 'application/json',
    },
    body: method === 'GET' ? undefined : body,
  });
}

await ok('signature masuk: POST /invoices valid → merchant konteks "default"', async () => {
  const body = '{"amount":65000,"label":"ORDER-1"}';
  const ts = rfc3339(new Date());
  const sig = signIndependent({
    secret: 'secret-uji', timestamp: ts, method: 'POST',
    path: '/api/v1/external/invoices', rawBody: body,
  });
  const url = new URL('https://bridge.test/api/v1/external/invoices');
  const req = reqFor({ url, method: 'POST', body, timestamp: ts, signature: sig });
  const auth = await authenticate(ENV, req, body, url);
  assert.strictEqual(auth.ok, true);
  assert.strictEqual(auth.merchant.id, 'default');
});

await ok('signature masuk: GET batch (query ikut ditandatangani) valid', async () => {
  const ts = rfc3339(new Date());
  const sig = signIndependent({
    secret: 'secret-uji', timestamp: ts, method: 'GET',
    path: '/api/v1/external/invoices/status', query: 'ids=inv-a,inv-b', rawBody: '',
  });
  const url = new URL('https://bridge.test/api/v1/external/invoices/status?ids=inv-a,inv-b');
  const req = reqFor({ url, timestamp: ts, signature: sig });
  const auth = await authenticate(ENV, req, '', url);
  assert.strictEqual(auth.ok, true);
});

await ok('signature masuk: body diubah / secret salah / key salah / timestamp basi → ditolak', async () => {
  const body = '{"amount":65000,"label":"ORDER-1"}';
  const ts = rfc3339(new Date());
  const sig = signIndependent({
    secret: 'secret-uji', timestamp: ts, method: 'POST',
    path: '/api/v1/external/invoices', rawBody: body,
  });
  const url = new URL('https://bridge.test/api/v1/external/invoices');

  // body ditamper setelah ditandatangani
  let req = reqFor({ url, method: 'POST', body: body.replace('65000', '1000'), timestamp: ts, signature: sig });
  let auth = await authenticate(ENV, req, body.replace('65000', '1000'), url);
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.error, 'invalid_signature');

  // ditandatangani secret lain
  const sigLain = signIndependent({
    secret: 'secret-lain', timestamp: ts, method: 'POST',
    path: '/api/v1/external/invoices', rawBody: body,
  });
  req = reqFor({ url, method: 'POST', body, timestamp: ts, signature: sigLain });
  auth = await authenticate(ENV, req, body, url);
  assert.strictEqual(auth.ok, false);

  // API key salah
  req = reqFor({ url, method: 'POST', body, timestamp: ts, signature: sig, apiKey: 'key-salah' });
  auth = await authenticate(ENV, req, body, url);
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.error, 'invalid_api_key');

  // timestamp 10 menit lalu (di luar toleransi ±5 menit), signature benar
  const tsBasi = rfc3339(new Date(Date.now() - 10 * 60 * 1000));
  const sigBasi = signIndependent({
    secret: 'secret-uji', timestamp: tsBasi, method: 'POST',
    path: '/api/v1/external/invoices', rawBody: body,
  });
  req = reqFor({ url, method: 'POST', body, timestamp: tsBasi, signature: sigBasi });
  auth = await authenticate(ENV, req, body, url);
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.error, 'timestamp_out_of_range');
});

// ---------------------------------------------------- (c) signature callback
await ok('signature callback: format sha256=<hex64> & cocok HMAC independen', async () => {
  const raw = JSON.stringify({ event: 'invoice.paid', delivery_id: 'd-1', invoice_id: 'inv-1', amount: 65050 });
  const sig = await buildCallbackSignature('cb-secret-uji', raw);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  const independen = 'sha256=' + createHmac('sha256', 'cb-secret-uji').update(raw, 'utf8').digest('hex');
  assert.strictEqual(sig, independen);
  // body berubah → signature berubah
  const sigLain = await buildCallbackSignature('cb-secret-uji', raw + ' ');
  assert.notStrictEqual(sigLain, sig);
});

// ---------------------------------------------------------- (d) kode unik
await ok('pickUniqueCode: melewati total yang sudah pending, null bila 90 kode habis', () => {
  // rng deterministik: menyapu kode 10, 11, 12, … secara berurutan
  let k = 0;
  const sweep = () => (((k++) % 90) + 0.5) / 90;

  k = 0;
  assert.strictEqual(pickUniqueCode(65000, new Set(), sweep), 10);

  k = 0;
  const terisi = new Set();
  for (let c = 10; c <= 29; c++) terisi.add(65000 + c); // kode 10–29 terpakai
  assert.strictEqual(pickUniqueCode(65000, terisi, sweep), 30);

  k = 0;
  const penuh = new Set();
  for (let c = 10; c <= 99; c++) penuh.add(65000 + c);
  assert.strictEqual(pickUniqueCode(65000, penuh, sweep), null);

  // total milik harga dasar lain tidak menghalangi
  k = 0;
  assert.strictEqual(pickUniqueCode(100000, new Set([65010, 65011]), sweep), 10);
});

// ------------------------------------------------------------- konteks merchant
await ok('resolveMerchant: key benar → konteks default; key salah → null', async () => {
  const ctx = await resolveMerchant(ENV, 'key-uji');
  assert.strictEqual(ctx.id, 'default');
  assert.strictEqual(ctx.apiSecret, 'secret-uji');
  assert.strictEqual(ctx.callbackUrl, 'https://example.invalid/callback');
  assert.strictEqual(await resolveMerchant(ENV, 'bukan-key'), null);
  assert.strictEqual(await resolveMerchant(ENV, ''), null);
});

// =========================================================================
// BAGIAN v2 — MULTI-MERCHANT (D1 palsu in-memory + fetch stub)
// =========================================================================

// D1 palsu: hanya mendukung pola SQL yang dipakai jalur yang diuji.
function createFakeDb(seed = {}) {
  const state = {
    merchants: (seed.merchants || []).map((r) => ({ ...r })),
    invoices: (seed.invoices || []).map((r) => ({ ...r })),
    callbacks: (seed.callbacks || []).map((r) => ({ ...r })),
  };
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

  function runFirst(sql, b) {
    if (sql.startsWith('SELECT * FROM merchants WHERE api_key = ?'))
      return state.merchants.find((m) => m.api_key === b[0]) || null;
    if (sql.startsWith('SELECT * FROM merchants WHERE id = ?'))
      return state.merchants.find((m) => m.id === b[0]) || null;
    if (sql.startsWith('SELECT value FROM config WHERE key = ?')) return null;
    if (sql.startsWith('SELECT merchant_id, access_token, refresh_token, updated_at FROM session'))
      return null;
    if (sql.startsWith('SELECT * FROM invoices WHERE id = ?'))
      return state.invoices.find((i) => i.id === b[0]) || null;
    throw new Error('fakeDb.first tidak kenal: ' + sql);
  }
  function runAll(sql, b) {
    if (sql.startsWith('SELECT * FROM merchants'))
      return [...state.merchants].sort((x, y) => String(x.id).localeCompare(String(y.id)));
    if (sql.startsWith('SELECT total FROM invoices WHERE status ='))
      return state.invoices.filter((i) => i.status === 'pending').map((i) => ({ total: i.total }));
    if (sql.startsWith('SELECT * FROM invoices WHERE merchant_id = ?'))
      return state.invoices.filter((i) => i.merchant_id === b[0] && i.status === b[1]);
    if (sql.startsWith('SELECT tx_id FROM used_tx')) return [];
    if (sql.startsWith('SELECT * FROM callbacks'))
      return state.callbacks.filter(
        (c) => c.delivered_at == null && c.attempts < b[0] &&
          (c.next_attempt_at == null || c.next_attempt_at <= b[1])
      );
    throw new Error('fakeDb.all tidak kenal: ' + sql);
  }
  function runExec(sql, b) {
    if (sql.startsWith('INSERT INTO callbacks')) {
      state.callbacks.push({
        delivery_id: b[0], invoice_id: b[1], merchant_id: b[2], event: b[3],
        payload: b[4], attempts: b[5], next_attempt_at: b[6],
        delivered_at: null, last_status: null,
      });
      return;
    }
    if (sql.startsWith('INSERT INTO invoices')) {
      state.invoices.push({
        id: b[0], merchant_id: b[1], label: b[2], base_amount: b[3],
        unique_code: b[4], total: b[5], status: 'pending', created_at: b[6],
        expires_at: b[7], paid_at: null, matched_tx_id: null, created_via: 'api',
      });
      return;
    }
    if (sql.startsWith('UPDATE callbacks SET attempts = ?, delivered_at = ?')) {
      const row = state.callbacks.find((c) => c.delivery_id === b[3]);
      if (row) { row.attempts = b[0]; row.delivered_at = b[1]; row.last_status = b[2]; }
      return;
    }
    if (sql.startsWith('UPDATE callbacks SET attempts = ?, last_status = ?')) {
      const row = state.callbacks.find((c) => c.delivery_id === b[3]);
      if (row) { row.attempts = b[0]; row.last_status = b[1]; row.next_attempt_at = b[2]; }
      return;
    }
    if (sql.startsWith("UPDATE invoices SET status = 'cancelled'")) {
      const inv = state.invoices.find((i) => i.id === b[0]);
      if (inv && inv.status === 'pending') inv.status = 'cancelled';
      return;
    }
    if (sql.startsWith("UPDATE invoices SET status = 'expired'")) {
      const inv = state.invoices.find((i) => i.id === b[0]);
      if (inv && inv.status === 'pending') inv.status = 'expired';
      return;
    }
    if (sql.startsWith("UPDATE invoices SET status = 'paid'")) {
      const inv = state.invoices.find((i) => i.id === b[2]);
      if (inv && inv.status === 'pending') {
        inv.status = 'paid'; inv.paid_at = b[0]; inv.matched_tx_id = b[1];
      }
      return;
    }
    if (sql.startsWith('INSERT OR IGNORE INTO used_tx')) return;
    if (sql.startsWith('INSERT INTO session')) return;
    throw new Error('fakeDb.run tidak kenal: ' + sql);
  }
  function prepare(sqlRaw) {
    const sql = norm(sqlRaw);
    let binds = [];
    const stmt = {
      bind(...args) { binds = args; return stmt; },
      async first() { return runFirst(sql, binds); },
      async all() { return { results: runAll(sql, binds) }; },
      async run() { runExec(sql, binds); return { success: true }; },
    };
    return stmt;
  }
  return { DB: { prepare }, state };
}

// Kredensial uji tiga merchant. Nilai env SENGAJA berbeda dari baris
// default supaya prioritas baris-D1-di-atas-env bisa dibuktikan.
const GP_ROW = {
  id: 'default', name: 'Gama Pro', domain: 'default.example.com',
  api_key: 'gob_row_default_key', api_secret: 'row-default-secret',
  callback_secret: 'row-default-cbsecret',
  callback_url: 'https://default.example/callback', active: 1, created_at: 1,
};
const SH_ROW = {
  id: 'demoshop', name: 'Shove', domain: 'demoshop.my.id',
  api_key: 'gob_row_shove_key', api_secret: 'row-demoshop-secret',
  callback_secret: 'row-demoshop-cbsecret',
  callback_url: 'https://demoshop.example/callback', active: 1, created_at: 2,
};
const DORMANT_ROW = {
  id: 'dormant', name: 'Dormant', domain: 'dormant.example',
  api_key: 'gob_row_dormant_key', api_secret: 'row-dormant-secret',
  callback_secret: 'row-dormant-cbsecret',
  callback_url: 'https://dormant.example/callback', active: 0, created_at: 3,
};

function makeEnv2(seed = {}) {
  const { DB, state } = createFakeDb({
    merchants: [GP_ROW, SH_ROW, DORMANT_ROW],
    ...seed,
  });
  return {
    env: {
      DB,
      // env fallback default — nilai BERBEDA dari baris D1 default.
      BRIDGE_API_KEY: 'gob_env_fallback_key',
      BRIDGE_API_SECRET: 'env-fallback-secret',
      BRIDGE_CALLBACK_SECRET: 'env-fallback-cbsecret',
      CALLBACK_URL: 'https://env-fallback.example/callback',
      // TANPA GOBIZ_EMAIL/PASSWORD: probe sesi /health harus 'inactive'
      // dan tidak ada panggilan jaringan yang boleh lolos ke GoBiz.
      GOBIZ_EMAIL: '', GOBIZ_PASSWORD: '',
      STATIC_QRIS_PAYLOAD: staticPayload,
      GOBIZ_APP_VERSION: 'platform-vTest',
    },
    state,
  };
}

// Penanda tangan request untuk jalur worker.fetch (independen, sama
// seperti signIndependent di atas tapi dibungkus untuk konteks merchant).
function signedRequest({ merchant, method = 'POST', path, query = '', body = '' }) {
  const ts = rfc3339(new Date());
  const sig = signIndependent({
    secret: merchant.api_secret, timestamp: ts, method, path, query, rawBody: body,
  });
  const url = new URL('https://bridge.test' + path + (query ? '?' + query : ''));
  return new Request(url, {
    method,
    headers: {
      'x-api-key': merchant.api_key,
      'x-kriskris-timestamp': ts,
      'x-kriskris-signature': sig,
      'content-type': 'application/json',
    },
    body: method === 'GET' ? undefined : body,
  });
}
const CTX = { waitUntil() {} };

// ---------------------------------------------------------- (f) resolusi D1
await ok('v2 resolusi: key → baris merchant-nya; baris D1 menang atas env; fallback env utuh', async () => {
  const { env } = makeEnv2();

  const demoshop = await resolveMerchant(env, SH_ROW.api_key);
  assert.strictEqual(demoshop.id, 'demoshop');
  assert.strictEqual(demoshop.apiSecret, 'row-demoshop-secret');
  assert.strictEqual(demoshop.callbackUrl, 'https://demoshop.example/callback');

  const gpRow = await resolveMerchant(env, GP_ROW.api_key);
  assert.strictEqual(gpRow.id, 'default');
  assert.strictEqual(gpRow.apiSecret, 'row-default-secret'); // BUKAN env

  // key env tidak ada di tabel mana pun → fallback env v1 persis.
  const gpEnv = await resolveMerchant(env, 'gob_env_fallback_key');
  assert.strictEqual(gpEnv.id, 'default');
  assert.strictEqual(gpEnv.apiSecret, 'env-fallback-secret');
  assert.strictEqual(gpEnv.callbackUrl, 'https://env-fallback.example/callback');

  assert.strictEqual(await resolveMerchant(env, 'gob_tidak_ada'), null);

  const daftar = await listMerchants(env);
  assert.deepStrictEqual(daftar.map((m) => m.id), ['default', 'demoshop', 'dormant']);
  const byId = await resolveMerchantById(env, 'demoshop');
  assert.strictEqual(byId.callbackSecret, 'row-demoshop-cbsecret');
});

// ------------------------------------------- (g) signature lintas-merchant
await ok('v2 auth: key demoshop + secret default → invalid_signature; pasangan benar → lolos', async () => {
  const { env } = makeEnv2();
  const body = '{"amount":65000,"label":"ORDER-X"}';
  const path = '/api/v1/external/invoices';
  const url = new URL('https://bridge.test' + path);
  const ts = rfc3339(new Date());

  // key milik demoshop, signature dibuat secret default (baris)
  const sigSilang = signIndependent({
    secret: GP_ROW.api_secret, timestamp: ts, method: 'POST', path, rawBody: body,
  });
  let req = new Request(url, {
    method: 'POST',
    headers: {
      'x-api-key': SH_ROW.api_key, 'x-kriskris-timestamp': ts,
      'x-kriskris-signature': sigSilang, 'content-type': 'application/json',
    },
    body,
  });
  let auth = await authenticate(env, req, body, url);
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.error, 'invalid_signature');

  // key demoshop + secret env-fallback default → tetap ditolak
  const sigEnv = signIndependent({
    secret: 'env-fallback-secret', timestamp: ts, method: 'POST', path, rawBody: body,
  });
  req = new Request(url, {
    method: 'POST',
    headers: {
      'x-api-key': SH_ROW.api_key, 'x-kriskris-timestamp': ts,
      'x-kriskris-signature': sigEnv, 'content-type': 'application/json',
    },
    body,
  });
  auth = await authenticate(env, req, body, url);
  assert.strictEqual(auth.ok, false);

  // pasangan benar untuk masing-masing jalur
  req = signedRequest({ merchant: SH_ROW, path, body });
  auth = await authenticate(env, req, body, new URL(req.url));
  assert.strictEqual(auth.ok, true);
  assert.strictEqual(auth.merchant.id, 'demoshop');

  const envCreds = { api_key: 'gob_env_fallback_key', api_secret: 'env-fallback-secret' };
  req = signedRequest({ merchant: envCreds, path, body });
  auth = await authenticate(env, req, body, new URL(req.url));
  assert.strictEqual(auth.ok, true);
  assert.strictEqual(auth.merchant.id, 'default'); // fallback env
});

// ------------------------------------------------------- (h) merchant nonaktif
await ok('v2 auth: merchant active=0 ditolak seperti key tidak dikenal', async () => {
  const { env } = makeEnv2();
  assert.strictEqual(await resolveMerchant(env, DORMANT_ROW.api_key), null);
  const body = '{"amount":1000}';
  const req = signedRequest({ merchant: DORMANT_ROW, path: '/api/v1/external/invoices', body });
  const auth = await authenticate(env, req, body, new URL(req.url));
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.error, 'invalid_api_key');
  // …tetapi resolusi by-id (untuk callback lama) tetap mengembalikannya.
  const byId = await resolveMerchantById(env, 'dormant');
  assert.strictEqual(byId.id, 'dormant');
  assert.strictEqual(byId.active, false);
});

// ------------------------------------------- (i) callback per-merchant
await ok('v2 callback: test.ping & antrean retry memakai URL + secret merchant masing-masing', async () => {
  const { env, state } = makeEnv2({
    invoices: [
      { id: 'inv-demoshop-1', merchant_id: 'demoshop', label: 'S-1', base_amount: 65000, unique_code: 31, total: 65031, status: 'paid', created_at: 1, expires_at: 2, paid_at: 3, matched_tx_id: 'tx-1', created_via: 'api' },
      { id: 'inv-gp-1', merchant_id: 'default', label: 'G-1', base_amount: 100000, unique_code: 11, total: 100011, status: 'paid', created_at: 1, expires_at: 2, paid_at: 3, matched_tx_id: 'tx-2', created_via: 'api' },
    ],
    callbacks: [
      // retry jatuh tempo: satu milik demoshop (lewat merchant_id kolom v2),
      // satu milik default model lama (merchant_id NULL → lewat invoice).
      { delivery_id: 'd-retry-demoshop', invoice_id: 'inv-demoshop-1', merchant_id: 'demoshop', event: 'invoice.paid', payload: '{"event":"invoice.paid","merchant_id":"demoshop"}', attempts: 1, next_attempt_at: 1, delivered_at: null, last_status: 500 },
      { delivery_id: 'd-retry-gp', invoice_id: 'inv-gp-1', merchant_id: null, event: 'invoice.paid', payload: '{"event":"invoice.paid","merchant_id":"default"}', attempts: 1, next_attempt_at: 1, delivered_at: null, last_status: 500 },
    ],
  });

  const terkirim = [];
  const fetchAsli = globalThis.fetch;
  globalThis.fetch = async (u, opts = {}) => {
    terkirim.push({ url: String(u), headers: opts.headers || {}, body: opts.body });
    return new Response('ok', { status: 200 });
  };
  try {
    // 1) test.ping lewat jalur HTTP penuh (auth per merchant berlaku)
    const res = await worker.fetch(
      signedRequest({ merchant: SH_ROW, path: '/admin/test-ping', body: '' }), env, CTX
    );
    assert.strictEqual(res.status, 200);
    // 2) antrean retry cron
    await processDueCallbacks(env, Date.now());
  } finally {
    globalThis.fetch = fetchAsli;
  }

  const sigUntuk = (secret, body) =>
    'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  // test.ping demoshop → URL demoshop, ditandatangani callback_secret demoshop
  const ping = terkirim.find((t) => JSON.parse(t.body).event === 'test.ping');
  assert.ok(ping, 'test.ping terkirim');
  assert.strictEqual(ping.url, 'https://demoshop.example/callback');
  assert.strictEqual(ping.headers['X-Kriskris-Signature'], sigUntuk(SH_ROW.callback_secret, ping.body));
  assert.strictEqual(JSON.parse(ping.body).merchant_id, 'demoshop');

  // retry demoshop → URL + secret demoshop; retry default (baris lama) → URL + secret baris default
  const retryShove = terkirim.find((t) => t.headers['X-Kriskris-Delivery'] === 'd-retry-demoshop');
  assert.strictEqual(retryShove.url, 'https://demoshop.example/callback');
  assert.strictEqual(retryShove.headers['X-Kriskris-Signature'], sigUntuk(SH_ROW.callback_secret, retryShove.body));
  const retryGp = terkirim.find((t) => t.headers['X-Kriskris-Delivery'] === 'd-retry-gp');
  assert.strictEqual(retryGp.url, 'https://default.example/callback');
  assert.strictEqual(retryGp.headers['X-Kriskris-Signature'], sigUntuk(GP_ROW.callback_secret, retryGp.body));

  // semua tercatat delivered di D1 palsu
  assert.ok(state.callbacks.every((c) => c.delivered_at != null));
});

// --------------------------------- (j) tabrakan total GLOBAL lintas merchant
await ok('v2 invoice: total pending default menghalangi demoshop — kode bergeser, bukan menabrak', async () => {
  const { env, state } = makeEnv2({
    invoices: [
      // default sedang memegang total 65030 (kode 30 untuk base 65000)
      { id: 'inv-gp-pending', merchant_id: 'default', label: 'G-P', base_amount: 65000, unique_code: 30, total: 65030, status: 'pending', created_at: Date.now(), expires_at: Date.now() + 900000, paid_at: null, matched_tx_id: null, created_via: 'api' },
    ],
  });
  // Paksa RNG: kandidat pertama kode 30 (tabrakan), kedua kode 31.
  const acakAsli = Math.random;
  const urutan = [(30 - 10 + 0.5) / 90, (31 - 10 + 0.5) / 90];
  let idx = 0;
  Math.random = () => urutan[Math.min(idx++, urutan.length - 1)];
  let res;
  try {
    res = await worker.fetch(
      signedRequest({ merchant: SH_ROW, path: '/api/v1/external/invoices', body: '{"amount":65000,"label":"SHOVE-ORDER-1"}' }),
      env, CTX
    );
  } finally {
    Math.random = acakAsli;
  }
  assert.strictEqual(res.status, 201);
  const json = await res.json();
  assert.strictEqual(json.data.unique_code, 31);
  assert.strictEqual(json.data.amount, 65031);
  const barisBaru = state.invoices.find((i) => i.label === 'SHOVE-ORDER-1');
  assert.strictEqual(barisBaru.merchant_id, 'demoshop'); // label ter-namespace per merchant
  assert.strictEqual(barisBaru.total, 65031);
  // tidak ada dua invoice pending bertotal sama di SELURUH tabel
  const totals = state.invoices.filter((i) => i.status === 'pending').map((i) => i.total);
  assert.strictEqual(new Set(totals).size, totals.length);
});

// ------------------------------------------------- (k) isolasi antar-merchant
await ok('v2 isolasi: GET/batch invoice milik merchant lain → 404 / found:false', async () => {
  const { env } = makeEnv2({
    invoices: [
      { id: 'inv-demoshop-9', merchant_id: 'demoshop', label: 'S-9', base_amount: 65000, unique_code: 41, total: 65041, status: 'pending', created_at: Date.now(), expires_at: Date.now() + 900000, paid_at: null, matched_tx_id: null, created_via: 'api' },
    ],
  });
  // default (jalur baris D1) mencoba membaca invoice demoshop
  let res = await worker.fetch(
    signedRequest({ merchant: GP_ROW, method: 'GET', path: '/api/v1/external/invoices/inv-demoshop-9' }),
    env, CTX
  );
  assert.strictEqual(res.status, 404);

  // pemiliknya sendiri → 200
  res = await worker.fetch(
    signedRequest({ merchant: SH_ROW, method: 'GET', path: '/api/v1/external/invoices/inv-demoshop-9' }),
    env, CTX
  );
  assert.strictEqual(res.status, 200);
  const satu = await res.json();
  assert.strictEqual(satu.data.id, 'inv-demoshop-9');

  // batch: default menanyakan id demoshop → found:false (kontrak kriskris)
  res = await worker.fetch(
    signedRequest({ merchant: GP_ROW, method: 'GET', path: '/api/v1/external/invoices/status', query: 'ids=inv-demoshop-9' }),
    env, CTX
  );
  const batch = await res.json();
  assert.deepStrictEqual(batch.data, [{ id: 'inv-demoshop-9', found: false }]);
});

// ------------------------------------------------------------ (l) /health v2
await ok('v2 /health: ringkasan semua merchant + flag active, tanpa rahasia apa pun', async () => {
  const { env } = makeEnv2();
  const res = await worker.fetch(new Request('https://bridge.test/health'), env, CTX);
  assert.strictEqual(res.status, 200);
  const teks = await res.text();
  const json = JSON.parse(teks);
  const ringkasan = Object.fromEntries(json.data.merchants.map((m) => [m.id, m]));
  assert.deepStrictEqual(Object.keys(ringkasan).sort(), ['default', 'demoshop', 'dormant']);
  assert.strictEqual(ringkasan.default.active, true);
  assert.strictEqual(ringkasan.demoshop.active, true);
  assert.strictEqual(ringkasan.dormant.active, false);
  assert.strictEqual(ringkasan.default.session, 'inactive'); // tanpa kredensial GoBiz di test
  for (const rahasia of [
    GP_ROW.api_key, GP_ROW.api_secret, GP_ROW.callback_secret,
    SH_ROW.api_key, SH_ROW.api_secret, SH_ROW.callback_secret,
    'gob_env_fallback_key', 'env-fallback-secret', 'env-fallback-cbsecret',
  ]) {
    assert.ok(!teks.includes(rahasia), 'health membocorkan: ' + rahasia);
  }
});

// =========================================================================
// BAGIAN v3 — PAYLOAD QRIS PER-MERCHANT
// =========================================================================

// Payload statis KEDUA (sintetis): outlet berbeda ('DEMO-FOUNDATION'), template
// merchant berbeda, dan membawa tag 54 warisan yang harus DIGANTI.
const merchantTemplateB =
  tlv('00', 'ID.CO.QRIS.WWW') + tlv('01', '936009876543210987') +
  tlv('02', 'UMI') + tlv('03', 'ID1029998887776');
const staticBodyB =
  tlv('00', '01') + tlv('01', '11') + tlv('26', merchantTemplateB) +
  tlv('52', '5999') + tlv('53', '360') + tlv('54', '5000') +
  tlv('58', 'ID') + tlv('59', 'DEMO-FOUNDATION') + tlv('60', 'JAKARTA') + '6304';
const staticPayloadB = staticBodyB + crcHex(staticBodyB);

const DH_ROW = {
  id: 'demofoundation', name: 'DemoFoundation', domain: 'demofoundation.example.com',
  api_key: 'gob_row_demofoundation_key', api_secret: 'row-demofoundation-secret',
  callback_secret: 'row-demofoundation-cbsecret',
  callback_url: 'https://demofoundation.example/api/kerisqu/webhook', active: 1,
  qris_payload: staticPayloadB, created_at: 4,
};

function makeEnv3(seed = {}) {
  const { DB, state } = createFakeDb({
    merchants: [GP_ROW, SH_ROW, DH_ROW],
    ...seed,
  });
  return {
    env: {
      DB,
      BRIDGE_API_KEY: 'gob_env_fallback_key',
      BRIDGE_API_SECRET: 'env-fallback-secret',
      BRIDGE_CALLBACK_SECRET: 'env-fallback-cbsecret',
      CALLBACK_URL: 'https://env-fallback.example/callback',
      GOBIZ_EMAIL: '', GOBIZ_PASSWORD: '',
      STATIC_QRIS_PAYLOAD: staticPayload, // env = outlet 'WINZ DIGITAL'
      GOBIZ_APP_VERSION: 'platform-vTest',
    },
    state,
  };
}

const byTagOf = (payload) =>
  Object.fromEntries(parseEmvTlv(payload).map((p) => [p.tag, p.value]));

// ------------------------------------------------- (m) EMV payload kedua
await ok('v3 EMV: payload statis kedua — tag 54 warisan diganti, nama outlet utuh, CRC valid', () => {
  const dyn = buildDynamicQrPayload(staticPayloadB, 123456);
  const byTag = byTagOf(dyn);
  assert.strictEqual(byTag['54'], '123456');
  assert.strictEqual(byTag['59'], 'DEMO-FOUNDATION');
  assert.strictEqual(byTag['01'], '12');
  assert.strictEqual(byTag['53'], '360');
  assert.strictEqual(crcHex(dyn.slice(0, -4)), dyn.slice(-4));
});

// -------------------------------------- (n) pemilihan payload per-merchant
await ok('v3 konteks: payload baris menang; NULL/string kosong → fallback env', async () => {
  const { env } = makeEnv3();
  const dh = await resolveMerchantById(env, 'demofoundation');
  assert.strictEqual(dh.qrisPayload, staticPayloadB);
  const sh = await resolveMerchantById(env, 'demoshop');
  assert.strictEqual(sh.qrisPayload, staticPayload); // baris tanpa payload → env
  const gp = await resolveMerchantById(env, 'default');
  assert.strictEqual(gp.qrisPayload, staticPayload);
});

await ok('v3 invoice: QR memakai payload merchant pemilik; merchant NULL-payload memakai env', async () => {
  const { env } = makeEnv3();
  // demofoundation: payload baris (nama outlet DEMO-FOUNDATION)
  let res = await worker.fetch(
    signedRequest({ merchant: DH_ROW, path: '/api/v1/external/invoices', body: '{"amount":25000,"label":"DONASI-1"}' }),
    env, CTX
  );
  assert.strictEqual(res.status, 201);
  let json = await res.json();
  let byTag = byTagOf(json.data.qr_payload);
  assert.strictEqual(byTag['59'], 'DEMO-FOUNDATION');
  assert.strictEqual(byTag['54'], String(json.data.amount));
  assert.strictEqual(byTag['01'], '12');
  assert.strictEqual(crcHex(json.data.qr_payload.slice(0, -4)), json.data.qr_payload.slice(-4));

  // demoshop: qris_payload NULL → payload env (nama outlet WINZ DIGITAL)
  res = await worker.fetch(
    signedRequest({ merchant: SH_ROW, path: '/api/v1/external/invoices', body: '{"amount":25000,"label":"SHOVE-1"}' }),
    env, CTX
  );
  assert.strictEqual(res.status, 201);
  json = await res.json();
  byTag = byTagOf(json.data.qr_payload);
  assert.strictEqual(byTag['59'], 'WINZ DIGITAL');
  assert.strictEqual(byTag['54'], String(json.data.amount));
  assert.strictEqual(crcHex(json.data.qr_payload.slice(0, -4)), json.data.qr_payload.slice(-4));
});

// --------------------------- (o) keunikan global lintas payload yang beda
await ok('v3 invoice: total pending tetap unik GLOBAL walau payload merchant berbeda', async () => {
  const { env, state } = makeEnv3({
    invoices: [
      // demofoundation (payload B) memegang total 25030 untuk base 25000
      { id: 'inv-dh-pending', merchant_id: 'demofoundation', label: 'D-P', base_amount: 25000, unique_code: 30, total: 25030, status: 'pending', created_at: Date.now(), expires_at: Date.now() + 900000, paid_at: null, matched_tx_id: null, created_via: 'api' },
    ],
  });
  const acakAsli = Math.random;
  const paksa = (codes) => {
    const urutan = codes.map((c) => (c - 10 + 0.5) / 90);
    let idx = 0;
    Math.random = () => urutan[Math.min(idx++, urutan.length - 1)];
  };
  try {
    // demoshop (payload env) mencoba base yang sama: kandidat 30 tabrakan → 31
    paksa([30, 31]);
    let res = await worker.fetch(
      signedRequest({ merchant: SH_ROW, path: '/api/v1/external/invoices', body: '{"amount":25000,"label":"SHOVE-X"}' }),
      env, CTX
    );
    assert.strictEqual(res.status, 201);
    let json = await res.json();
    assert.strictEqual(json.data.unique_code, 31);
    assert.strictEqual(byTagOf(json.data.qr_payload)['59'], 'WINZ DIGITAL');

    // demofoundation: kandidat 31 kini juga terpakai (oleh demoshop) → 32,
    // dan QR-nya tetap payload outletnya sendiri.
    paksa([31, 32]);
    res = await worker.fetch(
      signedRequest({ merchant: DH_ROW, path: '/api/v1/external/invoices', body: '{"amount":25000,"label":"DONASI-X"}' }),
      env, CTX
    );
    assert.strictEqual(res.status, 201);
    json = await res.json();
    assert.strictEqual(json.data.unique_code, 32);
    assert.strictEqual(byTagOf(json.data.qr_payload)['59'], 'DEMO-FOUNDATION');
  } finally {
    Math.random = acakAsli;
  }
  const totals = state.invoices.filter((i) => i.status === 'pending').map((i) => i.total);
  assert.strictEqual(new Set(totals).size, totals.length);
});

console.log(`\nSEMUA ${lolos} TEST LULUS (9 v1 + 7 v2 + ${lolos - 16} v3; jaringan hanya fetch-stub).`);
