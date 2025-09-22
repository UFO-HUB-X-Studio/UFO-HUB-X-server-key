// server.js
// UFO-HUB-X Key Server (HMAC-signed tokens + minimal state)
// Endpoints:
//   GET /                       -> index.html (simple key-get page)
//   GET /getkey?uid=&place=     -> issue a signed key (and record latest to issued.json)
//   GET /verify?key=&uid=&place=-> stateless verify via HMAC (+ expiry)
//   GET /extend?uid=&place=[&sec=SECONDS]  -> extend latest key (returns new key)
//   GET /status?uid=&place=     -> read latest key status from issued.json

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Settings ======
const DEFAULT_TTL = Number(process.env.DEFAULT_TTL || 48*3600); // 48h
const SECRET = process.env.SECRET || "CHANGE_ME_TO_A_RANDOM_SECRET_64B"; // !!! เปลี่ยนจริงจัง
const STORE_FILE = path.join(__dirname, "issued.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ====== helpers ======
function loadStore(){
  try { return JSON.parse(fs.readFileSync(STORE_FILE,"utf8")||"{}"); }
  catch { return {}; }
}
function saveStore(obj){
  fs.writeFileSync(STORE_FILE, JSON.stringify(obj,null,2), "utf8");
}
function b64url(buf){
  return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function b64urlDecode(s){
  s = String(s).replace(/-/g,"+").replace(/_/g,"/");
  while(s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
function sign(payloadStr){
  return crypto.createHmac("sha256", SECRET).update(payloadStr).digest();
}
function now(){ return Math.floor(Date.now()/1000); }

// Key format: UFO-<payload>.<sig>-48H
// payload = b64url(JSON {uid,place,exp,i})
// sig = b64url(HMAC_SHA256(payload))
// Note: ความยาวจะมากกว่า 8 ตัวอักษร แต่แลกกับการยืนยันที่เสถียรแบบไม่ต้องอ่านไฟล์
function makeKey(uid, place, exp, i){
  const payloadObj = { uid, place, exp, i };
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = b64url(sign(payload));
  return `UFO-${payload}.${sig}-48H`;
}
function parseKey(k){
  if(!k) return null;
  let s = String(k).trim().toUpperCase();
  // รับทั้งใส่/ไม่ใส่ prefix/suffix
  s = s.replace(/^UFO-/, "").replace(/-48H$/, "");
  const parts = s.split(".");
  if(parts.length !== 2) return null;
  try{
    const payloadBuf = b64urlDecode(parts[0]);
    const payload = JSON.parse(payloadBuf.toString("utf8"));
    const sig = parts[1];
    return { payloadRaw: parts[0], payload, sig };
  }catch{ return null; }
}
function verifyKeyFor(uid, place, key){
  const parsed = parseKey(key);
  if(!parsed) return { ok:false, reason:"format" };
  const { payloadRaw, payload, sig } = parsed;
  if(!payload || payload.uid!==String(uid) || payload.place!==String(place)) {
    return { ok:false, reason:"mismatch" };
  }
  const sigCheck = b64url(sign(payloadRaw));
  if(sig !== sigCheck) return { ok:false, reason:"signature" };
  const t = now();
  if(t > Number(payload.exp||0)) return { ok:false, reason:"expired", exp: payload.exp };
  return { ok:true, exp: Number(payload.exp), i: payload.i };
}

// ========== Static ==========
app.use(express.static(PUBLIC_DIR));
app.use((req,res,next)=>{
  const api = ["/getkey","/verify","/extend","/status"].some(p=>req.path.startsWith(p));
  if(api) res.type("application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// ========== GET / (simple page) ==========
app.get("/", (req,res)=>{
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ========== GET /getkey ==========
app.get("/getkey", (req,res)=>{
  const uid = String(req.query.uid||"").trim();
  const place = String(req.query.place||"").trim();
  const ttl = Number(req.query.ttl||DEFAULT_TTL) || DEFAULT_TTL;
  if(!uid || !place) return res.status(400).json({ok:false, reason:"missing_uid_or_place"});

  const store = loadStore();
  const id = `${uid}:${place}`;
  const t = now();
  const exp = t + ttl;

  // เพิ่มตัวเลข i (issue counter) กัน key เก่าซ้ำกันเวลา extend หลายครั้ง
  const prev = store[id];
  const i = (prev && typeof prev.i === "number") ? (prev.i+1) : 1;

  const key = makeKey(uid, place, exp, i);

  store[id] = { uid, place, key, exp, issued_at: t, i };
  saveStore(store);

  return res.json({ ok:true, key, uid, place, expires_at: exp, issued_at: t, i });
});

// ========== GET /verify ==========
app.get("/verify", (req,res)=>{
  const uid = String(req.query.uid||"").trim();
  const place = String(req.query.place||"").trim();
  const key = String(req.query.key||"").trim();
  if(!uid || !place || !key) return res.status(400).json({ok:false, valid:false, reason:"missing_params"});

  const vr = verifyKeyFor(uid, place, key);
  if(!vr.ok){
    return res.json({ ok:true, valid:false, reason:vr.reason, expires_at: vr.exp||null });
  }
  return res.json({ ok:true, valid:true, expires_at: vr.exp, i: vr.i });
});

// ========== GET /extend ==========
app.get("/extend", (req,res)=>{
  const uid = String(req.query.uid||"").trim();
  const place = String(req.query.place||"").trim();
  const add = Number(req.query.sec||0) || (5*60*60); // +5h by default
  if(!uid || !place) return res.status(400).json({ok:false, reason:"missing_uid_or_place"});

  const store = loadStore();
  const id = `${uid}:${place}`;
  const rec = store[id];
  if(!rec) return res.status(404).json({ok:false, reason:"no_ticket"});

  const t = now();
  let baseExp = rec.exp;
  if(t > baseExp) return res.json({ok:false, reason:"already_expired", expired_at: baseExp});

  const newExp = baseExp + add;
  const i = (typeof rec.i==="number") ? (rec.i+1) : 1;
  const key = makeKey(uid, place, newExp, i);

  store[id] = { uid, place, key, exp: newExp, issued_at: rec.issued_at || t, i };
  saveStore(store);

  return res.json({ ok:true, key, uid, place, new_expires_at: newExp, added: add, i });
});

// ========== GET /status ==========
app.get("/status", (req,res)=>{
  const uid = String(req.query.uid||"").trim();
  const place = String(req.query.place||"").trim();
  if(!uid || !place) return res.status(400).json({ok:false, reason:"missing_uid_or_place"});

  const store = loadStore();
  const id = `${uid}:${place}`;
  const rec = store[id];
  if(!rec) return res.json({ok:false, reason:"no_ticket"});

  const t = now();
  const left = Math.max(0, Number(rec.exp) - t);
  return res.json({
    ok:true, uid, place, key: rec.key, issued_at: rec.issued_at, expires_at: rec.exp, remaining: left, i: rec.i
  });
});

// ===== start =====
app.listen(PORT, "0.0.0.0", ()=> {
  console.log("UFO-HUB-X key server running on :"+PORT);
});
