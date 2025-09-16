// server.js — UFO HUB X Key API (Full)
// Features:
// - Auto init/fix data file (no more "Unexpected end of JSON")
// - POST /api/getkey         -> ออกคีย์จริง (1 คน 1 key, อายุ 48 ชม.)
// - GET  /api/check/:key     -> ตรวจคีย์ + เวลาที่เหลือ
// - POST /api/extend/:key    -> ยืดเวลา (สูงสุด +5 ชม./ครั้ง)
// - GET  /api/health         -> health check
// - Static /public           -> เว็บเพจของนาย
//
// Env (optional):
//   PORT=10000
//   API_TOKEN=your-secret   // ถ้าอยากล็อก POST /api/extend ให้ต้องใส่ token
//
// Data layout (data/keys.json):
// {
//   "keys": [{ key, clientId, createdAt, expiresAt, lastExtendAt? }],
//   "clients": { "<clientId>": { key, expiresAt } }
// }

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs-extra");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

// -------------------- Config --------------------
const PORT = process.env.PORT || 10000;
const API_TOKEN = process.env.API_TOKEN || ""; // ถ้าเว้นว่าง = ไม่บังคับ

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_PATH = path.join(DATA_DIR, "keys.json");

// อายุคีย์หลัก 48 ชั่วโมง
const KEY_TTL_HOURS = 48;
// เพิ่มเวลาได้ครั้งละสูงสุด 5 ชั่วโมง
const EXTEND_MAX_HOURS = 5;

// -------------------- Express --------------------
const app = express();
app.use(cors());
app.use(express.json());

// rate limit พื้นฐาน ป้องกันสแปม
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000, // 1 นาที
    max: 60,             // 60 req / นาที ต่อ IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// เสิร์ฟหน้าเว็บใน /public
app.use(express.static(path.join(process.cwd(), "public")));

// -------------------- DB Helper --------------------
const DEFAULT_DB = { keys: [], clients: {} };

async function ensureDB() {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(DATA_PATH))) {
    await fs.writeJSON(DATA_PATH, DEFAULT_DB, { spaces: 2 });
    return;
  }
  // ถ้ามีไฟล์อยู่แล้วแต่เนื้อหาว่าง/เสีย -> เขียนค่า default ให้
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    if (!raw.trim()) {
      await fs.writeJSON(DATA_PATH, DEFAULT_DB, { spaces: 2 });
    } else {
      JSON.parse(raw); // แค่ทดสอบ parse ว่าถูก
    }
  } catch {
    await fs.writeJSON(DATA_PATH, DEFAULT_DB, { spaces: 2 });
  }
}

async function loadDB() {
  try {
    const content = await fs.readFile(DATA_PATH, "utf-8");
    if (!content.trim()) return { ...DEFAULT_DB };
    return JSON.parse(content);
  } catch (e) {
    console.error("loadDB error:", e.message);
    return { ...DEFAULT_DB };
  }
}

async function saveDB(db) {
  await fs.writeJSON(DATA_PATH, db, { spaces: 2 });
}

// -------------------- Utils --------------------
function genKey() {
  // รูปแบบคีย์อ่านง่าย เช่น UHX-9CXT2R-J6K7M3
  const seg = () => crypto.randomBytes(4).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return `UHX-${seg()}-${seg()}`;
}

function now() {
  return Date.now();
}

function hoursFromNow(h) {
  return now() + h * 60 * 60 * 1000;
}

function remainingMs(exp) {
  return Math.max(0, exp - now());
}

// หา clientId: ใช้ header x-client-id; ถ้าไม่มีให้ hash IP เป็น id
function resolveClientId(req) {
  const cid = (req.headers["x-client-id"] || "").toString().trim();
  if (cid) return cid;
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString();
  return crypto.createHash("sha1").update(ip).digest("hex").slice(0, 16);
}

// -------------------- Middlewares --------------------
function requireTokenIfSet(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.headers["x-api-token"];
  if (token === API_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// -------------------- API --------------------

// health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "UFO HUB X KEY", time: new Date().toISOString() });
});

// ออกคีย์ (1 คน 1 key, อายุ 48 ชั่วโมง)
app.post("/api/getkey", async (req, res) => {
  await ensureDB();
  const db = await loadDB();

  const clientId = resolveClientId(req);

  // มีคีย์ที่ยังไม่หมดอายุอยู่แล้ว -> ส่งคีย์เดิมกลับ
  const existing = db.clients[clientId];
  if (existing) {
    const remain = remainingMs(existing.expiresAt);
    if (remain > 0) {
      return res.json({
        ok: true,
        key: existing.key,
        expiresAt: existing.expiresAt,
        remainingSeconds: Math.floor(remain / 1000),
        reused: true,
      });
    }
  }

  // ออกคีย์ใหม่
  const key = genKey();
  const createdAt = now();
  const expiresAt = hoursFromNow(KEY_TTL_HOURS);

  db.keys.push({ key, clientId, createdAt, expiresAt });
  db.clients[clientId] = { key, expiresAt };

  await saveDB(db);

  return res.json({
    ok: true,
    key,
    expiresAt,
    remainingSeconds: Math.floor((expiresAt - now()) / 1000),
    reused: false,
  });
});

// ตรวจคีย์
app.get("/api/check/:key", async (req, res) => {
  await ensureDB();
  const db = await loadDB();

  const k = req.params.key;
  const row = db.keys.find((x) => x.key === k);
  if (!row) {
    return res.status(404).json({ ok: false, valid: false, error: "Key not found" });
  }
  const remain = remainingMs(row.expiresAt);
  const valid = remain > 0;

  return res.json({
    ok: true,
    valid,
    key: k,
    expiresAt: row.expiresAt,
    remainingSeconds: Math.floor(remain / 1000),
  });
});

// ยืดเวลา (สูงสุด +5 ชั่วโมง/ครั้ง) — ป้องกันสแปมด้วย token (ถ้าตั้งไว้)
app.post("/api/extend/:key", requireTokenIfSet, async (req, res) => {
  await ensureDB();
  const db = await loadDB();

  const k = req.params.key;
  const row = db.keys.find((x) => x.key === k);
  if (!row) return res.status(404).json({ ok: false, error: "Key not found" });

  // ชั่วโมงที่จะเพิ่ม (default = 5, max = 5)
  let hours = Number(req.body?.hours || EXTEND_MAX_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) hours = EXTEND_MAX_HOURS;
  hours = Math.min(hours, EXTEND_MAX_HOURS);

  // ยืดจากค่า expiresAt เดิม (ไม่ต่อจากเวลาปัจจุบัน)
  row.expiresAt = row.expiresAt + hours * 60 * 60 * 1000;

  // sync clients
  const idxClient = row.clientId;
  if (db.clients[idxClient] && db.clients[idxClient].key === k) {
    db.clients[idxClient].expiresAt = row.expiresAt;
  }

  await saveDB(db);

  return res.json({
    ok: true,
    key: k,
    addedHours: hours,
    expiresAt: row.expiresAt,
    remainingSeconds: Math.floor(remainingMs(row.expiresAt) / 1000),
  });
});

// 404 สำหรับ API อื่น
app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

// Start
(async () => {
  await ensureDB();
  app.listen(PORT, () => {
    console.log(`UFO HUB X Key API listening on :${PORT}`);
    console.log("=> Your service is live 🎉");
  });
})();
