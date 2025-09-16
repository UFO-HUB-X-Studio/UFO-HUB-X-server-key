import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { RateLimiterMemory } from "rate-limiter-flexible";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CONFIG ----------
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "keys.json");

// อายุคีย์เริ่มต้น (ชั่วโมง) และการยืดเวลา/ครั้ง (ชั่วโมง)
const DEFAULT_HOURS = Number(process.env.DEFAULT_HOURS || 48);
const EXTEND_HOURS = Number(process.env.EXTEND_HOURS || 5);

// จำกัดความถี่การขอคีย์/ตรวจคีย์ ต่อ IP
const limiter = new RateLimiterMemory({
  points: 20, // 20 requests
  duration: 60 // per 60s
});

// ---------- Helpers ----------
async function ensureDB() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const exists = await fs.readFile(DB_FILE, "utf8").then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(DB_FILE, JSON.stringify({ keys: [] }, null, 2), "utf8");
    } else {
      // ซ่อมไฟล์ JSON แตก (ถ้ามี)
      try { JSON.parse(await fs.readFile(DB_FILE, "utf8")); }
      catch {
        await fs.writeFile(DB_FILE, JSON.stringify({ keys: [] }, null, 2), "utf8");
      }
    }
  } catch (e) {
    console.error("ensureDB error:", e);
  }
}

async function loadDB() {
  const raw = await fs.readFile(DB_FILE, "utf8");
  return JSON.parse(raw);
}
async function saveDB(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}
function ms(h) { return h * 60 * 60 * 1000; }
function now() { return Date.now(); }
function expiresAt(hours) { return now() + ms(hours); }

// สร้าง Key รูปแบบอ่านง่าย
function createKey() {
  const short = uuidv4().split("-")[0]; // 8 ตัวแรก
  return `UFO-HUB-X-${short}`;
}

// ---------- App ----------
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(morgan("tiny"));
app.use(express.static(path.join(__dirname, "public")));

// rate limit middleware
app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    next();
  } catch {
    res.status(429).json({ ok: false, error: "Too many requests. Please wait a moment." });
  }
});

// ---------- API ----------

// POST /api/getkey  {deviceId?}
app.post("/api/getkey", async (req, res) => {
  try {
    await ensureDB();
    const db = await loadDB();
    const deviceId = (req.body?.deviceId || "").slice(0, 128); // อนุญาตสั้นๆ

    // จำกัด 1 คน 1 คีย์ (ถ้ามี deviceId ส่งมา)
    if (deviceId) {
      const found = db.keys.find(k => k.deviceId === deviceId && k.isActive);
      if (found) {
        return res.json({ ok: true, key: found.key, expires: found.expires, remainingSec: Math.max(0, Math.floor((found.expires - now())/1000)) });
      }
    }

    const key = createKey();
    const entry = {
      key,
      deviceId: deviceId || null,
      created: now(),
      expires: expiresAt(DEFAULT_HOURS),
      isActive: true,
      extensions: 0
    };
    db.keys.unshift(entry);
    await saveDB(db);

    res.json({ ok: true, key: entry.key, expires: entry.expires, remainingSec: Math.floor((entry.expires - now())/1000) });
  } catch (e) {
    console.error("getkey error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/check/:key
app.get("/api/check/:key", async (req, res) => {
  try {
    await ensureDB();
    const db = await loadDB();
    const key = req.params.key;
    const entry = db.keys.find(k => k.key === key);
    if (!entry) return res.status(404).json({ ok: false, status: "not_found" });

    const remaining = entry.expires - now();
    if (remaining <= 0) {
      entry.isActive = false;
      await saveDB(db);
      return res.json({ ok: true, status: "expired", remainingSec: 0 });
    }
    res.json({
      ok: true,
      status: entry.isActive ? "active" : "inactive",
      expires: entry.expires,
      remainingSec: Math.floor(remaining/1000),
      extensions: entry.extensions
    });
  } catch (e) {
    console.error("check error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/extend/:key  -> ต่อเวลา +EXTEND_HOURS
app.post("/api/extend/:key", async (req, res) => {
  try {
    await ensureDB();
    const db = await loadDB();
    const key = req.params.key;
    const entry = db.keys.find(k => k.key === key);
    if (!entry) return res.status(404).json({ ok: false, error: "Key not found" });

    // ถ้าหมดอายุอยู่แล้ว ต่อไม่ได้
    if (entry.expires - now() <= 0) {
      entry.isActive = false;
      await saveDB(db);
      return res.status(400).json({ ok: false, error: "Key expired" });
    }

    entry.expires += ms(EXTEND_HOURS);
    entry.extensions += 1;
    await saveDB(db);

    res.json({
      ok: true,
      key: entry.key,
      expires: entry.expires,
      remainingSec: Math.floor((entry.expires - now())/1000),
      extensions: entry.extensions,
      addedHours: EXTEND_HOURS
    });
  } catch (e) {
    console.error("extend error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// 404 for unknown API
app.use("/api/*", (_, res) => res.status(404).json({ ok:false, error:"Unknown API" }));

// ---------- Start ----------
await ensureDB();
app.listen(PORT, () => {
  console.log(`UFO HUB X Key API listening on :${PORT}`);
});
