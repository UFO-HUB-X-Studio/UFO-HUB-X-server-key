// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ---------- No-cache (กันเว็บเก่าค้าง) ----------
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.setHeader('Surrogate-Control','no-store');
  next();
});

// ---------- Static (เสิร์ฟหน้าเว็บเดิม) ----------
app.use(express.static('public', { extensions: ['html'] }));

// ---------- DB (ไฟล์ JSON แบบทนหาย) ----------
const DB_DIR  = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'keys.json');

function ensureDB(){
  if(!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive:true });
  if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({keys:{}}), 'utf8');
  let raw = fs.readFileSync(DB_FILE,'utf8');
  if(!raw || !raw.trim()){
    raw = JSON.stringify({keys:{}});
    fs.writeFileSync(DB_FILE, raw, 'utf8');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    parsed = {keys:{}};
    fs.writeFileSync(DB_FILE, JSON.stringify(parsed), 'utf8');
  }
  if(!parsed.keys) parsed.keys = {};
  return parsed;
}
function saveDB(db){
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); }
  catch(e){ console.log('WARN: cannot save DB (ephemeral FS on free plan). Using memory only.'); }
}

// หน่วยช่วยคำนวณเวลา
const HOUR = 3600 * 1000;
const BASE_HOURS = 48;  // อายุคีย์เริ่มต้น 48 ชม
const EXTEND_HOURS = 5; // ต่อครั้งละ +5 ชม
const COOLDOWN_MS = 2 * 60 * 1000; // คูลดาวน์ขอคีย์ใหม่ 2 นาที/ไอพี

// หน่วยจำคูลดาวน์ในเมมโมรี (รองรับเฟรีเรนเดอร์)
const cooldown = new Map();

function makeKey(){
  // คีย์อ่านง่าย
  const body = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g,'').slice(0,8);
  return `UFO-HUB-X-${body}`;
}
function now(){ return Date.now(); }

// ---------- API ----------

// ขอคีย์ใหม่ (1 คน/ไอพี ต่อครั้ง – คูลดาวน์ 2 นาที)
app.post('/api/getkey', (req,res)=>{
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const ua = (req.headers['user-agent']||'').slice(0,120);

  const cd = cooldown.get(ip);
  if(cd && now() < cd) {
    const left = Math.ceil((cd - now())/1000);
    return res.status(429).json({ ok:false, error:'cooldown', secondsLeft:left });
  }

  const db = ensureDB();

  // 1 คน 1 คีย์ (ต่อวัน) — ผูกจาก ip+ua (ง่ายสุด)
  let existing = Object.values(db.keys).find(k => k.ip===ip && k.ua===ua && k.expiresAt>now());
  if(existing){
    cooldown.set(ip, now()+COOLDOWN_MS);
    return res.json({ ok:true, key: existing.key, expiresAt: existing.expiresAt });
  }

  const key = makeKey();
  const expiresAt = now() + BASE_HOURS * HOUR;

  db.keys[key] = { key, issuedAt: now(), expiresAt, ip, ua, extends: 0 };
  saveDB(db);

  cooldown.set(ip, now()+COOLDOWN_MS);
  res.json({ ok:true, key, expiresAt });
});

// ตรวจคีย์
app.get('/api/check/:key', (req,res)=>{
  const key = req.params.key;
  const db = ensureDB();
  const rec = db.keys[key];
  if(!rec) return res.json({ ok:true, valid:false, secondsLeft:0 });
  const secondsLeft = Math.max(0, Math.floor((rec.expiresAt - now())/1000));
  res.json({ ok:true, valid: secondsLeft>0, secondsLeft });
});

// ต่อเวลา +5H
app.post('/api/extend/:key', (req,res)=>{
  const key = req.params.key;
  const db = ensureDB();
  const rec = db.keys[key];
  if(!rec) return res.status(404).json({ ok:false, error:'not_found' });

  if(rec.expiresAt <= now()) return res.status(400).json({ ok:false, error:'expired' });

  rec.expiresAt += EXTEND_HOURS * HOUR;
  rec.extends = (rec.extends||0) + 1;
  saveDB(db);

  const secondsLeft = Math.max(0, Math.floor((rec.expiresAt - now())/1000));
  res.json({ ok:true, secondsLeft });
});

// Fallback เสิร์ฟ index.html (รองรับ SPA/ลิงก์ตรง)
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','index.html'));
});

// Start
app.listen(PORT, ()=> {
  console.log(`UFO HUB X Key API listening on :${PORT}`);
});
