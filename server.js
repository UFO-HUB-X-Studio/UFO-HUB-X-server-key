// server.js — UFO HUB X Key API (Full)
// POST /api/getkey     -> ออกคีย์จริง (1 คน 1 key, อายุ 48 ชม.)
// GET  /api/check/:key -> ตรวจคีย์ + เวลาที่เหลือ
// POST /api/extend/:key-> ยืดเวลา (สูงสุด +5 ชม./ครั้ง)
// GET  /api/health     -> health check
// Static /public       -> หน้าเว็บ

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs-extra");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const API_TOKEN = process.env.API_TOKEN || ""; // ถ้าตั้งไว้ จะตรวจ x-api-token ตอน extend

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_PATH = path.join(DATA_DIR, "keys.json");

const KEY_TTL_HOURS = 48;
const EXTEND_MAX_HOURS = 5;

const app = express();
app.use(cors());
app.use(express.json());

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(process.cwd(), "public")));

const DEFAULT_DB = { keys: [], clients: {} };

async function ensureDB() {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(DATA_PATH))) {
    await fs.writeJSON(DATA_PATH, DEFAULT_DB, { spaces: 2 });
    return;
  }
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    if (!raw.trim()) {
      await fs.writeJSON(DATA_PATH, DEFAULT_DB, { spaces: 2 });
    } else {
      JSON.parse(raw);
    }
  } catch {
    await fs.writeJSON(DATA_PATH, DEFAULT_DB, { spaces: 2 });
  }
}
async function loadDB() {
  try {
    const content = await fs.readFile(DATA_PATH, "utf-8");
    return content.trim() ? JSON.parse(content) : { ...DEFAULT_DB };
  } catch (e) {
    console.error("loadDB error:", e.message);
    return { ...DEFAULT_DB };
  }
}
async function saveDB(db) {
  await fs.writeJSON(DATA_PATH, db, { spaces: 2 });
}

function genKey() {
  const seg = () =>
    crypto
      .randomBytes(4)
      .toString("base64url")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  return `UHX-${seg()}-${seg()}`;
}
const now = () => Date.now();
const hoursFromNow = (h) => now() + h * 3600 * 1000;
const remainingMs = (exp) => Math.max(0, exp - now());

function resolveClientId(req) {
  const cid = (req.headers["x-client-id"] || "").toString().trim();
  if (cid) return cid;
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString();
  return crypto.createHash("sha1").update(ip).digest("hex").slice(0, 16);
}
function requireTokenIfSet(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.headers["x-api-token"];
  if (token === API_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "UFO HUB X KEY", time: new Date().toISOString() });
});

app.post("/api/getkey", async (req, res) => {
  await ensureDB();
  const db = await loadDB();

  const clientId = resolveClientId(req);
  const existing = db.clients[clientId];
  if (existing && remainingMs(existing.expiresAt) > 0) {
    return res.json({
      ok: true,
      key: existing.key,
      expiresAt: existing.expiresAt,
      remainingSeconds: Math.floor(remainingMs(existing.expiresAt) / 1000),
      reused: true
    });
  }

  const key = genKey();
  const createdAt = now();
  const expiresAt = hoursFromNow(KEY_TTL_HOURS);

  db.keys.push({ key, clientId, createdAt, expiresAt });
  db.clients[clientId] = { key, expiresAt };
  await saveDB(db);

  res.json({
    ok: true,
    key,
    expiresAt,
    remainingSeconds: Math.floor((expiresAt - now()) / 1000),
    reused: false
  });
});

app.get("/api/check/:key", async (req, res) => {
  await ensureDB();
  const db = await loadDB();

  const k = req.params.key;
  const row = db.keys.find((x) => x.key === k);
  if (!row) return res.status(404).json({ ok: false, valid: false, error: "Key not found" });

  const remain = remainingMs(row.expiresAt);
  res.json({
    ok: true,
    valid: remain > 0,
    key: k,
    expiresAt: row.expiresAt,
    remainingSeconds: Math.floor(remain / 1000)
  });
});

app.post("/api/extend/:key", requireTokenIfSet, async (req, res) => {
  await ensureDB();
  const db = await loadDB();

  const k = req.params.key;
  const row = db.keys.find((x) => x.key === k);
  if (!row) return res.status(404).json({ ok: false, error: "Key not found" });

  let hours = Number(req.body?.hours || EXTEND_MAX_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) hours = EXTEND_MAX_HOURS;
  hours = Math.min(hours, EXTEND_MAX_HOURS);

  row.expiresAt = row.expiresAt + hours * 3600 * 1000;

  const cid = row.clientId;
  if (db.clients[cid] && db.clients[cid].key === k) {
    db.clients[cid].expiresAt = row.expiresAt;
  }

  await saveDB(db);

  res.json({
    ok: true,
    key: k,
    addedHours: hours,
    expiresAt: row.expiresAt,
    remainingSeconds: Math.floor(remainingMs(row.expiresAt) / 1000)
  });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

(async () => {
  await ensureDB();
  app.listen(PORT, () => {
    console.log(`UFO HUB X Key API listening on :${PORT}`);
    console.log("=> Your service is live 🎉");
  });
})();
