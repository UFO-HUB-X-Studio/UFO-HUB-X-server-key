// UFO-HUB-X Key Server + Image Proxy (Discord CDN) — Max-compat Edition (patched)
// Endpoints (ทั้งหมดใช้ได้):
//   GET /                        -> หน้าเว็บ (public/index.html)
//   GET /getkey?uid=&place=      -> เดิม (ยังคงไว้)
//   GET /verify?key=&uid=&place= -> เดิม (ยังคงไว้)
//   GET /api/getkey              -> alias ของ /getkey
//   GET /api/verify              -> alias ของ /verify
//   GET /img/profile             -> proxy Discord profile
//   GET /img/bg                  -> proxy Discord bg

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ---------- Utils ---------- */
const PUBLIC_DIR  = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "config.json");
const ISSUED_PATH = path.join(__dirname, "issued.json");

function safeReadJSON(p, fallback = {}) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

/* ---------- Static site FIRST ---------- */
app.use(express.static(PUBLIC_DIR, { fallthrough: true, index: "index.html" }));

/* ---------- Global headers ---------- */
// เปิด CORS เฉพาะเส้นทางที่เป็น API/IMG เท่านั้น (ลดผลข้างเคียงกับหน้า html)
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/getkey") || req.path.startsWith("/verify") || req.path.startsWith("/img/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  next();
});
// กำหนด content-type ให้เฉพาะ API (หน้าเว็บยังคง text/html จาก static)
app.use((req, res, next) => {
  const api = req.path.startsWith("/api/") || req.path.startsWith("/getkey") || req.path.startsWith("/verify");
  if (api) res.type("application/json; charset=utf-8");
  next();
});

/* ---------- Discord image URLs ---------- */
const DISCORD_PROFILE = "https://cdn.discordapp.com/attachments/1417098355388973154/1417560447279960194/20250916_152130.png?ex=68cf8acb&is=68ce394b&hm=3c3e5b4819a3d0e07794caa3fc39bafbeee7a3bbc0b35796e16e0e21f663113b&";
const DISCORD_BG      = "https://cdn.discordapp.com/attachments/1417098355388973154/1417560780110434446/file_00000000385861fab9ee0612cc0dca89.png?ex=68cf8b1a&is=68ce399a&hm=f73f6eefa017f23aee5effcad7154a69bafc0b052affd2b558cc5d37e5e3ff9d&";

/* ---------- Proxy helper (แข็งแรงขึ้น) ---------- */
function proxyImage(targetUrl, res) {
  try {
    const u = new URL(targetUrl);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + (u.search || ""),
      protocol: u.protocol,
      headers: {
        "User-Agent": "UFO-HUB-X/1.0 (+https://onrender.com)",
        "Accept": "image/*,*/*;q=0.8",
        "Referer": "https://discord.com/"
      },
      timeout: 8000
    }, (r) => {
      // follow redirect
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
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
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", () => res.status(502).type("text/plain").send("image_proxy_error"));
  } catch {
    res.status(500).type("text/plain").send("image_proxy_error");
  }
}

/* ---------- Image proxy routes ---------- */
app.get("/img/profile", (_req, res) => proxyImage(DISCORD_PROFILE, res));
app.get("/img/bg",      (_req, res) => proxyImage(DISCORD_BG, res));

/* ---------- Files & state ---------- */
function loadConfig() { return safeReadJSON(CONFIG_PATH, { keys: [], expires_default: 172800 }); }
function loadIssued() { return safeReadJSON(ISSUED_PATH, {}); }
function saveIssued(obj){ saveJSON(ISSUED_PATH, obj); }

/* ---------- Web (force index.html บน /) ---------- */
app.get("/", (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    // ไม่ cache หน้า index เพื่ออัปเดต UI ได้ทันที
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(indexPath);
  }
  res.status(200).type("text/html; charset=utf-8")
    .send("<!doctype html><meta charset=utf-8><title>UFO HUB X</title><h1>UFO HUB X</h1><p>Put your index.html into /public</p>");
});

/* ---------- API: GETKEY (เดิม) ---------- */
function handleGetKey(req, res) {
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
}
app.get("/getkey", handleGetKey);
app.get("/api/getkey", handleGetKey); // alias

/* ---------- API: VERIFY (เดิม) ---------- */
function handleVerify(req, res) {
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
      if (key !== ticket.key)      return res.json({ ok:true, valid:false, reason:"key_mismatch_for_uid_place" });
      if (now > ticket.expires_at) return res.json({ ok:true, valid:false, reason:"expired", expired_at:ticket.expires_at });
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
}
app.get("/verify", handleVerify);
app.get("/api/verify", handleVerify); // alias

/* ---------- SPA fallback: เส้นทางอื่นส่ง index.html (กัน 404 หน้าดำ) ---------- */
app.get(/^\/(?!api\/|img\/|getkey$|verify$).*/, (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).type("text/plain").send("index_not_found");
});

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
