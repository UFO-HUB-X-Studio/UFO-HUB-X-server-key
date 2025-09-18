// server.mjs  — UFO HUB X Key Server (เข้ากับ UI v18+ เต็มๆ)
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ================== CONFIG ==================
const PORT              = process.env.PORT || 3000;
const PUBLIC_DIR        = path.join(__dirname, "public");
const DATA_FILE         = path.join(__dirname, "issued.json");
const EXPIRES_DEFAULT_S = 48 * 3600; // 48 ชั่วโมง
const RAND_LEN          = 8;
const KEY_PREFIX        = "UFO-";
const KEY_SUFFIX        = "-48H";

// Allow-list ฝั่งเซิร์ฟเวอร์ (ตรงกับของ UI)
const ALLOW_KEYS = {
  "JJJMAX":                { reusable: true, ttl: EXPIRES_DEFAULT_S },
  "GMPANUPHONGARTPHAIRIN": { reusable: true, ttl: EXPIRES_DEFAULT_S },
};

// ================ HELPER ====================
// normalize แบบเดียวกับฝั่ง UI: ตัดช่องว่าง/อักขระพิเศษ ออก + upper
function normKey(s) {
  return String(s || "").replace(/\s+/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// gen คีย์แบบมนุษย์อ่านง่าย
function randPart(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = crypto.randomBytes(n);
  return Array.from(buf, b => chars[b % chars.length]).slice(0, n).join("");
}
function makeHumanKey() {
  return KEY_PREFIX + randPart(RAND_LEN) + KEY_SUFFIX; // เช่น UFO-8CHARS-48H
}

// โครงสร้างเก็บ:
// issuedByNorm[normKey] = { key: "<human>", usedBy: "uid", place: "placeId", expiresAt: <unix> }
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
}
function loadIssued() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "{}");
    // รองรับของเดิมที่อาจเก็บเป็น { "<humanKey>": {...} }
    // แปลงให้เป็น byNorm เสมอ
    const byNorm = {};
    for (const k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      const v = raw[k];
      const nk = normKey(k);
      if (!nk) continue;
      byNorm[nk] = {
        key: v.key || k,            // เก็บ human key
        usedBy: v.usedBy || v.uid || null,
        place: v.place || null,
        expiresAt: Number(v.expiresAt) || 0,
      };
    }
    return byNorm;
  } catch {
    return {};
  }
}
function saveIssued(map) {
  // เซฟกลับเป็น object โดยใช้ human key เป็น key เพื่อให้มนุษย์อ่านง่าย
  const out = {};
  for (const nk in map) {
    const m = map[nk];
    out[m.key] = { usedBy: m.usedBy, place: m.place, expiresAt: m.expiresAt, key: m.key };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2), "utf8");
}
ensureDataFile();
let issuedByNorm = loadIssued();

function nowSec() { return Math.floor(Date.now() / 1000); }
function isExpired(meta) { return !meta || !meta.expiresAt || nowSec() > Number(meta.expiresAt); }

// หา key ที่ user เคยขอแล้วและยังไม่หมดอายุ
function findActiveKeyFor(uid) {
  if (!uid) return null;
  for (const nk in issuedByNorm) {
    const m = issuedByNorm[nk];
    if (m.usedBy === uid && !isExpired(m)) return m;
  }
  return null;
}

// ================ APP =======================
const app = express();
app.set("trust proxy", 1);
app.use(cors());                       // เปิด CORS ให้ Roblox/เว็บเรียกได้
app.use(express.json({ limit: "256kb" }));

// เสิร์ฟหน้าเว็บถ้ามี
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ================== API =====================
// แจกคีย์ใหม่ (หรือคืนอันเดิมถ้ายังไม่หมดอายุ)
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;

  const exists = findActiveKeyFor(uid);
  if (exists) {
    return res.json({
      ok: true,
      key: exists.key,
      expires_at: exists.expiresAt,
      ttl: Math.max(0, exists.expiresAt - nowSec()),
      note: "existing_key",
    });
  }

  // สร้างใหม่
  let human = makeHumanKey();
  let nk = normKey(human);
  // กันซ้ำเล็กน้อย
  let guard = 0;
  while (issuedByNorm[nk] && guard++ < 10) {
    human = makeHumanKey(); nk = normKey(human);
  }

  const exp = nowSec() + EXPIRES_DEFAULT_S;
  issuedByNorm[nk] = { key: human, usedBy: uid, place, expiresAt: exp };
  saveIssued(issuedByNorm);

  res.json({ ok: true, key: human, expires_at: exp, ttl: EXPIRES_DEFAULT_S });
});

// ตรวจสอบคีย์ (JSON เข้มงวด ตรงกับ UI v18+)
app.get("/verify", (req, res) => {
  const rawKey = String(req.query.key || "");
  const uid    = String(req.query.uid || "").trim() || null;
  // const place  = String(req.query.place || "").trim() || null; // เผื่ออยากล็อก place เพิ่มเติม

  if (!rawKey) return res.json({ ok: false, valid: false, reason: "no_key" });

  const nk = normKey(rawKey);

  // 1) allow-list ฝั่งเซิร์ฟเวอร์ (ผ่านเสมอ)
  if (ALLOW_KEYS[nk]) {
    const ttl = Number(ALLOW_KEYS[nk].ttl) || EXPIRES_DEFAULT_S;
    // สร้าง meta จำลองให้มีอายุ (เพื่อ UI จะจำหมดอายุได้เหมือนกัน)
    const exp = nowSec() + ttl;
    return res.json({ ok: true, valid: true, expires_at: exp, reason: "allow_list" });
  }

  // 2) คีย์ที่เคยแจก
  const meta = issuedByNorm[nk];
  if (!meta) {
    return res.json({ ok: true, valid: false, reason: "not_found" });
  }
  if (isExpired(meta)) {
    return res.json({ ok: true, valid: false, reason: "expired", expires_at: meta.expiresAt });
  }
  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({
      ok: true, valid: false, reason: "already_used_by_other_uid", expires_at: meta.expiresAt
    });
  }
  return res.json({ ok: true, valid: true, expires_at: meta.expiresAt });
});

// ต่ออายุคีย์ (เพิ่มอีก 48 ชม. จากเวลาหมดอายุเดิมหรือจากตอนนี้)
app.get("/extend", (req, res) => {
  const rawKey = String(req.query.key || "");
  if (!rawKey) return res.json({ ok: false, reason: "no_key" });

  const nk   = normKey(rawKey);
  const meta = issuedByNorm[nk];
  if (!meta) return res.json({ ok: false, reason: "not_found" });

  const base = Math.max(nowSec(), Number(meta.expiresAt) || 0);
  meta.expiresAt = base + EXPIRES_DEFAULT_S;
  saveIssued(issuedByNorm);

  res.json({ ok: true, key: meta.key, expires_at: meta.expiresAt });
});

// (ตัวเลือก) ดูทั้งหมด — แนะนำปิด/ใส่รหัสถ้าจะขึ้นโปรดักชัน
app.get("/issued", (_req, res) => {
  res.json(Object.fromEntries(Object.values(issuedByNorm).map(m => [m.key, m])));
});

// 404/json
app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
