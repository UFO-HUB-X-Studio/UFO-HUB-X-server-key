import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs/promises';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 10000;

const DATA_DIR  = path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'keys.json');

const KEY_PREFIX       = 'UFO-HUB-X-';
const DEFAULT_TTL_HRS  = 48;     // อายุคีย์เริ่มต้น
const EXTEND_HRS       = 5;      // ยืดต่อครั้ง
const EXTEND_MAX_DAILY = 2;      // ต่อได้กี่ครั้ง/วัน
const ONE_KEY_PER_FP   = true;   // 1 fingerprint ออกได้ 1 คีย์/วัน

// -------- Middlewares --------
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// rate limit APIs (กันสแปม)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 นาที
  max: 60,             // 60 req/นาที/ไอพี
});
app.use('/api/', apiLimiter);

// เสิร์ฟไฟล์หน้าเว็บ
app.use(express.static(path.join(__dirname, 'public')));

// -------- DB helpers --------
async function ensureDB() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    const init = { keys: {} };
    await fs.writeFile(DB_FILE, JSON.stringify(init, null, 2), 'utf8');
  }
}
async function loadDB() {
  await ensureDB();
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const json = raw.trim() ? JSON.parse(raw) : { keys: {} };
  if (!json.keys) json.keys = {};
  return json;
}
async function saveDB(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// fingerprint จาก IP + UA
function fingerprint(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '')
    .toString().split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '').toString();
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex');
}
function nowMs() { return Date.now(); }
function futureMs(hours) { return nowMs() + hours * 3600 * 1000; }
function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
}
function dailyCounter(obj) {
  const key = todayKey();
  obj.daily = obj.daily || {};
  obj.daily[key] = (obj.daily[key] || 0) + 1;
  return obj.daily[key];
}

// ------------- API -----------------

// POST /api/getkey — ออกคีย์ (จำกัด 1 คน 1 คีย์ต่อวัน)
app.post('/api/getkey', async (req, res) => {
  try {
    const db = await loadDB();
    const fp = fingerprint(req);

    // หา key เดิมที่ยังไม่หมดอายุ & fingerprint ตรง
    let existingKey = null;
    for (const [k, v] of Object.entries(db.keys)) {
      if (v.fingerprint === fp && v.expiresAt > nowMs()) {
        existingKey = k;
        break;
      }
    }
    if (ONE_KEY_PER_FP && existingKey) {
      return res.json({
        ok: true,
        key: existingKey,
        message: 'You already have an active key.'
      });
    }

    // จำกัด “ออกคีย์” วันละ 1 ครั้งต่อ fingerprint
    db.fplog = db.fplog || {};
    const log = db.fplog[fp] || { countByDate:{} };
    const dkey = todayKey();
    if ((log.countByDate[dkey] || 0) >= 1) {
      return res.status(429).json({ ok:false, message:'Daily limit reached' });
    }
    log.countByDate[dkey] = (log.countByDate[dkey] || 0) + 1;
    db.fplog[fp] = log;

    // สร้างคีย์ใหม่
    const token = crypto.randomBytes(8).toString('base64url');
    const key   = KEY_PREFIX + token;
    const exp   = futureMs(DEFAULT_TTL_HRS);

    db.keys[key] = {
      fingerprint: fp,
      issuedAt: nowMs(),
      expiresAt: exp,
      extendCount: 0,
      extendLog: {}
    };
    await saveDB(db);

    res.json({ ok:true, key, expiresAt:exp, ttlHours:DEFAULT_TTL_HRS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, message:'Server error' });
  }
});

// GET /api/check/:key — ตรวจสถานะคีย์
app.get('/api/check/:key', async (req, res) => {
  try {
    const k = req.params.key;
    const db = await loadDB();
    const v  = db.keys[k];
    if (!v) return res.json({ ok:false, status:'NOT_FOUND' });

    const remain = Math.max(0, Math.floor((v.expiresAt - nowMs())/1000));
    const status = (remain>0) ? 'ACTIVE' : 'EXPIRED';
    res.json({ ok:true, status, remainingSeconds: remain, expiresAt: v.expiresAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, message:'Server error' });
  }
});

// POST /api/extend/:key — ยืดเวลา +5h (จำกัดวันละ EXTEND_MAX_DAILY)
app.post('/api/extend/:key', async (req, res) => {
  try {
    const k = req.params.key;
    const db = await loadDB();
    const v  = db.keys[k];
    if (!v) return res.status(404).json({ ok:false, message:'Key not found' });

    // จำกัด fingerprint เดิมเท่านั้นที่ยืดได้
    const fp = fingerprint(req);
    if (v.fingerprint !== fp) {
      return res.status(403).json({ ok:false, message:'Not owner of this key' });
    }

    // จำกัดต่อวัน
    v.extendLog = v.extendLog || {};
    const cnt = dailyCounter(v); // จะเพิ่มในวันนี้
    if (cnt > EXTEND_MAX_DAILY) {
      return res.status(429).json({ ok:false, message: 'Extend limit reached for today' });
    }

    v.expiresAt = Math.max(v.expiresAt, nowMs()) + EXTEND_HRS*3600*1000;
    v.extendCount = (v.extendCount||0) + 1;
    await saveDB(db);

    res.json({ ok:true, addedHours:EXTEND_HRS, newExpiresAt: v.expiresAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, message:'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`UFO HUB X Key API listening on :${PORT}`);
});
