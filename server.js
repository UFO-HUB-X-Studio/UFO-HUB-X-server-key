// UFO-HUB-X Key Server + Image Proxy (Discord CDN) — Extended Version (unique keys)
// Endpoints:
//   GET /                               -> index.html
//   GET /getkey?uid=&place=[&force_new=1][&extend=SECONDS]
//   GET /verify?key=&uid=&place=
//   GET /extend?uid=&place=[&sec=SECONDS] (default +5h)
//   GET /status?uid=&place=
//   GET /img/profile, /img/bg           -> proxy Discord images

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const { URL } = require("url");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ---------- Static site ---------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Global headers ---------- */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
app.use((req, res, next) => {
  const api = ["/getkey", "/verify", "/extend", "/status"].some(p => req.path.startsWith(p));
  if (api) res.type("application/json; charset=utf-8");
  next();
});

/* ---------- Discord image URLs (ใส่ของจริงของคุณเองได้) ---------- */
const DISCORD_PROFILE = "https://cdn.discordapp.com/.../20250916_152130.png";
const DISCORD_BG      = "https://cdn.discordapp.com/.../file_00000000385861fab9ee0612cc0dca89.png";

/* ---------- Proxy helper ---------- */
function proxyImage(targetUrl, res) {
  try {
    const u = new URL(targetUrl);
    const req = https.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return proxyImage(r.headers.location, res);
      }
      if (r.statusCode !== 200) {
        res.status(502).type("text/plain").send("bad_gateway_image");
        r.resume(); return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", r.headers["content-type"] || "image/png");
      r.pipe(res);
    });
    req.on("error", () => res.status(502).type("text/plain").send("image_proxy_error"));
  } catch {
    res.status(500).type("text/plain").send("image_proxy_error");
  }
}

/* ---------- Image proxy routes ---------- */
app.get("/img/profile", (req, res) => proxyImage(DISCORD_PROFILE, res));
app.get("/img/bg",       (req, res) => proxyImage(DISCORD_BG, res));

/* ---------- Files & state ---------- */
const CONFIG_PATH = path.join(__dirname, "config.json");
const ISSUED_PATH = path.join(__dirname, "issued.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { keys: [], expires_default: 172800 };
  }
}
function loadIssued() {
  if (!fs.existsSync(ISSUED_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ISSUED_PATH, "utf8") || "{}"); }
  catch { return {}; }
}
function saveIssued(obj) {
  fs.writeFileSync(ISSUED_PATH, JSON.stringify(obj, null, 2), "utf8");
}

/* ---------- Utils: sweep + pick unique key ---------- */
function sweepExpired(issued, now) {
  let changed = false;
  for (const k of Object.keys(issued)) {
    const t = issued[k];
    if (!t || !t.expires_at || now > Number(t.expires_at)) {
      delete issued[k];
      changed = true;
    }
  }
  if (changed) saveIssued(issued);
}

function activeKeyOwners(issued, now) {
  const map = new Map(); // key -> id(uid:place)
  for (const id of Object.keys(issued)) {
    const t = issued[id];
    if (t && t.key && t.expires_at && now < Number(t.expires_at)) {
      map.set(String(t.key), id);
    }
  }
  return map;
}

function chooseFreeKey(configKeys, issuedMap, now, selfId, preferCurrentKey) {
  // อนุญาตให้ใช้ “คีย์เดิมของตัวเอง” ก่อน (ถ้ายังไม่หมด)
  if (preferCurrentKey) {
    const ownerId = issuedMap.get(preferCurrentKey);
    if (!ownerId || ownerId === selfId) return preferCurrentKey;
  }
  // เลือกคีย์ที่ “ยังไม่มีเจ้าของ” (หรือเจ้าของคือเราเอง)
  const pool = (configKeys || []).filter(k => k && k.key);
  const free = pool
    .map(o => o.key)
    .filter(k => {
      const ownerId = issuedMap.get(k);
      return !ownerId || ownerId === selfId;
    });
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}

/* ---------- Web ---------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------- API: GETKEY ---------- */
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  const forceNew   = String(req.query.force_new || "") === "1";
  const extendSecQ = Number(req.query.extend || 0) || 0; // ต่อเวลาพิเศษ (ตอนออกคีย์)
  if (!uid || !place) return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });

  try {
    const config = loadConfig();
    const issued = loadIssued();
    const now    = Math.floor(Date.now()/1000);
    const id     = `${uid}:${place}`;

    // ปัดกวาดของหมดอายุ
    sweepExpired(issued, now);

    const current = issued[id];

    // ถ้า “มีอยู่และยังไม่หมด” และ “ไม่บังคับออกใหม่” → reuse + (ถ้ามี extend ก็ขยายเวลา)
    if (current && now < Number(current.expires_at) && !forceNew) {
      if (extendSecQ > 0) {
        current.expires_at = Number(current.expires_at) + Math.max(0, extendSecQ);
        saveIssued(issued);
      }
      return res.json({
        ok:true, reused:true, key:current.key, uid, place,
        issued_at: current.issued_at, expires_at: current.expires_at,
        extended_by: extendSecQ > 0 ? Math.max(0, extendSecQ) : 0
      });
    }

    // ต้องออกใหม่ (หรือหมดอายุแล้ว)
    const keys  = (config.keys || []).filter(k => k && k.key);
    if (!keys.length) return res.status(500).json({ ok:false, reason:"no_keys_in_config" });

    const issuedMap = activeKeyOwners(issued, now);
    const preferKey = current && current.key; // ถ้าเป็นของเดิมเราและไม่มีใครใช้ ให้เลือกก่อน
    const pickedKey = chooseFreeKey(keys, issuedMap, now, id, preferKey);

    if (!pickedKey) {
      return res.status(503).json({ ok:false, reason:"no_free_key" }); // คีย์ว่างหมด
    }

    // หา meta เพื่อคำนวณ TTL
    const meta = keys.find(k => k.key === pickedKey) || {};
    const ttl  = Number(meta.ttl || config.expires_default || 172800);
    let exp    = now + ttl + Math.max(0, extendSecQ);

    issued[id] = {
      key: pickedKey,
      uid, place,
      issued_at: now,
      expires_at: exp,
      reusable: !!meta.reusable
    };
    saveIssued(issued);

    return res.json({
      ok:true, reused:false, rotated: !!(current && now < Number(current?.expires_at)),
      key: pickedKey, uid, place, issued_at: now, expires_at: exp,
      extended_by: Math.max(0, extendSecQ)
    });
  } catch (e) {
    console.error("getkey error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- API: VERIFY ---------- */
app.get("/verify", (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  const key   = String(req.query.key   || "").trim();
  if (!uid || !place || !key) return res.status(400).json({ ok:false, reason:"missing_uid_place_or_key" });

  try {
    const now    = Math.floor(Date.now()/1000);
    const issued = loadIssued();
    const id     = `${uid}:${place}`;
    const ticket = issued[id];

    if (ticket && ticket.key === key) {
      if (now > Number(ticket.expires_at)) {
        return res.json({ ok:true, valid:false, reason:"expired", expired_at:ticket.expires_at });
      }
      return res.json({ ok:true, valid:true, key:ticket.key, expires_at:ticket.expires_at, reusable:ticket.reusable });
    }
    return res.json({ ok:true, valid:false, reason:"invalid_or_mismatch" });
  } catch (e) {
    console.error("verify error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- API: EXTEND (ต่อเวลา) ---------- */
// /extend?uid=&place=[&sec=SECONDS]  (default = 5h)
app.get("/extend", (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  const secQ  = Number(req.query.sec || 0) || 0;
  const add   = secQ > 0 ? secQ : (5*60*60);
  if (!uid || !place) return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });

  try {
    const issued = loadIssued();
    const id     = `${uid}:${place}`;
    const now    = Math.floor(Date.now()/1000);
    const ticket = issued[id];
    if (!ticket) return res.status(404).json({ ok:false, reason:"no_ticket" });
    if (now > Number(ticket.expires_at)) return res.json({ ok:false, reason:"already_expired", expired_at:ticket.expires_at });

    ticket.expires_at = Number(ticket.expires_at) + add;
    saveIssued(issued);
    return res.json({ ok:true, key:ticket.key, new_expires_at:ticket.expires_at, added:add });
  } catch (e) {
    console.error("extend error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- API: STATUS (ดูเวลาจริง) ---------- */
app.get("/status", (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  if (!uid || !place) return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });

  try {
    const issued = loadIssued();
    const id     = `${uid}:${place}`;
    const now    = Math.floor(Date.now()/1000);
    const ticket = issued[id];
    if (!ticket) return res.json({ ok:false, reason:"no_ticket" });
    const left = Math.max(0, Number(ticket.expires_at) - now);
    return res.json({ ok:true, key:ticket.key, issued_at:ticket.issued_at, expires_at:ticket.expires_at, remaining:left });
  } catch (e) {
    console.error("status error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
