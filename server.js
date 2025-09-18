// UFO HUB X — Key Server (strict verify for all UIs)
// โหมดตอบกลับ:
//   - เริ่มต้น: text/plain → "VALID" หรือ "INVALID"
//   - JSON: ใส่ ?format=json  → { ok:true, valid:true/false, expires_at, reason }
// ใช้กับ UI เก่า/ใหม่ได้หมด

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ================== CONFIG ==================
const PORT              = process.env.PORT || 3000;
const PUBLIC_DIR        = path.join(__dirname, "public");
const DATA_FILE         = path.join(__dirname, "issued.json");
const EXPIRES_DEFAULT_S = 48 * 3600; // 48 ชม.
const KEY_PREFIX        = "UFO-";
const KEY_SUFFIX        = "-48H";
const RAND_LEN          = 8;

// Allow-list ให้ผ่านเสมอ (ซิงก์กับ UI)
const ALLOW_KEYS = {
  "JJJMAX":                { reusable: true, ttl: EXPIRES_DEFAULT_S },
  "GMPANUPHONGARTPHAIRIN": { reusable: true, ttl: EXPIRES_DEFAULT_S },
};

// ================== HELPERS ==================
function nowSec(){ return Math.floor(Date.now()/1000); }
function normKey(s){
  return String(s||"").replace(/\s+/g,"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
}
function randPart(n){
  const chars="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const b=crypto.randomBytes(n);
  return Array.from(b, v=>chars[v%chars.length]).slice(0,n).join("");
}
function makeHumanKey(){
  return KEY_PREFIX + randPart(RAND_LEN) + KEY_SUFFIX; // เช่น UFO-AB12CD34-48H
}

// โครงสร้างเก็บในไฟล์ (อ่านง่าย)
function ensureDataFile(){
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
}
function loadIssued(){
  try{
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")||"{}");
    const byNorm = {};
    for (const human in raw){
      const v = raw[human]||{};
      const nk = normKey(human);
      if (!nk) continue;
      byNorm[nk] = {
        key: v.key || human,
        usedBy: v.usedBy || v.uid || null,
        place: v.place || null,
        expiresAt: Number(v.expiresAt)||0,
      };
    }
    return byNorm;
  }catch{ return {}; }
}
function saveIssued(map){
  const out = {};
  for (const nk in map){
    const m = map[nk];
    out[m.key] = { key:m.key, usedBy:m.usedBy, place:m.place, expiresAt:m.expiresAt };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2), "utf8");
}
ensureDataFile();
let issuedByNorm = loadIssued();

function isExpired(meta){ return !meta || !meta.expiresAt || nowSec() > Number(meta.expiresAt); }
function findActiveKeyFor(uid){
  if (!uid) return null;
  for (const nk in issuedByNorm){
    const m = issuedByNorm[nk];
    if (m.usedBy===uid && !isExpired(m)) return m;
  }
  return null;
}

// ================== APP ==================
const app = express();
app.set("trust proxy", 1);
app.use(cors()); // Roblox/เว็บ เรียกได้
app.use(express.json({ limit:"256kb" }));

// เสิร์ฟหน้าเว็บ (ถ้ามี)
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req,res)=>{
  const idx = path.join(PUBLIC_DIR,"index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.type("text/plain").send("UFO HUB X Key Server");
});

// health
app.get("/health", (_req,res)=> res.json({ ok:true, ts:Date.now() }));

// ============ API ============
// ออกคีย์ (ถ้ามีของเก่า/ยังไม่หมดอายุ จะคืนอันเดิม)
app.get("/getkey", (req,res)=>{
  const uid   = String(req.query.uid||"").trim() || null;
  const place = String(req.query.place||"").trim() || null;

  const existing = findActiveKeyFor(uid);
  if (existing){
    return res.json({
      ok:true, key:existing.key, expires_at:existing.expiresAt,
      ttl: Math.max(0, existing.expiresAt - nowSec()), note:"existing_key"
    });
  }

  let human = makeHumanKey();
  let nk = normKey(human);
  let guard = 0;
  while (issuedByNorm[nk] && guard++<10) { human=makeHumanKey(); nk=normKey(human); }

  const exp = nowSec()+EXPIRES_DEFAULT_S;
  issuedByNorm[nk] = { key:human, usedBy:uid, place, expiresAt:exp };
  saveIssued(issuedByNorm);

  return res.json({ ok:true, key:human, expires_at:exp, ttl:EXPIRES_DEFAULT_S });
});

// ตรวจคีย์ — ค่าเริ่มต้น “STRICT TEXT MODE” กันพลาด UI เก่า
//   - ถ้าไม่ใส่อะไร → ตอบ "VALID" หรือ "INVALID" (text/plain)
//   - ถ้า ?format=json → ตอบ JSON { ok, valid, expires_at, reason }
app.get("/verify", (req,res)=>{
  const rawKey = String(req.query.key||"");
  const uid    = String(req.query.uid||"").trim() || null;
  const format = String(req.query.format||"").toLowerCase() === "json" ? "json" : "text";

  const sendText = (isValid)=>{
    // อย่ามีคำว่า ok/true/false ปนในข้อความอื่น เพื่อกัน UI เก่าหลุด
    res.type("text/plain").send(isValid ? "VALID" : "INVALID");
  };
  const sendJson = (obj)=> res.json(obj);

  if (!rawKey){
    return (format==="json")
      ? sendJson({ ok:false, valid:false, reason:"no_key" })
      : sendText(false);
  }

  const nk = normKey(rawKey);

  // 1) allow-list
  if (ALLOW_KEYS[nk]){
    const exp = nowSec() + Number(ALLOW_KEYS[nk].ttl||EXPIRES_DEFAULT_S);
    return (format==="json")
      ? sendJson({ ok:true, valid:true, expires_at:exp, reason:"allow_list" })
      : sendText(true);
  }

  // 2) keys ที่ออกไปแล้ว
  const meta = issuedByNorm[nk];
  if (!meta){
    return (format==="json")
      ? sendJson({ ok:true, valid:false, reason:"not_found" })
      : sendText(false);
  }
  if (isExpired(meta)){
    return (format==="json")
      ? sendJson({ ok:true, valid:false, reason:"expired", expires_at:meta.expiresAt })
      : sendText(false);
  }
  if (meta.usedBy && uid && meta.usedBy !== uid){
    return (format==="json")
      ? sendJson({ ok:true, valid:false, reason:"already_used_by_other_uid", expires_at:meta.expiresAt })
      : sendText(false);
  }

  return (format==="json")
    ? sendJson({ ok:true, valid:true, expires_at:meta.expiresAt })
    : sendText(true);
});

// ต่ออายุคีย์ (+48 ชม.)
app.get("/extend", (req,res)=>{
  const rawKey = String(req.query.key||"");
  if (!rawKey) return res.json({ ok:false, reason:"no_key" });
  const nk = normKey(rawKey);
  const meta = issuedByNorm[nk];
  if (!meta) return res.json({ ok:false, reason:"not_found" });

  const base = Math.max(nowSec(), Number(meta.expiresAt)||0);
  meta.expiresAt = base + EXPIRES_DEFAULT_S;
  saveIssued(issuedByNorm);

  res.json({ ok:true, key:meta.key, expires_at:meta.expiresAt });
});

// (ดีบั๊ก) ดูรายการคีย์ (แนะนำปิดบนโปรดักชัน)
app.get("/issued", (_req,res)=>{
  const out = {};
  for (const nk in issuedByNorm){
    const m = issuedByNorm[nk];
    out[m.key] = { usedBy:m.usedBy, place:m.place, expires_at:m.expiresAt };
  }
  res.json(out);
});

// 404/json
app.use((_req,res)=> res.status(404).json({ error:"not_found" }));
app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).json({ error:"internal_error" }); });

app.listen(PORT, ()=> console.log(`[KEY-SERVER] listening on ${PORT}`));
