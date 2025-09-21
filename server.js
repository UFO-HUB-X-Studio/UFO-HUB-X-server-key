// UFO-HUB-X Key Server + Image Proxy (Discord CDN) — Extended Version
// Endpoints:
//   GET /                     -> หน้าเว็บ (index.html)
//   GET /getkey?uid=&place=   -> สุ่ม/คืนคีย์จาก uid:place
//   GET /verify?key=&uid=&place=
//   GET /extend?uid=&place=   -> ต่อเวลา +5h
//   GET /status?uid=&place=   -> ดูเวลาที่เหลือ
//   GET /img/profile, /img/bg -> proxy Discord images

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
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

/* ---------- Discord image URLs ---------- */
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

/* ---------- Web ---------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------- API: GETKEY ---------- */
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  if (!uid || !place) return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });

  try {
    const config = loadConfig();
    const issued = loadIssued();
    const now    = Math.floor(Date.now()/1000);
    const id     = `${uid}:${place}`;

    // ถ้ามี key แล้ว และยังไม่หมด → ใช้ key เดิม
    const ticket = issued[id];
    if (ticket && now < ticket.expires_at) {
      return res.json({ ok:true, reused:true, ...ticket });
    }

    // เลือก key จาก config
    const pool = (config.keys || []).filter(k => k && k.key);
    if (!pool.length) return res.status(500).json({ ok:false, reason:"no_keys_in_config" });
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const ttl = Number(chosen.ttl || config.expires_default || 172800);
    const exp = now + ttl;

    // bind key ให้ uid:place (ไม่สำคัญว่า key จะซ้ำกับคนอื่น)
    issued[id] = { key:chosen.key, uid, place, issued_at:now, expires_at:exp };
    saveIssued(issued);

    return res.json({ ok:true, reused:false, ...issued[id] });
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
      if (now > ticket.expires_at) {
        return res.json({ ok:true, valid:false, expired:true, expired_at:ticket.expires_at });
      }
      return res.json({ ok:true, valid:true, expires_at:ticket.expires_at });
    }
    return res.json({ ok:true, valid:false, reason:"invalid_or_mismatch" });
  } catch (e) {
    console.error("verify error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- API: EXTEND (ต่อเวลา +5h) ---------- */
app.get("/extend", (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  if (!uid || !place) return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });

  try {
    const issued = loadIssued();
    const id     = `${uid}:${place}`;
    const now    = Math.floor(Date.now()/1000);
    const ticket = issued[id];
    if (!ticket) return res.status(404).json({ ok:false, reason:"no_ticket" });
    if (now > ticket.expires_at) return res.json({ ok:false, reason:"already_expired" });

    ticket.expires_at += 5*60*60; // +5 ชั่วโมง
    saveIssued(issued);
    return res.json({ ok:true, new_expires_at:ticket.expires_at });
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
    const left = Math.max(0, ticket.expires_at - now);
    return res.json({ ok:true, key:ticket.key, expires_at:ticket.expires_at, remaining:left });
  } catch (e) {
    console.error("status error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
