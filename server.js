// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ISSUED_FILE = path.join(__dirname, "issued.json"); // บันทึกคีย์ที่ออกแล้ว (ถาวรข้ามรีสตาร์ท)

const EXPIRES_DEFAULT = 48 * 3600; // อายุคีย์ 48 ชั่วโมง (วินาที)
const KEY_PREFIX = "UFO-";
const KEY_SUFFIX = "-48H";
const RAND_LEN = 8;              // ความยาวส่วนสุ่มกลาง
const MAX_GEN_ATTEMPTS = 8;

const app = express();
app.use(cors());
app.use(express.json());

// ===== NEW: เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public =====
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
function loadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return (raw && JSON.parse(raw)) || fallback;
  } catch (e) {
    console.error("loadJSON error", p, e);
    return fallback;
  }
}
function saveJSON(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveJSON error", p, e);
  }
}

// โครงสร้าง: issued = { "<KEY>": { usedBy:"<uid>", expiresAt:<unix>, reusable:false } }
const issued = loadJSON(ISSUED_FILE, {});

// สุ่มตัวอักษร A-Z0-9
function randPart(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}
function makeKey() {
  return KEY_PREFIX + randPart(RAND_LEN) + KEY_SUFFIX;
}
function isExpired(meta) {
  if (!meta || !meta.expiresAt) return true;
  return Math.floor(Date.now() / 1000) > meta.expiresAt;
}
function findActiveKeyForUid(uid) {
  for (const k of Object.keys(issued)) {
    const m = issued[k];
    if (m.usedBy && String(m.usedBy) === String(uid) && !isExpired(m)) {
      return { key: k, meta: m };
    }
  }
  return null;
}
function generateUniqueKey() {
  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const k = makeKey();
    if (!issued[k]) return k;
  }
  // fallback (แทบไม่ถึง)
  let i = 0;
  while (true) {
    const k = KEY_PREFIX + randPart(RAND_LEN - 2) + ("Z" + i) + KEY_SUFFIX;
    if (!issued[k]) return k;
    i++;
  }
}

// ---------- routes ----------

// ===== NEW: root "/" ส่งหน้าเว็บ =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// แจกคีย์: /getkey?uid=...&place=...
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "").trim() || null;
  const now = Math.floor(Date.now() / 1000);

  // ถ้ามีคีย์ที่ยังไม่หมดอายุผูกกับ uid นี้อยู่แล้ว → คืนคีย์เดิม
  if (uid) {
    const found = findActiveKeyForUid(uid);
    if (found) {
      return res.json({
        ok: true,
        key: found.key,
        ttl: Math.max(0, (found.meta.expiresAt - now)),
        expires_at: found.meta.expiresAt,
        reusable: !!found.meta.reusable,
        note: "existing_active_for_uid"
      });
    }
  }

  // สร้างคีย์ใหม่แบบไม่ซ้ำ
  const key = generateUniqueKey();
  const exp = now + EXPIRES_DEFAULT;

  issued[key] = { usedBy: uid || null, expiresAt: exp, reusable: false };
  saveJSON(ISSUED_FILE, issued);

  res.json({ ok: true, key, ttl: EXPIRES_DEFAULT, expires_at: exp, reusable: false });
});

// ตรวจคีย์: /verify?key=...&uid=...&place=...
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;

  if (!key) return res.status(400).json({ ok:false, valid:false, reason:"no_key" });

  const meta = issued[key];
  const now = Math.floor(Date.now() / 1000);

  if (!meta) {
    return res.json({ ok:true, valid:false, reason:"not_found" });
  }

  if (meta.reusable) {
    meta.expiresAt = now + EXPIRES_DEFAULT;
    if (uid) meta.usedBy = uid;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:true, expires_at: meta.expiresAt, reason:null, meta:{bound_uid:meta.usedBy}});
  }

  if (now > (meta.expiresAt || 0)) {
    meta.usedBy = uid || meta.usedBy || null;
    meta.expiresAt = now + EXPIRES_DEFAULT;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, reason:"reissued_after_expire", meta:{bound_uid:meta.usedBy}});
  }

  if (meta.usedBy && uid && meta.usedBy !== uid) {
    return res.json({ ok:true, valid:false, reason:"already_used_by_someone", expires_at: meta.expiresAt });
  }

  return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, reason:null, meta:{bound_uid:meta.usedBy || uid}});
});

// debug (อย่าเปิดสาธารณะในโปรดักชัน)
app.get("/issued", (req, res) => {
  res.json({ ok:true, count:Object.keys(issued).length, issued });
});

app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
