import express from "express";
import cors from "cors";

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const DEFAULT_TTL = 48 * 3600; // 48 ชม.

// คีย์ถาวร (ให้ตรงกับ UI)
const ALLOW_KEYS = new Set([
  "JJJMAX",
  "GMPANUPHONGARTPHAIRIN",
]);

// เก็บคีย์ที่ออกจาก /getkey (in-memory)
const issued = new Map(); // key -> { uid, place, exp }

// ---------------- App ----------------
const app = express();
app.use(cors());

// Health check
app.get("/", (_req, res) => {
  res.type("text/plain").send("UFO HUB X Key Server: OK");
});

/**
 * /getkey?uid=&place=
 * - ออกคีย์ชั่วคราวให้ผู้เล่น (เก็บใน memory)
 * - ตอบเป็น text/plain เพื่อก็อปง่าย ๆ
 */
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "").trim();
  const place = String(req.query.place || "").trim();

  // ออกคีย์รูปแบบง่าย ๆ
  const ts = Math.floor(Date.now() / 1000);
  const key = `UFX-${uid || "NOUID"}-${ts}`;

  const exp = ts + DEFAULT_TTL;
  issued.set(key.toUpperCase(), { uid, place, exp });

  res.type("text/plain").send(key);
});

/**
 * /verify?key=&uid=&place=&format=json|text
 * พฤติกรรม:
 * - ถ้า ?format=json → ตอบ JSON {ok:true, valid:bool, expires_at:number, reason?:string}
 * - ถ้าไม่ระบุ → ตอบ text/plain "VALID" หรือ "INVALID"
 */
app.get("/verify", (req, res) => {
  const key   = String(req.query.key || "").replace(/[^\w]/g, "").toUpperCase();
  const uid   = String(req.query.uid || "");
  const place = String(req.query.place || "");
  const fmt   = String(req.query.format || "").toLowerCase();

  let valid = false;
  let expires_at = null;
  let reason = "invalid";

  // 1) allow-list ถาวร
  if (ALLOW_KEYS.has(key)) {
    valid = true;
    expires_at = Math.floor(Date.now() / 1000) + DEFAULT_TTL;
  } else {
    // 2) ตรวจจากคีย์ที่ออกโดย /getkey
    const found = issued.get(key);
    const now = Math.floor(Date.now() / 1000);
    if (found) {
      if (found.exp > now) {
        valid = true;
        expires_at = found.exp;
      } else {
        reason = "expired";
        issued.delete(key);
      }
    } else {
      reason = "not_found";
    }
  }

  // ตอบตามรูปแบบ
  if (fmt === "json") {
    res.json({
      ok: true,
      valid,
      expires_at,
      reason: valid ? undefined : reason,
      // debug เพิ่มได้ถ้าต้องการ: uid, place
    });
  } else {
    res.type("text/plain").send(valid ? "VALID" : "INVALID");
  }
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
