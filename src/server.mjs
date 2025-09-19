// server.js (ESM) — UFO HUB X Key Server (Stateless, paste-and-go)
import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// ====== ENV / BOOT ======
dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;

// กุญแจลับสำหรับทำลายเซ็น (ควรตั้งใน .env บน Render: SECRET=ของคุณเอง)
const SECRET = process.env.SECRET || "ufohubx-secret-change-me";

// อายุคีย์เป็นวินาที (ค่าเริ่มต้น 48 ชั่วโมง)
const DEFAULT_TTL = Number(process.env.DEFAULT_TTL || 48 * 3600);

// เปิด CORS ทุกที่ (ให้ UI/เกมเรียกได้)
app.use(cors());

// (ถ้ามีโฟลเดอร์ public ให้เสิร์ฟสแตติกด้วย—ไม่จำเป็นตอนนี้ แต่เผื่ออนาคต)
app.use(express.static(path.join(__dirname, "public")));

// ====== HELPERS ======

// สร้าง HMAC แบบสั้น (16 ตัวอักษร) ป้องกันแก้ไขคีย์
function sig(uid, place, exp) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${uid}:${place}:${exp}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

// สร้างคีย์แบบ Stateless: u36-p36-exp-sig
function makeKey(uid, place, exp) {
  // แปลง uid/place เป็นฐาน 36 ให้สั้นลง + เป็นตัวใหญ่เพื่อความคงที่
  const u36 = BigInt(Math.abs(Number(uid) || 0)).toString(36).toUpperCase();
  const p36 = BigInt(Math.abs(Number(place) || 0)).toString(36).toUpperCase();
  const s = sig(uid, place, exp);
  return `${u36}-${p36}-${exp}-${s}`;
}

// ตรวจคีย์แบบ Stateless (ไม่ง้อ DB)
function verifyKey(key, uid, place) {
  const parts = String(key || "").trim().toUpperCase().split("-");
  // รูปแบบที่รองรับ = 4 ส่วน เท่านั้น: u36-p36-exp-sig
  if (parts.length !== 4) return { valid: false, exp: 0 };

  const [u36, p36, expStr, sigPart] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { valid: false, exp: 0 };

  // uid/place ที่ส่งมาต้องเข้าคู่กับในคีย์
  const uCheck = BigInt(Math.abs(Number(uid) || 0)).toString(36).toUpperCase();
  const pCheck = BigInt(Math.abs(Number(place) || 0)).toString(36).toUpperCase();
  if (u36 !== uCheck || p36 !== pCheck) return { valid: false, exp };

  // ตรวจลายเซ็น + ไม่หมดอายุ
  const want = sig(uid, place, exp);
  const okSig =
    Buffer.from(want).length === Buffer.from(sigPart).length &&
    crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sigPart));

  const now = Math.floor(Date.now() / 1000);
  return { valid: okSig && exp > now, exp };
}

// ส่ง JSON ok
function okJson(res, obj = {}) {
  res.type("application/json").send({ ok: true, ...obj });
}

// ส่ง JSON error
function badJson(res, reason = "error") {
  res.status(400).type("application/json").send({ ok: false, reason });
}

// ====== ENDPOINTS ======

// health check
app.get("/health", (req, res) => {
  okJson(res, { server: "ufo-hub-x-key", ts: Math.floor(Date.now() / 1000) });
});

// ออกคีย์ใหม่
// GET /getkey?uid=123&place=456  [&format=json|text]
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "");
  const place = String(req.query.place || "");
  const format = String(req.query.format || "json").toLowerCase();

  if (!uid || !place) {
    if (format === "text") return res.type("text/plain").send("MISSING");
    return badJson(res, "missing uid/place");
  }

  const exp = Math.floor(Date.now() / 1000) + DEFAULT_TTL;
  const key = makeKey(uid, place, exp);

  if (format === "text") {
    // รูปแบบที่ง่ายต่อการคัดลอก
    return res
      .type("text/plain")
      .send(`${key}|EXPIRES_AT=${exp}`);
  }

  return okJson(res, { key, expires_at: exp });
});

// ตรวจคีย์
// GET /verify?key=...&uid=...&place=...  [&format=json|text]
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "");
  const uid = String(req.query.uid || "");
  const place = String(req.query.place || "");
  const format = String(req.query.format || "json").toLowerCase();

  if (!key || !uid || !place) {
    if (format === "text") return res.type("text/plain").send("INVALID");
    return badJson(res, "missing key/uid/place");
  }

  const { valid, exp } = verifyKey(key, uid, place);

  if (format === "text") {
    return res.type("text/plain").send(valid ? "VALID" : "INVALID");
  }

  return okJson(res, { valid, expires_at: exp });
});

// (ถ้าอยากเสิร์ฟ UI ภายหลัง ให้มี public/index.html แล้วเปิดหน้านี้)
// ไม่มีก็ไม่เป็นไร
app.get("/", (req, res) => {
  try {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } catch {
    res.type("text/plain").send("UFO HUB X Key Server is running.\nUse /getkey and /verify.");
  }
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`[UFO-HUB-X] Key server listening on :${PORT}`);
  console.log(`SECRET length: ${String(SECRET).length} | DEFAULT_TTL: ${DEFAULT_TTL}s`);
});
