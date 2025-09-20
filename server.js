// UFO-HUB-X Key Server (Persist issued keys + real expiry)
// Endpoints:
//   GET /getkey?uid=123&place=999
//   GET /verify?key=UFO-KEY-AAA111&uid=123&place=999

const express = require("express");
const fs = require("fs");
const path = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ✅ อนุญาต CORS เฉพาะหัว Access-Control (ไม่ไปบังคับ Content-Type ทั้งเว็บ)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// ✅ เสิร์ฟไฟล์หน้าเว็บจาก /public
app.use(express.static(path.join(__dirname, "public")));

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

// ✅ หน้าเว็บหลัก → ส่ง index.html (ไม่ใช่ JSON)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------- GETKEY (idempotent + random from pool) ----------------------
app.get("/getkey", (req, res) => {
  res.type("application/json"); // ตั้ง Content-Type แค่สำหรับ API นี้

  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();

  if (!uid || !place) {
    return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });
  }

  try {
    const config = loadConfig();
    const issued = loadIssued();
    const now    = Math.floor(Date.now()/1000);
    const id     = `${uid}:${place}`;

    // ถ้ามีบัตรเก่าและยังไม่หมดอายุ → คืนคีย์เดิม
    const ticket = issued[id];
    if (ticket && ticket.expires_at && now < ticket.expires_at) {
      return res.json({
        ok: true,
        uid, place,
        key: ticket.key,
        expires_at: ticket.expires_at,
        reused: true
      });
    }

    // เลือกคีย์แบบสุ่มจาก pool ใน config
    const pool = (config.keys || []).filter(k => k && k.key);
    if (!pool.length) {
      return res.status(500).json({ ok:false, reason:"no_keys_in_config" });
    }
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const ttl = Number(chosen.ttl || config.expires_default || 172800);
    const exp = now + ttl;

    issued[id] = {
      key: chosen.key,
      uid,
      place,
      issued_at: now,
      expires_at: exp,
      reusable: !!chosen.reusable
    };
    saveIssued(issued);

    return res.json({
      ok: true,
      uid, place,
      key: chosen.key,
      expires_at: exp,
      reused: false
    });
  } catch (err) {
    console.error("getkey error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------- VERIFY (respect issued.json first) ----------------------
app.get("/verify", (req, res) => {
  res.type("application/json"); // ตั้ง Content-Type แค่สำหรับ API นี้

  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  const key   = String(req.query.key   || "").trim();

  if (!uid || !place || !key) {
    return res.status(400).json({ ok:false, reason:"missing_uid_place_or_key" });
  }

  try {
    const now    = Math.floor(Date.now()/1000);
    const issued = loadIssued();
    const id     = `${uid}:${place}`;

    // ตรวจสอบจาก issued.json ก่อน
    const ticket = issued[id];
    if (ticket) {
      if (key !== ticket.key) {
        return res.json({ ok:true, valid:false, reason:"key_mismatch_for_uid_place" });
      }
      if (now > ticket.expires_at) {
        return res.json({ ok:true, valid:false, reason:"expired", expired_at: ticket.expires_at });
      }
      return res.json({
        ok:true,
        valid:true,
        key:ticket.key,
        expires_at:ticket.expires_at,
        reusable:ticket.reusable
      });
    }

    // ถ้ายังไม่มีบัตร → ตรวจจาก config แล้วออกบัตรใหม่
    const config = loadConfig();
    const found  = (config.keys || []).find(k => k.key === key);
    if (found) {
      const ttl = Number(found.ttl || config.expires_default || 172800);
      const exp = now + ttl;
      issued[id] = {
        key,
        uid,
        place,
        issued_at: now,
        expires_at: exp,
        reusable: !!found.reusable
      };
      saveIssued(issued);
      return res.json({ ok:true, valid:true, key, expires_at: exp, reusable: !!found.reusable });
    }

    return res.json({ ok:true, valid:false, reason:"invalid_key" });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
