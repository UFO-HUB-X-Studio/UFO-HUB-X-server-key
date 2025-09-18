// server.js  (ESM)
// - Serve /public (root -> index.html)
// - /status           : ping
// - /getkey?uid=&place= : แจกคีย์ใหม่ (1 uid มีได้ 1 คีย์ที่ยังไม่หมดอายุ)
// - /verify?key=&uid=&place= : ตรวจคีย์ + ต่ออายุแบบ reusable ได้ (ถ้ามาร์กไว้)
// - /extend?key=&uid= : ต่ออายุ +48H
// - เก็บสถานะคีย์ในไฟล์ issued.json (persist ระหว่างรีสตาร์ต)

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ===== CONFIG =====
const PORT         = process.env.PORT || 3000;
const PUBLIC_DIR   = path.join(__dirname, "public");
const ISSUED_FILE  = path.join(__dirname, "issued.json");

const EXPIRES_DEFAULT = 48 * 3600;          // 48 ชั่วโมง (วินาที)
const KEY_PREFIX      = "UFO-";
const KEY_SUFFIX      = "-48H";
const RAND_LEN        = 8;                   // ความยาวส่วนกลาง (A-Z0-9)
const MAX_GEN_TRIES   = 8;

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(PUBLIC_DIR));

// ---------- Small utils ----------
function ensureIssuedFile() {
  try {
    if (!fs.existsSync(ISSUED_FILE)) {
      fs.writeFileSync(ISSUED_FILE, JSON.stringify({}, null, 2), "utf8");
      console.log("[INIT] created issued.json");
    }
  } catch (e) {
    console.error("[INIT] cannot create issued.json", e);
  }
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
  try {
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error("saveJSON error", p, e);
  }
}
ensureIssuedFile();

// issued: { "<KEY>": { usedBy:"<uid>", expiresAt:<unix>, reusable:false, place?:string } }
const issued = loadJSON(ISSUED_FILE, {});

// ---------- Key helpers ----------
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
  if (!uid) return null;
  for (const k of Object.keys(issued)) {
    const m = issued[k];
    if (m.usedBy && String(m.usedBy) === String(uid) && !isExpired(m)) {
      return { key: k, meta: m };
    }
  }
  return null;
}
function generateUniqueKey() {
  for (let i = 0; i < MAX_GEN_TRIES; i++) {
    const k = makeKey();
    if (!issued[k]) return k;
  }
  // fallback เผื่อชนรัวๆ (แทบจะไม่เกิด)
  let i = 0;
  while (true) { // eslint-disable-line no-constant-condition
    const k = KEY_PREFIX + randPart(Math.max(2, RAND_LEN - 2)) + "Z" + i + KEY_SUFFIX;
    if (!issued[k]) return k;
    i++;
  }
}

// ---------- UI routes ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
app.get("/status", (_req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});

// ---------- API routes ----------
/**
 * แจกคีย์ใหม่ให้ uid (มีได้ทีละ 1 คีย์ที่ยังไม่หมดอายุ)
 * GET /getkey?uid=&place=
 */
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;
  const now   = Math.floor(Date.now() / 1000);

  // ถ้ามี active key ของ uid อยู่แล้ว → คืนอันเดิม
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
        meta: { bound_uid: found.meta.usedBy, place }
      });
    }
  }

  // ออกคีย์ใหม่
  const key = generateUniqueKey();
  const exp = now + EXPIRES_DEFAULT;
  issued[key] = { usedBy: uid, expiresAt: exp, reusable: false, place };
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok: true, key, ttl: EXPIRES_DEFAULT, expires_at: exp, reusable: false, meta: { bound_uid: uid, place } });
});

/**
 * ตรวจคีย์
 * GET /verify?key=&uid=&place=
 * ถ้าคีย์ reusable จะต่ออายุทุกครั้งที่ verify
 * ถ้าคีย์หมดอายุ จะ reissue เวลาใหม่ (คง key เดิม) และ bind uid ถ้ามีให้มา
 */
app.get("/verify", (req, res) => {
  const key   = String(req.query.key || "").trim();
  const uid   = String(req.query.uid || "").trim() || null;

  if (!key) return res.status(400).json({ ok: false, valid: false, reason: "no_key" });

  const meta = issued[key];
  const now  = Math.floor(Date.now() / 1000);
  if (!meta) return res.json({ ok: true, valid: false, reason: "not_found" });

  // คีย์ reusable ต่ออายุทุกครั้ง
  if (meta.reusable) {
    meta.expiresAt = now + EXPIRES_DEFAULT;
    if (uid) meta.usedBy = uid;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok: true, valid: true, reusable: true, expires_at: meta.expiresAt, meta: { bound_uid: meta.usedBy } });
  }

  // ถ้าหมดอายุ → ต่ออายุใหม่ 48H และ bind uid (ถ้าส่งมา)
  if (now > (meta.expiresAt || 0)) {
    meta.usedBy   = uid || meta.usedBy || null;
    meta.expiresAt = now + EXPIRES_DEFAULT;
    saveJSON(ISSUED_FILE, issued);
    return res.json({
      ok: true, valid: true, reusable: false, expires_at: meta.expiresAt,
      reason: "reissued_after_expire", meta: { bound_uid: meta.usedBy }
    });
  }

  // ยังไม่หมดอายุ → ถ้ามี owner อยู่แล้ว แต่ uid ใหม่ไม่ตรง → ไม่ผ่าน
  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok: true, valid: false, reason: "already_used_by_someone", expires_at: meta.expiresAt });
  }

  // ผ่าน
  return res.json({ ok: true, valid: true, reusable: false, expires_at: meta.expiresAt, meta: { bound_uid: meta.usedBy || uid } });
});

/**
 * ต่ออายุคีย์เดิม +48H
 * GET /extend?key=&uid=
 */
app.get("/extend", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;
  if (!key) return res.status(400).json({ ok: false, reason: "no_key" });

  const meta = issued[key];
  if (!meta) return res.json({ ok: false, reason: "not_found" });

  // ป้องกัน extend คนละ uid
  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok: false, reason: "bound_to_another_uid", expires_at: meta.expiresAt });
  }

  const now  = Math.floor(Date.now() / 1000);
  const base = now > (meta.expiresAt || 0) ? now : meta.expiresAt;
  meta.expiresAt = base + EXPIRES_DEFAULT;
  if (uid) meta.usedBy = uid;
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok: true, key, expires_at: meta.expiresAt });
});

// (debug) ดูรายการคีย์ทั้งหมด – ห้ามเปิด public ในโปรดักชัน
app.get("/issued", (_req, res) => {
  res.json({ ok: true, count: Object.keys(issued).length, issued });
});

// -------- 404 -> ส่ง index.html (รองรับ SPA) หรือคืน JSON ------------
app.use((req, res, next) => {
  if (req.method === "GET" && req.headers.accept && req.headers.accept.includes("text/html")) {
    try { return res.sendFile(path.join(PUBLIC_DIR, "index.html")); } catch (e) {}
  }
  res.status(404).json({ ok: false, error: "not_found" });
});

// -------- Error handler ------------
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

// -------- Start ------------
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
