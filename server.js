// UFO-HUB-X Key Server (Persist issued keys + real expiry)
// Endpoints:
//   GET /getkey?uid=123
//   GET /verify?key=UFO-KEY-AAA111&uid=123

const express = require("express");
const fs = require("fs");
const path = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const CONFIG_PATH = path.join(__dirname, "config.json");
const ISSUED_PATH = path.join(__dirname, "issued.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function loadIssued() {
  if (!fs.existsSync(ISSUED_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ISSUED_PATH, "utf8") || "{}"); }
  catch { return {}; }
}
function saveIssued(obj) {
  fs.writeFileSync(ISSUED_PATH, JSON.stringify(obj, null, 2), "utf8");
}

app.get("/", (req, res) => res.json({ ok: true, service: "ufo-hub-x-key-server" }));

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
      key: firstKey,
      expires_in: config.expires_default || 172800
    });
  } catch (err) {
    console.error("getkey error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------- VERIFY ----------------------
app.get("/verify", (req, res) => {
  const uid = String(req.query.uid || "").trim();
  const key = String(req.query.key || "").trim();

  try {
    const config = loadConfig();
    const found  = config.keys.find(k => k.key === key);

    if (!found) {
      return res.json({ ok: true, valid: false, reason: "invalid_key" });
    }

    const now    = Math.floor(Date.now() / 1000);
    const ttl    = Number(found.ttl || config.expires_default || 172800);

    // ออก "บัตรคีย์" ครั้งแรก แล้วใช้บัตรเดิมในครั้งต่อ ๆ ไป
    const issued = loadIssued();
    const ticketId = `${uid}:${key}`; // ผูกกับ UID (จะได้ไม่ลามไปทั้งโลก)
    let ticket = issued[ticketId];

    if (!ticket) {
      // ออกบัตรใหม่
      ticket = {
        key: found.key,
        uid,
        issued_at: now,
        expires_at: now + ttl,
        reusable: !!found.reusable
      };
      issued[ticketId] = ticket;
      saveIssued(issued);
    }

    // ตรวจหมดอายุจาก "บัตร" ไม่ใช่คำนวณใหม่ทุกครั้ง
    if (now > ticket.expires_at) {
      return res.json({ ok: true, valid: false, reason: "expired", expired_at: ticket.expires_at });
    }

    // ถ้าอยาก “non-reusable” แบบใช้ได้ครั้งเดียวต่อ UID
    // ให้เพิ่มเงื่อนไขที่จะ “mark used” และ “ไม่ให้ verify ซ้ำ”
    // แต่ตาม requirement ของคุณคือ ใช้ได้จนหมดอายุ จึงปล่อยผ่าน

    return res.json({
      ok: true,
      valid: true,
      key: ticket.key,
      expires_at: ticket.expires_at,
      reusable: ticket.reusable
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
