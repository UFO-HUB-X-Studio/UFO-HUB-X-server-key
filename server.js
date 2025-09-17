const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// === Load keys.json ===
const KEY_FILE = path.join(__dirname, "keys.json");
function loadKeyConfig() {
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[KEY-SERVER] Cannot read keys.json", e);
    return { expires_default: 3600, keys: [] };
  }
}
let config = loadKeyConfig();

// ใช้ in-memory store จดสถานะ (ใช้/หมดอายุ/ผูกกับใคร)
const issued = new Map(); 
// โครงสร้าง:
// issued.set(keyString, { usedBy: "uid", expiresAt: 1700000000, reusable: bool })

const app = express();
app.use(cors());
app.use(express.json());

// health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});

// สุ่ม key แจก (ถ้าต้องการหน้าเว็บกดรับคีย์)
app.get("/getkey", (req, res) => {
  const available = config.keys.filter(k => {
    const st = issued.get(k.key);
    if (!st) return true;
    if (k.reusable) return true;
    return (Date.now()/1000) > (st.expiresAt || 0);
  });
  if (available.length === 0) {
    return res.json({ ok: true, key: null, message: "out_of_stock" });
  }
  const pick = available[Math.floor(Math.random() * available.length)];
  res.json({ ok: true, key: pick.key, ttl: pick.ttl ?? config.expires_default, reusable: !!pick.reusable });
});

// verify key
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim();   // Roblox userId แนะนำให้ส่งมา
  const place = String(req.query.place || "").trim(); // PlaceId (optional)
  if (!key) return res.status(400).json({ ok:false, valid:false, reason:"no_key" });

  // มีในฐานข้อมูลไหม
  const kMeta = config.keys.find(k => k.key === key);
  if (!kMeta) {
    return res.json({ ok:true, valid:false, reason:"not_found" });
  }

  // TTL
  const ttl = typeof kMeta.ttl === "number" ? kMeta.ttl : (config.expires_default || 3600);
  const reusable = !!kMeta.reusable;
  const now = Math.floor(Date.now()/1000);

  // สถานะปัจจุบัน
  const st = issued.get(key);
  if (!st) {
    // ยังไม่เคยใช้ → ออกตั๋วให้
    const exp = now + ttl;
    issued.set(key, { usedBy: uid || null, expiresAt: exp, reusable });
    return res.json({
      ok:true, valid:true, reusable, expires_at: exp, reason:null,
      meta: { bound_uid: uid || null, place: place || null }
    });
  }

  // เคยมีแล้ว
  if (reusable) {
    // reuse ได้เสมอ → ต่ออายุให้เล็กน้อย (ตัวอย่าง)
    const exp = now + ttl;
    issued.set(key, { usedBy: st.usedBy || uid || null, expiresAt: exp, reusable });
    return res.json({
      ok:true, valid:true, reusable:true, expires_at: exp, reason:null,
      meta: { bound_uid: st.usedBy || uid || null, place: place || null }
    });
  } else {
    // ไม่ reusable
    if (now > (st.expiresAt || 0)) {
      // หมดอายุแล้ว → โอนสิทธิให้คนใหม่
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
      // อนุโลมให้ uid เดิมใช้ได้จนหมดอายุ
      return res.json({ ok:true, valid:true, reusable:false, expires_at: st.expiresAt, reason:null, meta: { bound_uid: st.usedBy || null }});
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] running on port ${PORT}`);
});
