const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// โหลดคีย์จากไฟล์
const KEY_FILE = path.join(__dirname, "keys.json");
function loadKeyConfig() {
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[KEY-SERVER] Cannot read keys.json", e);
    return { expires_default: 172800, keys: [] }; // default 48h
  }
}
let config = loadKeyConfig();

// in-memory: จดสถานะคีย์ที่จ่าย/ใช้แล้ว
// keyString -> { usedBy, expiresAt, reusable }
const issued = new Map();

const app = express();
app.use(cors());
app.use(express.json());

// health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});

// (ทางเลือก) แจกคีย์แบบสุ่ม สำหรับหน้าเว็บ "กดรับคีย์"
app.get("/getkey", (req, res) => {
  const available = config.keys.filter(k => {
    const st = issued.get(k.key);
    if (!st) return true;               // ยังไม่เคยออก
    if (k.reusable) return true;        // ออกซ้ำได้
    return (Date.now()/1000) > (st.expiresAt || 0); // หมดอายุแล้ว -> วนกลับมาแจกได้
  });

  if (available.length === 0) {
    return res.json({ ok: true, key: null, message: "out_of_stock" });
  }
  const pick = available[Math.floor(Math.random() * available.length)];
  res.json({
    ok: true,
    key: pick.key,
    ttl: pick.ttl ?? config.expires_default,
    reusable: !!pick.reusable
  });
});

// ยืนยันคีย์ (Roblox ฝั่ง UI Key จะเรียก endpoint นี้)
app.get("/verify", (req, res) => {
  const key   = String(req.query.key || "").trim();
  const uid   = String(req.query.uid || "").trim();    // Roblox userId (ควรส่งมา)
  const place = String(req.query.place || "").trim();  // PlaceId (optional)

  if (!key) return res.status(400).json({ ok:false, valid:false, reason:"no_key" });

  // หาในฐานคีย์
  const kMeta = config.keys.find(k => k.key === key);
  if (!kMeta) {
    return res.json({ ok:true, valid:false, reason:"not_found" });
  }

  const ttl      = typeof kMeta.ttl === "number" ? kMeta.ttl : (config.expires_default || 172800);
  const reusable = !!kMeta.reusable;
  const now      = Math.floor(Date.now()/1000);

  const st = issued.get(key);
  if (!st) {
    // ยังไม่เคยใช้ -> ออกตั๋วให้
    const exp = now + ttl;
    issued.set(key, { usedBy: uid || null, expiresAt: exp, reusable });
    return res.json({
      ok:true, valid:true, reusable, expires_at: exp, reason:null,
      meta: { bound_uid: uid || null, place: place || null }
    });
  }

  // เคยมีแล้ว
  if (reusable) {
    // ใช้ซ้ำได้ -> ต่ออายุให้
    const exp = now + ttl;
    issued.set(key, { usedBy: st.usedBy || uid || null, expiresAt: exp, reusable });
    return res.json({
      ok:true, valid:true, reusable:true, expires_at: exp, reason:null,
      meta: { bound_uid: st.usedBy || uid || null, place: place || null }
    });
  } else {
    // ไม่ reusable
    if (now > (st.expiresAt || 0)) {
      // หมดอายุ -> โอนสิทธิ์ให้รายใหม่
      const exp = now + ttl;
      issued.set(key, { usedBy: uid || st.usedBy || null, expiresAt: exp, reusable:false });
      return res.json({
        ok:true, valid:true, reusable:false, expires_at: exp, reason:null,
        meta: { bound_uid: uid || st.usedBy || null, place: place || null }
      });
    } else {
      // ยังไม่หมดอายุ
      if (st.usedBy && uid && st.usedBy !== uid) {
        return res.json({ ok:true, valid:false, reason:"already_used_by_someone", expires_at: st.expiresAt });
      }
      // uid เดิมยังใช้ได้
      return res.json({
        ok:true, valid:true, reusable:false, expires_at: st.expiresAt, reason:null,
        meta: { bound_uid: st.usedBy || null }
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] running on port ${PORT}`);
});
