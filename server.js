// UFO-HUB-X Key Server + Image Proxy (Discord CDN) — Max-compat Edition
// Endpoints:
//   GET /                     -> หน้าเว็บ (index.html)
//   GET /getkey?uid=&place=   -> สุ่ม/คืนคีย์จากบัตร uid:place
//   GET /verify?key=&uid=&place=
//   GET /img/profile          -> proxy Discord profile
//   GET /img/bg               -> proxy Discord bg

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ---------- Static site ---------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Global headers (แบบเดิมที่ยาว) ---------- */
// เปิด CORS ให้ทุกโดเมน
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
// ถ้าเป็น API path ให้ตั้ง Content-Type เป็น JSON (หน้าเว็บยังเป็น text/html ปกติ)
app.use((req, res, next) => {
  const api = req.path.startsWith("/getkey") || req.path.startsWith("/verify");
  if (api) res.type("application/json; charset=utf-8");
  next();
});

/* ---------- Discord image URLs ---------- */
const DISCORD_PROFILE = "https://cdn.discordapp.com/attachments/1417098355388973154/1417560447279960194/20250916_152130.png?ex=68cf8acb&is=68ce394b&hm=3c3e5b4819a3d0e07794caa3fc39bafbeee7a3bbc0b35796e16e0e21f663113b&";
const DISCORD_BG      = "https://cdn.discordapp.com/attachments/1417098355388973154/1417560780110434446/file_00000000385861fab9ee0612cc0dca89.png?ex=68cf8b1a&is=68ce399a&hm=f73f6eefa017f23aee5effcad7154a69bafc0b052affd2b558cc5d37e5e3ff9d&";

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
        r.resume();
        return;
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

    const ticket = issued[id];
    if (ticket && ticket.expires_at && now < ticket.expires_at) {
      return res.json({ ok:true, uid, place, key:ticket.key, expires_at:ticket.expires_at, reused:true });
    }

    const pool = (config.keys || []).filter(k => k && k.key);
    if (!pool.length) return res.status(500).json({ ok:false, reason:"no_keys_in_config" });

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const ttl = Number(chosen.ttl || config.expires_default || 172800);
    const exp = now + ttl;

    issued[id] = { key:chosen.key, uid, place, issued_at:now, expires_at:exp, reusable:!!chosen.reusable };
    saveIssued(issued);

    return res.json({ ok:true, uid, place, key:chosen.key, expires_at:exp, reused:false });
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
    if (ticket) {
      if (key !== ticket.key)        return res.json({ ok:true, valid:false, reason:"key_mismatch_for_uid_place" });
      if (now > ticket.expires_at)   return res.json({ ok:true, valid:false, reason:"expired", expired_at:ticket.expires_at });
      return res.json({ ok:true, valid:true, key:ticket.key, expires_at:ticket.expires_at, reusable:ticket.reusable });
    }

    const config = loadConfig();
    const found  = (config.keys || []).find(k => k.key === key);
    if (found) {
      const ttl = Number(found.ttl || config.expires_default || 172800);
      const exp = now + ttl;
      issued[id] = { key, uid, place, issued_at:now, expires_at:exp, reusable:!!found.reusable };
      saveIssued(issued);
      return res.json({ ok:true, valid:true, key, expires_at:exp, reusable:!!found.reusable });
    }
    return res.json({ ok:true, valid:false, reason:"invalid_key" });
  } catch (e) {
    console.error("verify error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
