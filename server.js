// server.js — แบบง่าย ตัวเดียวจบ
// เอ็นด์พอยต์:
//   GET /            -> Health: "UFO HUB X Key Server: OK"
//   GET /getkey      -> ออกคีย์: {key, expires_at} หรือ text/plain
//   GET /verify      -> ตรวจคีย์: "VALID"/"INVALID" หรือ JSON เมื่อใส่ ?format=json

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CONFIG ง่าย ๆ ======
const SECRET = process.env.SECRET || "CHANGE_ME";     // ตั้งใน Render > Environment
const DEFAULT_TTL = parseInt(process.env.TTL || "172800", 10); // อายุคีย์ 48 ชม. (วินาที)

// HMAC(uid:place:exp)
function sig(uid, place, exp) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(String(uid) + ":" + String(place) + ":" + String(exp))
    .digest("hex")
    .slice(0, 24)      // ให้คีย์สั้นลง อ่านง่าย
    .toUpperCase();
}

// เข้ารูปคีย์แบบ Stateless: u36-p36-exp-sig
function makeKey(uid, place, exp) {
  const u36 = BigInt(Math.abs(Number(uid) || 0)).toString(36).toUpperCase();
  const p36 = BigInt(Math.abs(Number(place) || 0)).toString(36).toUpperCase();
  return `${u36}-${p36}-${exp}-${sig(uid, place, exp)}`;
}

// ตรวจคีย์
function verifyKeyStr(key, uid, place) {
  const parts = String(key || "").trim().toUpperCase().split("-");
  if (parts.length !== 4) return { valid: false, exp: 0 };

  const [u36, p36, expStr, s] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { valid: false, exp: 0 };

  const uu = BigInt(Math.abs(Number(uid) || 0)).toString(36).toUpperCase();
  const pp = BigInt(Math.abs(Number(place) || 0)).toString(36).toUpperCase();
  if (u36 !== uu || p36 !== pp) return { valid: false, exp };

  const want = sig(uid, place, exp);
  const okSig =
    Buffer.byteLength(want) === Buffer.byteLength(s) &&
    crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s));

  const now = Math.floor(Date.now() / 1000);
  return { valid: okSig && exp > now, exp };
}

// ====== ROUTES ======
app.use(cors());

app.get("/", (_req, res) => {
  res.type("text/plain").send("UFO HUB X Key Server: OK");
});

// GET /getkey?uid=...&place=...&format=json|text
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "");
  const place = String(req.query.place || "");
  const format = String(req.query.format || "");

  if (!uid || !place) {
    return format === "json"
      ? res.status(400).json({ ok: false, error: "missing uid/place" })
      : res.status(400).type("text/plain").send("missing uid/place");
  }

  const exp = Math.floor(Date.now() / 1000) + DEFAULT_TTL;
  const key = makeKey(uid, place, exp);

  if (format === "json") {
    return res.json({ ok: true, key, expires_at: exp });
  }
  return res.type("text/plain").send(key);
});

// GET /verify?key=...&uid=...&place=...&format=json|text
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "");
  const uid = String(req.query.uid || "");
  const place = String(req.query.place || "");
  const format = String(req.query.format || "");

  if (!key || !uid || !place) {
    return format === "json"
      ? res.status(400).json({ ok: false, error: "missing key/uid/place" })
      : res.status(400).type("text/plain").send("INVALID");
  }

  const { valid, exp } = verifyKeyStr(key, uid, place);

  if (format === "json") {
    return res.json({ ok: true, valid, expires_at: exp });
  }
  return res.type("text/plain").send(valid ? "VALID" : "INVALID");
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`[KEY] listening on ${PORT}`);
});
