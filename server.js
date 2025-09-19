// server.js
// UFO HUB X — Simple Key Server (Express)
// Endpoints:
//  - GET /getkey?uid=123
//  - GET /verify?key=UFO-KEY-AAA111&uid=123[&format=json|text]
//      * default = json; format=text จะตอบ VALID/INVALID (เข้ากับสคริปต์เก่า)
//  - GET /health

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

// ----- โหลด config -----
const CONFIG_PATH = path.join(__dirname, "config.json");
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}
let CONFIG = loadConfig();

// แคชในหน่วยความจำ: เก็บการใช้คีย์แบบ one-time ต่อ uid
// โครงสร้าง: used[key] = { [uid]: expiresAtUnix }
const used = Object.create(null);

// ยูทิล: หาเมตาของคีย์จาก config
function findKeyMeta(k) {
  k = String(k || "").trim();
  if (!k) return null;
  const nk = k.toUpperCase();
  return (CONFIG.keys || []).find(item => String(item.key || "").toUpperCase() === nk) || null;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function ttlFor(meta) {
  // ใช้ ttl เฉพาะคีย์ > ใช้ config.expires_default > 172800 (48ชม.)
  return Number(meta?.ttl || CONFIG.expires_default || 172800);
}

// ----- GET /getkey -----
// แนวคิด: ส่ง "คีย์แรก" ใน config (หรือจะระบุ index เองก็ได้)
// หน้าที่นี้ใช้เพื่อให้ผู้เล่นกดปุ่ม "หา Key" แล้วคัดลอกคีย์ด้วยตัวเอง
app.get("/getkey", (req, res) => {
  try {
    const uid   = String(req.query.uid || "");
    CONFIG = loadConfig(); // reload เมื่อมีแก้ไฟล์บนเครื่อง

    const first = (CONFIG.keys && CONFIG.keys[0]) ? CONFIG.keys[0] : null;
    const firstKey = first ? String(first.key) : null;

    return res.json({
      ok: true,
      uid,
      key: firstKey,
      // ส่งเวลาหมดอายุแบบแนะนำ (ไม่ผูกกับการ verify)
      expires_in: CONFIG.expires_default || 172800
    });
  } catch (err) {
    console.error("GET /getkey error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----- GET /verify -----
// ตรวจคีย์ + ผูกกับ uid (UNIVERSAL, ไม่บังคับ place)
// โหมดตอบกลับ:
//   - format=json (default): { ok, valid, expires_at, reason? }
//   - format=text: 'VALID' หรือ 'INVALID'
app.get("/verify", (req, res) => {
  try {
    const uid    = String(req.query.uid || "");
    const keyRaw = String(req.query.key || "");
    const format = String(req.query.format || "json").toLowerCase();
    CONFIG = loadConfig();

    const meta = findKeyMeta(keyRaw);
    if (!keyRaw || !meta) {
      if (format === "text") return res.type("text/plain").send("INVALID");
      return res.json({ ok: true, valid: false, reason: "unknown_key" });
    }

    const ttl = ttlFor(meta);
    const expireAt = now() + ttl;

    // ถ้าเป็นคีย์ reusable = true ให้ผ่านตลอด (ภายใน TTL)
    if (meta.reusable === true) {
      if (format === "text") return res.type("text/plain").send("VALID");
      return res.json({ ok: true, valid: true, expires_at: expireAt });
    }

    // ถ้าเป็นคีย์แบบ one-time (หรือ reusable !== true):
    // - อนุญาต 1 uid ต่อ key ในช่วงอายุ TTL
    // - ถ้า uid เดิมเคยใช้แล้วและยังไม่หมดอายุ -> VALID
    // - ถ้ายังไม่เคยใช้ -> จองให้ uid นี้ แล้ว VALID
    const key = String(meta.key);
    used[key] = used[key] || {};
    const prevExp = used[key][uid];

    // เคยใช้แล้วและยังไม่หมดอายุ?
    if (prevExp && prevExp > now()) {
      if (format === "text") return res.type("text/plain").send("VALID");
      return res.json({ ok: true, valid: true, expires_at: prevExp });
    }

    // ยังไม่เคยใช้ -> จอง
    used[key][uid] = expireAt;
    if (format === "text") return res.type("text/plain").send("VALID");
    return res.json({ ok: true, valid: true, expires_at: expireAt });

  } catch (err) {
    console.error("GET /verify error:", err);
    if (String(req.query.format || "json").toLowerCase() === "text") {
      return res.type("text/plain").send("INVALID");
    }
    return res.status(500).json({ ok: false, valid: false, reason: "server_error" });
  }
});

// ----- Health check -----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("UFO HUB X key server running on port", PORT);
});
