// Minimal UFO-HUB-X key server (Express)
// Endpoints:
//   GET /getkey?uid=123
//   GET /verify?key=UFO-KEY-AAA111&uid=123

const express = require("express");
const fs = require("fs");
const path = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS + JSON header (ให้ Roblox/Executor เรียกได้สบาย)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

function loadConfig() {
  const p = path.join(__dirname, "config.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Health check (บางโฮสต์ใช้เช็ค)
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ufo-hub-x-key-server" });
});

// ---------------------- GETKEY ----------------------
app.get("/getkey", (req, res) => {
  const uid   = req.query.uid   || "";
  const place = req.query.place || "";

  try {
    const config   = loadConfig();
    const firstKey = config.keys[0] ? config.keys[0].key : null;

    res.json({
      ok: true,
      uid,
      place,
      key: firstKey,                                  // ส่งคีย์แรกออกไป
      expires_in: config.expires_default || 172800    // บอก TTL เริ่มต้น
    });
  } catch (err) {
    console.error("getkey error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------- VERIFY ----------------------
app.get("/verify", (req, res) => {
  const uid = (req.query.uid || "").trim();
  const key = (req.query.key || "").trim();

  try {
    const config = loadConfig();
    const found  = config.keys.find(k => k.key === key);

    if (!found) {
      return res.json({ ok: true, valid: false, reason: "invalid_key" });
    }

    // หมดอายุ = ตอนนี้ + ttl (ถ้าไม่ได้ใส่ ttl ใช้ expires_default)
    const now       = Math.floor(Date.now() / 1000);
    const ttl       = Number(found.ttl || config.expires_default || 172800);
    const expiresAt = now + ttl;

    res.json({
      ok: true,
      valid: true,
      key: found.key,
      reusable: !!found.reusable,
      expires_at: expiresAt    // unix time ที่จะหมดอายุ
    });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
