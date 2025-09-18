// UFO HUB X — Key Server (ESM, Render-ready)
// Endpoints:
//   GET /               -> "UFO HUB X Key Server: OK"
//   GET /getkey         -> สร้าง/คืน key ผูกกับ uid+place    (query: uid, place)
//   GET /verify         -> ตรวจ key (JSON หรือ text)        (query: key, uid, place, format=json)
// Response JSON: { ok:true, valid:true/false, expires_at: <unix>, reason?: "..." }

import express from "express";
import cors from "cors";
import crypto from "crypto";

// -------------------- CONFIG --------------------
const app = express();
const PORT = process.env.PORT || 3000;

// อายุคีย์เริ่มต้น (วินาที)
const DEFAULT_TTL_SECONDS = 48 * 3600; // 48 ชั่วโมง
// จำกัดการใช้งานต่อคีย์ (0 = ไม่จำกัด)
const DEFAULT_MAX_USES = 0;

// Allow-list ถาวร (ต้องพิมพ์ตรงตัว, ไม่สนใจ uid/place)
const ALLOW_KEYS = new Set([
  "JJJMAX",
  "GMPANUPHONGARTPHAIRIN"
]);

// เปิด CORS + ปิด cache
app.use(cors());
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  next();
});

// -------------------- Store ในหน่วยความจำ --------------------
// โครงสร้าง: keyStr -> { uid, place, created_at, expires_at, uses, max_uses }
const keyStore = new Map();

// เก็บคีย์ล่าสุดของ user เพื่อคืน key เดิมถ้ายังไม่หมดอายุ (ลดสแปมสร้างคีย์)
const userIndex = new Map(); // `${uid}:${place}` -> keyStr

function now() {
  return Math.floor(Date.now() / 1000);
}

function genKey(uid, place) {
  // คีย์รูปแบบ: UFO-XXXXXXXX-YYYY  (อ่านง่าย และกันชนกัน)
  const rand = crypto.randomBytes(6).toString("hex").toUpperCase();
  const tail = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `UFO-${rand}-${tail}`;
}

function upsertKeyFor(uid, place, ttlSec = DEFAULT_TTL_SECONDS, maxUses = DEFAULT_MAX_USES) {
  const idx = `${uid}:${place}`;
  // ถ้ามี key เดิมที่ยังไม่หมดอายุ → คืนอันเดิม
  const existing = userIndex.get(idx);
  if (existing) {
    const meta = keyStore.get(existing);
    if (meta && meta.expires_at > now()) {
      return { key: existing, meta };
    }
  }
  // สร้างใหม่
  const key = genKey(uid, place);
  const meta = {
    uid: String(uid || ""),
    place: String(place || ""),
    created_at: now(),
    expires_at: now() + Number(ttlSec || DEFAULT_TTL_SECONDS),
    uses: 0,
    max_uses: Number(maxUses || DEFAULT_MAX_USES)
  };
  keyStore.set(key, meta);
  userIndex.set(idx, key);
  return { key, meta };
}

function isValidKeyFor(key, uid, place) {
  const U = String(uid || "");
  const P = String(place || "");
  const K = String(key || "").trim().toUpperCase();

  // 1) allow list ผ่านทันที
  if (ALLOW_KEYS.has(K)) {
    return { valid: true, reason: null, expires_at: now() + DEFAULT_TTL_SECONDS, allow: true };
  }

  const meta = keyStore.get(K);
  if (!meta) return { valid: false, reason: "not_found" };

  if (meta.expires_at <= now()) return { valid: false, reason: "expired" };

  // ต้องตรง uid/place ที่ผูกไว้
  if (meta.uid !== U || meta.place !== P) return { valid: false, reason: "mismatch_uid_place" };

  // เช็คจำนวนครั้งที่อนุญาต
  if (meta.max_uses > 0 && meta.uses >= meta.max_uses) return { valid: false, reason: "exhausted" };

  return { valid: true, reason: null, expires_at: meta.expires_at, meta };
}

// background cleanup (ล้าง key หมดอายุเป็นระยะ)
setInterval(() => {
  const t = now();
  for (const [k, meta] of keyStore) {
    if (meta.expires_at <= t) {
      keyStore.delete(k);
      const idx = `${meta.uid}:${meta.place}`;
      if (userIndex.get(idx) === k) userIndex.delete(idx);
    }
  }
}, 10 * 60 * 1000); // ทุก 10 นาที

// -------------------- Routes --------------------
app.get("/", (_req, res) => {
  res.type("text/plain").send("UFO HUB X Key Server: OK");
});

// GET /getkey?uid=&place=&ttl= (ttl เป็นวินาที, ไม่ส่ง = ใช้ค่า default)
app.get("/getkey", (req, res) => {
  const { uid = "", place = "", ttl = "" } = req.query || {};
  if (!uid || !place) {
    return res.status(400).json({ ok: false, error: "missing_uid_or_place" });
  }

  const ttlSec = Number(ttl) > 0 ? Number(ttl) : DEFAULT_TTL_SECONDS;
  const { key, meta } = upsertKeyFor(uid, place, ttlSec);

  return res.json({
    ok: true,
    key,
    expires_at: meta.expires_at,
    note: "Keep this key private. It is tied to your uid/place."
  });
});

// GET /verify?key=&uid=&place=&format=json
// - ถ้า format=json → คืน JSON
// - ไม่ส่ง format หรือไม่ใช่ json → คืนเป็น text/plain ("VALID" หรือ "INVALID")
app.get("/verify", (req, res) => {
  const { key = "", uid = "", place = "", format = "" } = req.query || {};

  if (!key || !uid || !place) {
    const j = { ok: true, valid: false, reason: "missing_params" };
    return String(format).toLowerCase() === "json"
      ? res.json(j)
      : res.type("text/plain").send("INVALID");
  }

  const result = isValidKeyFor(key, uid, place);

  if (result.valid && !result.allow) {
    // นับการใช้งานเมื่อผ่าน (เฉพาะ key ที่ไม่ใช่ allow-list)
    const meta = result.meta;
    meta.uses += 1;
    // ปรับลด max_uses ตามต้องการ (ปัจจุบันไม่จำกัด)
  }

  if (String(format).toLowerCase() === "json") {
    return res.json({
      ok: true,
      valid: !!result.valid,
      expires_at: result.expires_at || (now() + DEFAULT_TTL_SECONDS),
      reason: result.reason || null
    });
  } else {
    return res
      .type("text/plain")
      .send(result.valid ? "VALID" : "INVALID");
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log("UFO HUB X Key Server listening on", PORT);
});
