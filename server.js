// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ISSUED_FILE = path.join(__dirname, "issued.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const EXPIRES_DEFAULT = 48 * 3600; // 48 ชั่วโมง
const KEY_PREFIX = "UFO-";
const KEY_SUFFIX = "-48H";
const RAND_LEN = 8;
const MAX_GEN_ATTEMPTS = 8;

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// ensure issued.json
if (!fs.existsSync(ISSUED_FILE)) {
  fs.writeFileSync(ISSUED_FILE, JSON.stringify({}, null, 2));
}
function loadIssued() {
  try {
    return JSON.parse(fs.readFileSync(ISSUED_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function saveIssued(data) {
  fs.writeFileSync(ISSUED_FILE, JSON.stringify(data, null, 2), "utf8");
}
let issued = loadIssued();

// key util
function randPart(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = crypto.randomBytes(len);
  return Array.from(buf).map(b => chars[b % chars.length]).join("").slice(0, len);
}
function makeKey() {
  return KEY_PREFIX + randPart(RAND_LEN) + KEY_SUFFIX;
}
function generateUniqueKey() {
  for (let i = 0; i < MAX_GEN_ATTEMPTS; i++) {
    const k = makeKey();
    if (!issued[k]) return k;
  }
  return makeKey() + Date.now();
}
function isExpired(meta) {
  return !meta || !meta.expiresAt || Date.now() / 1000 > meta.expiresAt;
}

// -------- UI static --------
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// -------- API --------

// แจกคีย์ใหม่
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;
  const now = Math.floor(Date.now() / 1000);

  // ถ้ามี key เดิมที่ยังไม่หมดอายุ → คืนอันเดิม
  for (const k in issued) {
    const m = issued[k];
    if (m.usedBy === uid && !isExpired(m)) {
      return res.json({
        ok: true,
        key: k,
        expires_at: m.expiresAt,
        ttl: m.expiresAt - now,
        note: "existing_key"
      });
    }
  }

  // สร้างใหม่
  const key = generateUniqueKey();
  const exp = now + EXPIRES_DEFAULT;
  issued[key] = { usedBy: uid, place, expiresAt: exp };
  saveIssued(issued);

  res.json({ ok: true, key, expires_at: exp, ttl: EXPIRES_DEFAULT });
});

// ตรวจสอบคีย์
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;

  if (!key) return res.json({ ok: false, valid: false, reason: "no_key" });

  const meta = issued[key];
  const now = Math.floor(Date.now() / 1000);

  if (!meta) {
    return res.json({ ok: true, valid: false, reason: "not_found" });
  }

  if (isExpired(meta)) {
    return res.json({ ok: true, valid: false, reason: "expired", expires_at: meta.expiresAt });
  }

  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok: true, valid: false, reason: "already_used_by_someone", expires_at: meta.expiresAt });
  }

  return res.json({ ok: true, valid: true, expires_at: meta.expiresAt });
});

// ต่ออายุคีย์
app.get("/extend", (req, res) => {
  const key = String(req.query.key || "").trim();
  const meta = issued[key];
  if (!meta) return res.json({ ok: false, reason: "not_found" });

  const now = Math.floor(Date.now() / 1000);
  const base = now > meta.expiresAt ? now : meta.expiresAt;
  meta.expiresAt = base + EXPIRES_DEFAULT;
  saveIssued(issued);

  res.json({ ok: true, key, expires_at: meta.expiresAt });
});

// debug (ไม่ควรเปิด public)
app.get("/issued", (req, res) => {
  res.json(issued);
});

// -------- error handler --------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found" });
});
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

// -------- start --------
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
