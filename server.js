// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ISSUED_FILE = path.join(__dirname, "issued.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ===== CONFIG =====
const EXPIRES_DEFAULT = 48 * 3600; // 48 ชั่วโมง
const KEY_PREFIX = "UFO-";
const KEY_SUFFIX = "-48H";
const RAND_LEN = 8;
const MAX_GEN_ATTEMPTS = 8;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR)); // ให้เสิร์ฟไฟล์ใน /public

// -------- util --------
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
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveJSON error", p, e);
  }
}

// issued: { "<KEY>": { usedBy:"<uid>", expiresAt:<unix>, reusable:false } }
const issued = loadJSON(ISSUED_FILE, {});

// สุ่ม A-Z0-9
function randPart(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}
function makeKey() {
  return KEY_PREFIX + randPart(RAND_LEN) + KEY_SUFFIX;
}
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
  let i = 0;
  while (true) {
    const k = KEY_PREFIX + randPart(RAND_LEN - 2) + "Z" + i + KEY_SUFFIX;
    if (!issued[k]) return k;
    i++;
  }
}

// -------- routes: UI --------
// หน้าสถานะ (เก็บไว้)
app.get("/status", (req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});
// ให้ root แสดง UI (เพิ่ม — ไม่ลบของเดิม)
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// -------- routes: API --------
// แจกคีย์ใหม่ (กำหนดให้ 1 uid มีได้ 1 คีย์ที่ยังไม่หมดอายุ)
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;
  const now = Math.floor(Date.now() / 1000);

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

  const key = generateUniqueKey();
  const exp = now + EXPIRES_DEFAULT;
  issued[key] = { usedBy: uid || null, expiresAt: exp, reusable: false };
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok: true, key, ttl: EXPIRES_DEFAULT, expires_at: exp, reusable: false });
});

// ต่ออายุคีย์เดิม +48H (ใช้กับปุ่ม ⏳ +48H)
app.get("/extend", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;
  if (!key) return res.status(400).json({ ok: false, reason: "no_key" });

  const meta = issued[key];
  const now = Math.floor(Date.now() / 1000);
  if (!meta) return res.json({ ok: false, reason: "not_found" });

  // ถ้าคีย์นี้ผูกกับ uid แล้ว และ uid ไม่ตรง → ไม่อนุญาต
  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok: false, reason: "bound_to_another_uid", expires_at: meta.expiresAt });
  }

  // ถ้าหมดอายุ ให้เริ่มนับใหม่ 48H จากตอนนี้
  const base = now > (meta.expiresAt || 0) ? now : meta.expiresAt;
  meta.expiresAt = base + EXPIRES_DEFAULT;
  if (uid) meta.usedBy = uid;
  saveJSON(ISSUED_FILE, issued);
  res.json({ ok: true, key, expires_at: meta.expiresAt });
});

// ตรวจคีย์
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;

  if (!key) return res.status(400).json({ ok: false, valid: false, reason: "no_key" });

  const meta = issued[key];
  const now = Math.floor(Date.now() / 1000);
  if (!meta) return res.json({ ok: true, valid: false, reason: "not_found" });

  if (meta.reusable) {
    meta.expiresAt = now + EXPIRES_DEFAULT;
    if (uid) meta.usedBy = uid;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok: true, valid: true, reusable: true, expires_at: meta.expiresAt, meta: { bound_uid: meta.usedBy } });
  }

  if (now > (meta.expiresAt || 0)) {
    meta.usedBy = uid || meta.usedBy || null;
    meta.expiresAt = now + EXPIRES_DEFAULT;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok: true, valid: true, reusable: false, expires_at: meta.expiresAt, reason: "reissued_after_expire", meta: { bound_uid: meta.usedBy } });
  }

  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok: true, valid: false, reason: "already_used_by_someone", expires_at: meta.expiresAt });
  }

  return res.json({ ok: true, valid: true, reusable: false, expires_at: meta.expiresAt, meta: { bound_uid: meta.usedBy || uid } });
});

// ดีบัก: ดูรายการคีย์ (อย่าเปิดสาธารณะในโปรดักชัน)
app.get("/issued", (req, res) => {
  res.json({ ok: true, count: Object.keys(issued).length, issued });
});

app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
