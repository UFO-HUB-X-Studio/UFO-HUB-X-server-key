const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());

let cfg = { expires_default: 172800, keys: [] };
try {
  cfg = JSON.parse(fs.readFileSync("./config.json", "utf8"));
} catch (e) {
  console.error("Cannot read config.json, using defaults:", e.message);
}

// หน่วยความจำเล็กๆ บันทึกว่า key ไหนถูกใช้ไปกับ uid ไหนแล้ว (เฉพาะ reusable=false)
const usedOnce = new Map(); // key => Set<uid>

function nowSec() { return Math.floor(Date.now() / 1000); }
function findKeyMeta(k) {
  const nk = String(k || "").trim().toUpperCase();
  return cfg.keys.find(x => String(x.key || "").trim().toUpperCase() === nk) || null;
}

app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "");
  const place = String(req.query.place || "");
  return res.json({
    ok: true,
    message: "Use /verify?key=&uid=&place=&format=json",
    uid, place
  });
});

app.get("/verify", (req, res) => {
  const key   = String(req.query.key || "");
  const uid   = String(req.query.uid || "");
  const place = String(req.query.place || "");
  const wantsJson = String(req.query.format || "").toLowerCase() === "json";

  const meta = findKeyMeta(key);
  if (!meta) {
    if (wantsJson) return res.json({ ok: true, valid: false, reason: "invalid_key" });
    return res.send("INVALID");
  }

  // ถ้าเป็นคีย์ใช้ครั้งเดียว และ uid นี้ใช้แล้ว → invalid
  if (meta.reusable === false) {
    const usedSet = usedOnce.get(meta.key) || new Set();
    if (usedSet.has(uid)) {
      if (wantsJson) return res.json({ ok: true, valid: false, reason: "used_already" });
      return res.send("INVALID");
    }
    // มาร์กว่าใช้แล้ว (ครั้งแรก)
    usedSet.add(uid);
    usedOnce.set(meta.key, usedSet);
  }

  const ttl = Number(meta.ttl) || Number(cfg.expires_default) || 172800;
  const expires_at = nowSec() + ttl;

  if (wantsJson) {
    return res.json({ ok: true, valid: true, expires_at, reason: null, uid, place });
  } else {
    return res.send("VALID");
  }
});

// สาธิตหน้า root
app.get("/", (_req, res) => {
  res.send("UFO HUB X key server is running.");
});

// เริ่มเซิร์ฟเวอร์
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
