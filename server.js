// UFO-HUB-X Key Server (Persist issued keys + real expiry)
// Endpoints:
//   GET /getkey?uid=123&place=999
//   GET /verify?key=UFO-KEY-AAA111&uid=123&place=999

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

// ---------------------- GETKEY (idempotent per uid+place) ----------------------
app.get("/getkey", (req, res) => {
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

    // 1) ถ้ามี “บัตรคีย์เดิม” และยังไม่หมดอายุ → คืนคีย์เดิม (idempotent)
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

    // 2) ถ้ายังไม่มีบัตร → สร้างบัตรใหม่จาก config
    //    (เลือกตัวแรก หรือจะสุ่มก็ได้ แต่ให้ TTL ตาม config)
    const first = (config.keys && config.keys[0]) ? config.keys[0] : null;
    if (!first || !first.key) {
      return res.status(500).json({ ok:false, reason:"no_keys_in_config" });
    }
    const ttl = Number(first.ttl || config.expires_default || 172800);
    const exp = now + ttl;

    issued[id] = {
      key: first.key,
      uid,
      place,
      issued_at: now,
      expires_at: exp,
      reusable: !!first.reusable
    };
    saveIssued(issued);

    return res.json({
      ok: true,
      uid, place,
      key: first.key,
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

    // 1) ถ้ามี “บัตรคีย์” สำหรับ uid+place อยู่แล้ว → ใช้บัตรนั้นตัดสินเป็นหลัก
    const ticket = issued[id];
    if (ticket) {
      if (key !== ticket.key) {
        // มีบัตรอยู่ แต่คีย์ไม่ตรง → ไม่ผ่าน (ต้องใช้คีย์ตามบัตร)
        return res.json({ ok:true, valid:false, reason:"key_mismatch_for_uid_place" });
      }
      if (now > ticket.expires_at) {
        return res.json({ ok:true, valid:false, reason:"expired", expired_at: ticket.expires_at });
      }
      return res.json({ ok:true, valid:true, key:ticket.key, expires_at:ticket.expires_at, reusable:ticket.reusable });
    }

    // 2) ถ้ายัง “ไม่มีบัตร” แต่ key นี้มีใน config → อนุญาตสร้างบัตรครั้งแรก ณ ตอน verify
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

    // 3) ไม่พบทั้งใน issued และ config → ไม่ผ่าน
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
