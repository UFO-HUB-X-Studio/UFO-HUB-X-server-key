// UFO HUB X Key API — server.js
// -----------------------------------------
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bodyParser from "body-parser";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import moment from "moment";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CONFIG ----------
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "keys.json");

const DEFAULT_LIFETIME_HOURS = 48;  // เวลาหลัก
const EXTEND_HOURS = 5;             // ยืดครั้งละ +5 ชม
const EXTEND_COOLDOWN_MIN = 10;     // ยืดได้ทุกกี่นาที (กันสแปม)
const ONE_KEY_PER_FINGERPRINT = true;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // ใส่ใน Render Env ถ้าจะใช้ endpoint admin

// ---------- Helpers ----------
function nowUtc() { return moment.utc(); }
function toISO(m) { return m.clone().toISOString(); }
function fromISO(s) { return moment.utc(s); }
function sanitizeUA(ua="") { return ua.substring(0, 180); }

function makeKey() {
  // รูปแบบ: UFO-HUB-X-xxxxx-xxxxx
  const short = () => uuidv4().split("-")[0].toUpperCase();
  return `UFO-HUB-X-${short()}-${short()}`;
}

async function ensureDB() {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(DB_FILE))) {
    await fs.writeJson(DB_FILE, { keys: {}, logs: [] }, { spaces: 2 });
  }
}

async function readDB() {
  await ensureDB();
  try {
    return await fs.readJson(DB_FILE);
  } catch (err) {
    // ถ้าไฟล์พัง/ไม่ครบ ให้รีเซ็ต
    console.error("loadDB error:", err?.message);
    await fs.writeJson(DB_FILE, { keys: {}, logs: [] }, { spaces: 2 });
    return { keys: {}, logs: [] };
  }
}

async function writeDB(db) {
  await fs.writeJson(DB_FILE, db, { spaces: 2 });
}

function fpFromReq(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  const ua = sanitizeUA(req.headers["user-agent"] || "");
  // fingerprint แบบง่าย: ip + ua
  return `${ip}|${ua}`;
}

function keySummary(keyObj) {
  const now = nowUtc();
  const expiresAt = fromISO(keyObj.expiresAt);
  const remainingSec = Math.max(0, expiresAt.diff(now, "seconds"));
  return {
    key: keyObj.key,
    createdAt: keyObj.createdAt,
    expiresAt: keyObj.expiresAt,
    remainingSeconds: remainingSec,
    remainingHuman: moment.duration(remainingSec, "seconds").humanize(),
    extendedHours: keyObj.extendedHours || 0
  };
}

// ---------- Rate-limit แบบเบา ๆ ----------
const hitCache = new Map(); // fp -> { count, resetAt }
const MAX_REQ_PER_MIN = 60;

function rateGuard(req, res, next) {
  const fp = fpFromReq(req);
  const now = Date.now();
  const record = hitCache.get(fp) || { count: 0, resetAt: now + 60_000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 60_000;
  }
  record.count += 1;
  hitCache.set(fp, record);
  if (record.count > MAX_REQ_PER_MIN) {
    return res.status(429).json({ ok:false, error: "Too many requests. Please slow down." });
  }
  next();
}

// ---------- App ----------
const app = express();
app.use(helmet());
app.use(cors({ origin: "*", credentials: false }));
app.use(bodyParser.json());
app.use(rateGuard);

// เสิร์ฟไฟล์หน้าเว็บ
app.use(express.static(path.join(__dirname, "public")));

// ---------- API ----------

// สถานะ/เวอร์ชัน
app.get("/api/version", async (req, res) => {
  res.json({ ok: true, name: "UFO HUB X Key API", version: "1.0.0", now: nowUtc().toISOString() });
});

// ออกคีย์ (1 คน/1 คีย์) : POST /api/getkey
// body: { fingerprint? } (ถ้าอยากส่งอะไรเพิ่มก็ได้)
app.post("/api/getkey", async (req, res) => {
  try {
    const db = await readDB();
    const fp = fpFromReq(req);

    // หา key เดิมถ้ามี (นับเป็น “1 คน 1 คีย์”)
    if (ONE_KEY_PER_FINGERPRINT) {
      const existed = Object.values(db.keys).find(k => k.fingerprint === fp);
      if (existed) {
        return res.json({ ok: true, exist: true, data: keySummary(existed) });
      }
    }

    // ออกคีย์ใหม่
    const key = makeKey();
    const createdAt = toISO(nowUtc());
    const expiresAt = toISO(nowUtc().add(DEFAULT_LIFETIME_HOURS, "hours"));

    const record = {
      key,
      fingerprint: fp,
      createdAt,
      expiresAt,
      extendedHours: 0,
      ua: sanitizeUA(req.headers["user-agent"] || ""),
      lastExtendAt: null
    };
    db.keys[key] = record;
    db.logs.push({ t: createdAt, type: "issue", key, fp });

    await writeDB(db);
    return res.json({ ok: true, data: keySummary(record) });
  } catch (err) {
    console.error("getkey error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ตรวจคีย์: GET /api/check/:key
app.get("/api/check/:key", async (req, res) => {
  try {
    const db = await readDB();
    const key = req.params.key;
    const item = db.keys[key];
    if (!item) {
      return res.status(404).json({ ok: false, error: "Key not found" });
    }
    const expiresAt = fromISO(item.expiresAt);
    const valid = nowUtc().isBefore(expiresAt);
    return res.json({ ok: true, valid, data: keySummary(item) });
  } catch (err) {
    console.error("check error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ยืดเวลา: POST /api/extend/:key  (+5H, มีคูลดาวน์)
app.post("/api/extend/:key", async (req, res) => {
  try {
    const db = await readDB();
    const key = req.params.key;
    const item = db.keys[key];
    if (!item) {
      return res.status(404).json({ ok: false, error: "Key not found" });
    }

    // จำกัดให้คนเดิมยืด (จาก fingerprint เดียวกัน)
    const fp = fpFromReq(req);
    if (item.fingerprint !== fp) {
      return res.status(403).json({ ok: false, error: "Not allowed to extend this key" });
    }

    // Cooldown ยืด
    const now = nowUtc();
    if (item.lastExtendAt) {
      const last = fromISO(item.lastExtendAt);
      const diffMin = now.diff(last, "minutes");
      if (diffMin < EXTEND_COOLDOWN_MIN) {
        return res.status(429).json({
          ok: false,
          error: `Please wait ${EXTEND_COOLDOWN_MIN - diffMin} more minute(s) before next extend`
        });
      }
    }

    const oldExp = fromISO(item.expiresAt);
    const newExp = oldExp.add(EXTEND_HOURS, "hours");

    item.expiresAt = toISO(newExp);
    item.extendedHours = (item.extendedHours || 0) + EXTEND_HOURS;
    item.lastExtendAt = toISO(now);

    db.logs.push({ t: toISO(now), type: "extend", key, fp, addedHours: EXTEND_HOURS });
    await writeDB(db);

    return res.json({ ok: true, data: keySummary(item) });
  } catch (err) {
    console.error("extend error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Admin (optional) ----------
// ใช้ได้เมื่อส่ง header:  Authorization: Bearer <ADMIN_TOKEN>
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ ok:false, error:"Admin is disabled" });
  const auth = (req.headers.authorization || "").replace("Bearer ", "");
  if (auth !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"Unauthorized" });
  next();
}

app.get("/api/admin/list", requireAdmin, async (req, res) => {
  const db = await readDB();
  res.json({ ok: true, count: Object.keys(db.keys).length, keys: db.keys, logs: db.logs.slice(-200) });
});

app.delete("/api/admin/delete/:key", requireAdmin, async (req, res) => {
  const db = await readDB();
  const key = req.params.key;
  if (!db.keys[key]) return res.status(404).json({ ok:false, error:"Key not found" });
  delete db.keys[key];
  await writeDB(db);
  res.json({ ok:true, deleted:key });
});

// ---------- Health ----------
app.get("/healthz", (req, res) => res.json({ ok: true, status: "live" }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`UFO HUB X Key API listening on :${PORT}`);
});
