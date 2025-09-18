// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// ====== PATHS ======
const DATA_DIR    = path.join(__dirname);
const ISSUED_FILE = path.join(DATA_DIR, "issued.json"); // เก็บคีย์ที่ออกไปแล้ว
const PUBLIC_DIR  = path.join(__dirname, "public");     // หน้าเว็บ UI

// ====== CONFIG (48 ชั่วโมง) ======
const EXPIRES_DEFAULT = 48 * 3600; // วินาที
const KEY_PREFIX = "UFO-";
const KEY_SUFFIX = "-48H";
const RAND_LEN   = 8;   // ความยาวสุ่มตรงกลาง
const MAX_GEN_ATTEMPTS = 8;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR)); // เสิร์ฟหน้าเว็บที่ /

// ---------- helpers ----------
function ensureFile(p, fallback) {
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(fallback ?? {}, null, 2), "utf8");
  } catch (e) { console.error("ensureFile error", p, e); }
}
function loadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return (raw && JSON.parse(raw)) || fallback;
  } catch (e) {
    console.error("loadJSON error", p, e);
    return fallback;
  }
}
function saveJSON(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8"); }
  catch (e) { console.error("saveJSON error", p, e); }
}

// โครงสร้าง: issued = { "<KEY>": { usedBy:"<uid>", expiresAt:<unix>, reusable:false } }
ensureFile(ISSUED_FILE, {});
const issued = loadJSON(ISSUED_FILE, {});

// สุ่มตัวอักษร A-Z0-9
function randPart(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}
function makeKey() { return KEY_PREFIX + randPart(RAND_LEN) + KEY_SUFFIX; }

function isExpired(meta) {
  if (!meta || !meta.expiresAt) return true;
  return Math.floor(Date.now() / 1000) > meta.expiresAt;
}
function findActiveKeyForUid(uid) {
  for (const k of Object.keys(issued)) {
    const m = issued[k];
    if (m.usedBy && String(m.usedBy) === String(uid) && !isExpired(m)) {
      return { key: k, meta: m };
    }
  }
  return null;
}
function generateUniqueKey() {
  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const k = makeKey();
    if (!issued[k]) return k;
  }
  // fallback (ไม่น่าถึง)
  let i = 0;
  while (true) {
    const k = KEY_PREFIX + randPart(RAND_LEN - 2) + ("Z" + i) + KEY_SUFFIX;
    if (!issued[k]) return k;
    i++;
  }
}

// ---------- APIs ----------

// Health (ไว้เช็คสถานะ)
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});

// แจกคีย์: /getkey?uid=...&place=...
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;

  const now = Math.floor(Date.now() / 1000);

  // ถ้ามีคีย์ที่ยัง Active สำหรับ uid นี้อยู่แล้ว -> คืนคีย์เดิม
  if (uid) {
    const found = findActiveKeyForUid(uid);
    if (found) {
      return res.json({
        ok: true,
        key: found.key,
        ttl: Math.max(0, found.meta.expiresAt - now),
        expires_at: found.meta.expiresAt,
        reusable: !!found.meta.reusable,
        note: "existing_active_for_uid"
      });
    }
  }

  // สร้างคีย์ใหม่
  const key = generateUniqueKey();
  const exp = now + EXPIRES_DEFAULT;

  issued[key] = { usedBy: uid || null, expiresAt: exp, reusable: false };
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok: true, key, ttl: EXPIRES_DEFAULT, expires_at: exp, reusable: false, place });
});

// ตรวจคีย์: /verify?key=...&uid=...&place=...
app.get("/verify", (req, res) => {
  const key   = String(req.query.key || "").trim();
  const uid   = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;

  if (!key) return res.status(400).json({ ok:false, valid:false, reason:"no_key" });

  const meta = issued[key];
  const now  = Math.floor(Date.now() / 1000);

  if (!meta) return res.json({ ok:true, valid:false, reason:"not_found" });

  if (meta.reusable) {
    // คีย์แบบ reusable (ถ้าอนาคตอยากมี) ต่ออายุเสมอ
    meta.expiresAt = now + EXPIRES_DEFAULT;
    if (uid) meta.usedBy = uid;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:true, expires_at: meta.expiresAt, meta:{bound_uid:meta.usedBy, place} });
  }

  // หมดอายุแล้ว -> อนุญาต re-issue
  if (now > (meta.expiresAt || 0)) {
    meta.usedBy   = uid || meta.usedBy || null;
    meta.expiresAt= now + EXPIRES_DEFAULT;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, reason:"reissued_after_expire", meta:{bound_uid:meta.usedBy, place} });
  }

  // ยัง active อยู่
  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok:true, valid:false, reason:"already_used_by_someone", expires_at: meta.expiresAt });
  }

  return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, meta:{bound_uid:meta.usedBy || uid, place} });
});

// ต่ออายุ 48 ชั่วโมง/ครั้ง: /extend?key=...&uid=...
app.get("/extend", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;
  if (!key) return res.status(400).json({ ok:false, reason:"no_key" });

  const meta = issued[key];
  if (!meta) return res.json({ ok:false, reason:"not_found" });

  const now = Math.floor(Date.now()/1000);

  // ผูก UID ให้ตรงกัน
  if (uid && meta.usedBy && meta.usedBy !== uid) {
    return res.json({ ok:false, reason:"bound_to_another_uid" });
  }

  // บังคับต่ออายุ +48 ชั่วโมง เสมอ
  const add = 48 * 3600;
  meta.expiresAt = Math.max(meta.expiresAt || now, now) + add;
  if (uid) meta.usedBy = uid;
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok:true, expires_at: meta.expiresAt, added_seconds: add });
});

// DEBUG: อย่าเปิดในโปรดักชันจริง
app.get("/issued", (req, res) => {
  res.json({ ok:true, count:Object.keys(issued).length, issued });
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
