// server.js
// UFO KEY SERVER (ultra-simple, 100% ready)
// Endpoints:
//   GET /health
//   GET /getkey?uid=&place=
//   GET /verify?key=&uid=&place=&format=json
//
// วิธีใช้:
//   1) npm init -y && npm i express cors
//   2) สร้าง config.json (ดูไฟล์ที่ให้ไป)
//   3) node server.js

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- load config.json (ต้องมีไฟล์นี้) ----
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('[FATAL] config.json not found next to server.js');
  process.exit(1);
}
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
  console.error('[FATAL] config.json invalid JSON:', e.message);
  process.exit(1);
}

// ---- in-memory state (ง่ายสุด) ----
// โครงสร้าง: state[keyUpper] = { reusable, ttl, bound_uid (optional), claimed_at, expires_at }
const state = Object.create(null);
const now = () => Math.floor(Date.now() / 1000);
const normalizeKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9\-]/g, '');

function seedFromConfig() {
  for (const item of (cfg.keys || [])) {
    const key = normalizeKey(item.key);
    if (!key) continue;
    state[key] = state[key] || {};
    state[key].reusable  = !!item.reusable;
    state[key].ttl       = Number.isFinite(item.ttl) ? item.ttl : Number(cfg.expires_default || 172800);
    // อย่าตั้ง expires_at ตั้งแต่เริ่ม—จะเริ่มนับเมื่อ “verify ผ่านครั้งแรก” (สำหรับ non-reusable)
    // สำหรับ reusable จะคืนอายุโดยอิง ttl ทุกครั้ง
  }
}
seedFromConfig();

// ---- helpers ----
function ensureKeyInState(key) {
  const K = normalizeKey(key);
  if (!K) return null;
  if (!state[K]) {
    // ถ้า key ไม่อยู่ใน config ก็ถือว่าไม่รู้จัก
    return null;
  }
  // ทำให้มีค่า ttl เสมอ
  state[K].ttl = Number.isFinite(state[K].ttl) ? state[K].ttl : Number(cfg.expires_default || 172800);
  return { K, entry: state[K] };
}

function isExpired(ts) { return Number.isFinite(ts) && ts > 0 && now() >= ts; }

// ---- middlewares ----
app.use(cors());
app.get('/health', (_, res) => res.json({ ok: true, ts: now() }));

// ---- GET KEY (เรียบง่าย, โชว์วิธีใช้ + key ที่ประกาศใน config) ----
app.get('/getkey', (req, res) => {
  const uid   = String(req.query.uid || '');
  const place = String(req.query.place || '');
  const list  = Object.keys(state).map(k => ({
    key: k,
    reusable: !!state[k].reusable,
    ttl: state[k].ttl
  }));
  return res.json({
    ok: true,
    info: "Use /verify?key=YOUR_KEY&uid=YOUR_UID (place is optional and ignored).",
    uid, place,
    keys: list
  });
});

// ---- VERIFY ----
app.get('/verify', (req, res) => {
  const wantJson = String(req.query.format || '').toLowerCase() === 'json';
  const uid   = String(req.query.uid || '');
  const place = String(req.query.place || ''); // ไม่ได้ใช้จริง แต่อยู่เพื่อ兼容
  const keyIn = String(req.query.key || '');
  const NK = normalizeKey(keyIn);

  if (!NK || !uid) {
    const bad = { ok: true, valid: false, reason: 'missing_params', uid, place };
    return wantJson ? res.json(bad) : res.type('text/plain').send('INVALID');
  }

  const pack = ensureKeyInState(NK);
  if (!pack) {
    const bad = { ok: true, valid: false, reason: 'unknown_key', uid, place };
    return wantJson ? res.json(bad) : res.type('text/plain').send('INVALID');
  }
  const { entry } = pack;

  // กรณี reusable (ใช้ซ้ำได้, ไม่ผูก uid, ไม่จำเป็นต้อง claim)
  if (entry.reusable) {
    const exp = now() + Number(entry.ttl || cfg.expires_default || 172800);
    const good = { ok: true, valid: true, expires_at: exp, reusable: true, uid, place };
    return wantJson ? res.json(good) : res.type('text/plain').send('VALID');
  }

  // กรณี non-reusable (แจกครั้งเดียว, ผูก uid ที่กดผ่านครั้งแรก)
  // ถ้ายังไม่เคย claim → ผูกให้ uid นี้ และตั้ง expires_at
  if (!entry.bound_uid) {
    entry.bound_uid  = uid;
    entry.claimed_at = now();
    entry.expires_at = entry.claimed_at + Number(entry.ttl || cfg.expires_default || 172800);
  }

  // ถ้าเคย claim แล้ว
  if (entry.bound_uid !== uid) {
    const bad = { ok: true, valid: false, reason: 'claimed_by_other', uid, place };
    return wantJson ? res.json(bad) : res.type('text/plain').send('INVALID');
  }

  // uid ตรงแล้ว → เช็คหมดอายุหรือยัง
  if (isExpired(entry.expires_at)) {
    const bad = { ok: true, valid: false, reason: 'expired', uid, place };
    return wantJson ? res.json(bad) : res.type('text/plain').send('INVALID');
  }

  const good = { ok: true, valid: true, expires_at: entry.expires_at, reusable: false, uid, place };
  return wantJson ? res.json(good) : res.type('text/plain').send('VALID');
});

// ---- start ----
app.listen(PORT, () => {
  console.log(`[UFO-KEY] server started on :${PORT}`);
});
