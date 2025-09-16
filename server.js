// UFO HUB X — Key API (Node/Express) - full version
// Endpoints:
//   POST /api/getkey        -> ออกคีย์ (1 คนมีได้ 1 คีย์) อายุเริ่มต้น 48 ชม.
//   GET  /api/check/:key    -> ตรวจสอบสถานะคีย์
//   POST /api/extend/:key   -> ต่อเวลา +5 ชม./ครั้ง (ต่อได้กี่ครั้งก็ได้, จะคุมเพิ่มในภายหลังได้)
//   GET  /api/health        -> เช็คสุขภาพเซิร์ฟเวอร์
//
// การระบุตัวตนผู้ใช้: ผูกจาก IP + User-Agent (fingerprint เบื้องต้น)
// การเก็บข้อมูล: เขียนลงไฟล์ JSON (เหมาะกับ Render ฟรี/ฮอบบี้)
//   - หากมี Persistent Disk ให้ตั้ง ENV DATA_PATH=/data/keys.json
//   - ถ้าไม่มีก็ใช้ ./data/keys.json (จะหายเมื่อ redeploy ใหม่)

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { nanoid } = require("nanoid");
const dayjs = require("dayjs");
const fs = require("fs-extra");
const crypto = require("crypto");

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// Whitelist CORS (ถ้าไม่ได้ตั้งค่า จะเปิดกว้างแบบปลอดภัยพอประมาณ)
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// อายุคีย์ตั้งต้น + จำนวนชั่วโมงที่ต่อเวลาได้ต่อครั้ง
const START_HOURS = Number(process.env.START_HOURS || 48);   // 48 ชม.
const EXTEND_STEP  = Number(process.env.EXTEND_STEP  || 5);   // +5 ชม./ครั้ง

// จำกัดความถี่การเรียก (กันสแปม)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 นาที
  max: 60               // 60 req/นาที/ไอพี
});

// ที่เก็บไฟล์คีย์
const DATA_PATH = process.env.DATA_PATH || "./data/keys.json";

// ---------- MIDDLEWARE ----------
app.set("trust proxy", 1); // ให้ x-forwarded-for ใช้ได้เวลาอยู่หลัง proxy (เช่น Render)
app.use(helmet());
app.use(express.json());
app.use(limiter);

// CORS
if (ALLOW_ORIGINS.length) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: false
  }));
} else {
  // ถ้าไม่ได้ตั้ง whitelist ก็เปิดแบบสาธารณะ (เหมาะ dev/testing)
  app.use(cors());
}

// ---------- SIMPLE DB (FILE) ----------
async function loadDB() {
  try {
    const exist = await fs.pathExists(DATA_PATH);
    if (!exist) {
      await fs.ensureFile(DATA_PATH);
      await fs.writeJSON(DATA_PATH, { keys: [], clients: {} }, { spaces: 2 });
    }
    return await fs.readJSON(DATA_PATH);
  } catch (e) {
    console.error("loadDB error:", e);
    return { keys: [], clients: {} };
  }
}

async function saveDB(db) {
  try {
    await fs.ensureFile(DATA_PATH);
    await fs.writeJSON(DATA_PATH, db, { spaces: 2 });
  } catch (e) {
    console.error("saveDB error:", e);
  }
}

// ---------- HELPERS ----------
function clientFingerprint(req) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "0.0.0.0";

  const ua = req.headers["user-agent"] || "unknown";
  // แฮชให้เป็นไอดีสั้น ๆ
  const hash = crypto
    .createHash("sha256")
    .update(ip + "|" + ua)
    .digest("hex")
    .slice(0, 24);

  return hash; // clientId
}

function genKey() {
  // ได้รูปแบบ UFO-HUB-X-xxxxxxxxxxxx (12 ตัว)
  return "UFO-HUB-X-" + nanoid(12);
}

function isExpired(rec) {
  return dayjs().isAfter(dayjs(rec.expiresAt));
}

function sanitizeKey(k) {
  return String(k || "").trim();
}

// ---------- API ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// ออกคีย์ (1 client มีได้ 1 key เท่านั้น หากมีอยู่แล้วและยังไม่หมดอายุจะคืนอันเดิม)
app.post("/api/getkey", async (req, res) => {
  const db = await loadDB();
  const cid = clientFingerprint(req);

  // ถ้ามีคีย์ของ client นี้อยู่แล้ว และยังไม่หมดอายุ → คืนอันเดิม
  const existingKey = db.clients[cid];
  if (existingKey) {
    const rec = db.keys.find(k => k.key === existingKey);
    if (rec && !isExpired(rec)) {
      return res.json({
        ok: true,
        message: "คุณมีคีย์อยู่แล้ว",
        key: rec.key,
        expiresAt: rec.expiresAt,
        remainingHours: Math.max(
          0,
          Math.ceil(dayjs(rec.expiresAt).diff(dayjs(), "hour", true))
        )
      });
    }
  }

  // ออกคีย์ใหม่
  const key = genKey();
  const now = dayjs();
  const expiresAt = now.add(START_HOURS, "hour").toISOString();

  const record = {
    key,
    clientId: cid,
    createdAt: now.toISOString(),
    expiresAt,
    extendedHours: 0
  };

  // เก็บ
  db.keys.push(record);
  db.clients[cid] = key;
  await saveDB(db);

  res.json({
    ok: true,
    message: "ออกคีย์ใหม่สำเร็จ",
    key,
    expiresAt,
    remainingHours: START_HOURS
  });
});

// ตรวจคีย์
app.get("/api/check/:key", async (req, res) => {
  const key = sanitizeKey(req.params.key);
  const db = await loadDB();

  const rec = db.keys.find(k => k.key === key);
  if (!rec) {
    return res.status(404).json({ ok: false, error: "ไม่พบคีย์นี้" });
  }

  const expired = isExpired(rec);
  res.json({
    ok: true,
    key: rec.key,
    clientId: rec.clientId,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    extendedHours: rec.extendedHours || 0,
    status: expired ? "expired" : "active",
    remainingHours: Math.max(
      0,
      Math.ceil(dayjs(rec.expiresAt).diff(dayjs(), "hour", true))
    )
  });
});

// ต่อเวลา +5 ชั่วโมง/ครั้ง
app.post("/api/extend/:key", async (req, res) => {
  const key = sanitizeKey(req.params.key);
  const db = await loadDB();

  const rec = db.keys.find(k => k.key === key);
  if (!rec) {
    return res.status(404).json({ ok: false, error: "ไม่พบคีย์นี้" });
  }

  // ถ้าหมดอายุแล้ว ไม่ให้ต่อเวลา
  if (isExpired(rec)) {
    return res
      .status(400)
      .json({ ok: false, error: "คีย์หมดอายุแล้ว ไม่สามารถต่อเวลาได้" });
  }

  // ต่อเวลา
  const newExp = dayjs(rec.expiresAt).add(EXTEND_STEP, "hour");
  rec.expiresAt = newExp.toISOString();
  rec.extendedHours = (rec.extendedHours || 0) + EXTEND_STEP;

  await saveDB(db);

  res.json({
    ok: true,
    message: `ต่อเวลา +${EXTEND_STEP} ชั่วโมงแล้ว`,
    key: rec.key,
    expiresAt: rec.expiresAt,
    extendedHours: rec.extendedHours,
    remainingHours: Math.max(
      0,
      Math.ceil(dayjs(rec.expiresAt).diff(dayjs(), "hour", true))
    )
  });
});

// หน้า root (optional)
app.get("/", (req, res) => {
  res.type("text").send("UFO HUB X – Key API running.");
});

// ---------- START ----------
(async () => {
  await fs.ensureFile(DATA_PATH).catch(() => {});
  const db = await loadDB();
  if (!db.keys) db.keys = [];
  if (!db.clients) db.clients = {};
  await saveDB(db);

  app.listen(PORT, () => {
    console.log(`UFO HUB X Key API listening on :${PORT}`);
  });
})();
