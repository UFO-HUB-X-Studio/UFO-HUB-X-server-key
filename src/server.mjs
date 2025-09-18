import express from "express";
import cors from "cors";

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const DEFAULT_TTL = 48 * 3600; // 48 ชั่วโมง (วินาที)

// Allow-list คีย์พิเศษ (ผ่านแน่)
const ALLOW_KEYS = new Map([
  ["JJJMAX",                { reusable: true, ttl: DEFAULT_TTL }],
  ["GMPANUPHONGARTPHAIRIN", { reusable: true, ttl: DEFAULT_TTL }],
]);

// Memory store สำหรับคีย์ที่แจกจาก /getkey
// structure: key -> { uid, place, expires_at, reusable:false }
const ISSUED = new Map();

// ---------------- APP ----------------
const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get("/", (_req, res) => {
  res.type("text/plain").send("UFO HUB X Key Server: OK");
});

// แจกคีย์ (จำกัดผูก uid/place ไว้ใน memory)
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "").trim();
  const place = String(req.query.place || "").trim();

  // สร้างคีย์แบบอ่านง่าย + ไม่ซ้ำ
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  const key  = `UFX-${uid || "ANON"}-${rand}`;

  const expires_at = Math.floor(Date.now() / 1000) + DEFAULT_TTL;

  ISSUED.set(key.toUpperCase(), { uid, place, expires_at, reusable: false });

  return res.json({
    ok: true,
    key,
    ttl: DEFAULT_TTL,
    expires_at,
    reusable: false,
    meta: { uid: uid || null, place: place || null }
  });
});

// ตรวจคีย์ (รองรับทั้ง JSON และ text/plain)
app.get("/verify", (req, res) => {
  const format = String(req.query.format || "").toLowerCase();
  const rawKey = String(req.query.key || "");
  const uid    = String(req.query.uid || "").trim();
  const place  = String(req.query.place || "").trim();

  const key = rawKey.replace(/\s+/g, "").replace(/[^\w-]/g, "").toUpperCase();
  const now = Math.floor(Date.now() / 1000);

  let valid = false;
  let expires_at = null;
  let reason = null;

  // 1) allow-list
  if (ALLOW_KEYS.has(key)) {
    const meta = ALLOW_KEYS.get(key);
    valid = true;
    expires_at = now + (meta.ttl || DEFAULT_TTL);
  } else {
    // 2) คีย์ที่แจกจาก /getkey
    const rec = ISSUED.get(key);
    if (!rec) {
      valid = false;
      reason = "invalid";
    } else if (rec.expires_at <= now) {
      valid = false;
      reason = "expired";
      ISSUED.delete(key);
    } else {
      // ถ้าผูก uid ไว้ ให้ตรวจ (ถ้าอยากข้าม ก็ไม่ต้องเช็ค)
      if (rec.uid && uid && rec.uid !== uid) {
        valid = false;
        reason = "uid_mismatch";
      } else {
        valid = true;
        expires_at = rec.expires_at;
      }
    }
  }

  if (format === "json") {
    return res.json({
      ok: true,
      valid,
      expires_at: valid ? expires_at : null,
      reason: valid ? null : (reason || "invalid")
    });
  } else {
    return res
      .type("text/plain")
      .send(valid ? "VALID" : "INVALID");
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log("UFO HUB X key server listening on port", PORT);
});
