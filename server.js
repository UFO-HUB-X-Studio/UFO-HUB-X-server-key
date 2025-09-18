// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ISSUED_FILE = path.join(__dirname, "issued.json"); // เก็บคีย์

const EXPIRES_DEFAULT = 48 * 3600; // 48 ชั่วโมง
const KEY_PREFIX = "UFO-";
const KEY_SUFFIX = "-48H";
const RAND_LEN = 8;
const MAX_GEN_ATTEMPTS = 8;

const app = express();
app.use(cors());
app.use(express.json());

// ---------- helpers ----------
function safeParseJSON(str, fallback) {
  try {
    if (!str || !str.trim()) return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
function loadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return safeParseJSON(raw, fallback);
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

// โครงสร้าง: issued = { "<KEY>": { usedBy:"<uid>", expiresAt:<unix>, reusable:false } }
const issued = loadJSON(ISSUED_FILE, {});
if (!fs.existsSync(ISSUED_FILE)) saveJSON(ISSUED_FILE, issued); // ensure file exists

// สุ่มตัวอักษร A-Z0-9
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
    const k = KEY_PREFIX + randPart(RAND_LEN - 2) + ("Z" + i) + KEY_SUFFIX;
    if (!issued[k]) return k;
    i++;
  }
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});
// health check path สำหรับ Render
app.get("/healthz", (req, res) => res.status(200).send("ok"));

/** แจกคีย์ใหม่ (ถ้า uid มีคีย์ที่ยังไม่หมดอายุ จะคืนคีย์เดิม) */
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "").trim() || null;
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
        note: "existing_active_for_uid",
      });
    }
  }

  const key = generateUniqueKey();
  const exp = now + EXPIRES_DEFAULT;
  issued[key] = { usedBy: uid || null, expiresAt: exp, reusable: false };
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok: true, key, ttl: EXPIRES_DEFAULT, expires_at: exp, reusable: false });
});

/** ขยายอายุคีย์ +48H (UI ของคุณกดปุ่มนี้) */
app.get("/extend", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;
  if (!key) return res.status(400).json({ ok: false, reason: "no_key" });

  const meta = issued[key];
  if (!meta) return res.json({ ok: false, reason: "not_found" });

  // อนุญาตต่ออายุเมื่อคีย์นี้เป็นของ uid นี้ (หรือยังไม่ผูกใคร)
  if (uid && meta.usedBy && meta.usedBy !== uid) {
    return res.json({ ok: false, reason: "owned_by_other" });
  }
  const now = Math.floor(Date.now() / 1000);
  meta.usedBy = uid || meta.usedBy || null;
  meta.expiresAt = Math.max(meta.expiresAt || now, now) + EXPIRES_DEFAULT;
  saveJSON(ISSUED_FILE, issued);
  res.json({ ok: true, expires_at: meta.expiresAt });
});

/** ตรวจคีย์ */
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;
  if (!key) return res.status(400).json({ ok:false, valid:false, reason:"no_key" });

  const meta = issued[key];
  const now = Math.floor(Date.now() / 1000);
  if (!meta) return res.json({ ok:true, valid:false, reason:"not_found" });

  if (meta.reusable) {
    meta.expiresAt = now + EXPIRES_DEFAULT;
    if (uid) meta.usedBy = uid;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:true, expires_at: meta.expiresAt, meta:{bound_uid:meta.usedBy}});
  }

  if (now > (meta.expiresAt || 0)) {
    meta.usedBy = uid || meta.usedBy || null;
    meta.expiresAt = now + EXPIRES_DEFAULT;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, reason:"reissued_after_expire", meta:{bound_uid:meta.usedBy}});
  }

  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok:true, valid:false, reason:"already_used_by_someone", expires_at: meta.expiresAt });
  }

  return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, meta:{bound_uid:meta.usedBy || uid}});
});

// debug
app.get("/issued", (req, res) => {
  res.json({ ok:true, count:Object.keys(issued).length, issued });
});

// กันโปรเซสตายเงียบ ๆ
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));

app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
