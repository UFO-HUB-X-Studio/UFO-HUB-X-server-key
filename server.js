// UFO-HUB-X Key Server + Image Proxy (Discord CDN) — Extended Version (unique keys)
// Endpoints:
//   GET /                               -> index.html (simple page to fetch key)
//   GET /getkey?uid=&place=[&force_new=1][&extend=SECONDS]
//   GET /verify?key=&uid=&place=
//   GET /extend?uid=&place=[&sec=SECONDS] (default +5h)
//   GET /status?uid=&place=
//   GET /img/profile, /img/bg           -> proxy Discord images
//
// NOTE:
// - ใช้ config.json (local) +/หรือ CONFIG_URL (remote) เพื่อ list คีย์ที่แจก
// - ฝั่ง Roblox UI: ปุ่ม Submit จะยิง /verify และคาดหวัง field: {ok:true, valid:true, expires_at:...}

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const { URL } = require("url");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ---------- Static site ---------- */
const PUBLIC_DIR = path.join(__dirname, "public");
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use(express.static(PUBLIC_DIR));

/* ---------- Global headers ---------- */
app.use((req, res, next) => {
  // ถ้าจะล็อกโดเมนเว็บเพื่อรายได้ ให้เปลี่ยน "*" เป็นโดเมนของคุณได้
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use((req, res, next) => {
  const api = ["/getkey", "/verify", "/extend", "/status"].some(p => req.path.startsWith(p));
  if (api) res.type("application/json; charset=utf-8");
  next();
});

/* ---------- Discord image URLs (ใส่ของจริงของคุณเองได้) ---------- */
const DISCORD_PROFILE = process.env.D_PROFILE || "https://i.postimg.cc/KcdBP7Fn/20250916-152130.png";
const DISCORD_BG      = process.env.D_BG      || "https://i.postimg.cc/26L3yJ1g/file-00000000385861fab9ee0612cc0dca89.png";

/* ---------- Proxy helper ---------- */
function proxyImage(targetUrl, res) {
  try {
    const u = new URL(targetUrl);
    const req = https.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return proxyImage(r.headers.location, res);
      }
      if (r.statusCode !== 200) {
        res.status(502).type("text/plain").send("bad_gateway_image"); r.resume(); return;
      }
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

// ★★★ เพิ่ม: URL ของ config.json บน GitHub (แก้เป็นของคุณได้/หรือใช้ ENV CONFIG_URL)
const CONFIG_URL = process.env.CONFIG_URL ||
  "https://raw.githubusercontent.com/UFO-HUB-X-Studio/UFO-HUB-X-server-key/refs/heads/main/config.json";

/* ---------- fetch JSON helper ---------- */
function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const to = setTimeout(() => { timedOut = true; reject(new Error("fetch_timeout")); }, timeoutMs);
    try {
      const u = new URL(url);
      https.get(u, { headers: { "Cache-Control": "no-cache" } }, (res) => {
        let raw = "";
        res.on("data", (d) => raw += d);
        res.on("end", () => {
          clearTimeout(to);
          if (timedOut) return;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw || "{}")); }
            catch(e){ reject(new Error("json_parse_error")); }
          } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
          } else {
            reject(new Error("http_"+res.statusCode));
          }
        });
      }).on("error", (err) => { clearTimeout(to); if(!timedOut) reject(err); });
    } catch (e) {
      clearTimeout(to); reject(e);
    }
  });
}

/* ---------- Config loaders ---------- */
function loadConfigLocal() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { keys: [], expires_default: 172800 }; // 48h
  }
}
async function loadConfigRemote() {
  try {
    const data = await fetchJSON(CONFIG_URL, 8000);
    if (Array.isArray(data)) return { keys: data, expires_default: 172800 };
    if (data && typeof data === "object") return data;
    return { keys: [], expires_default: 172800 };
  } catch {
    return { keys: [], expires_default: 172800 };
  }
}

// remote-first + cache 30s
let _configCache = null;
let _configCacheAt = 0;
const CONFIG_CACHE_MS = 30 * 1000;

async function loadConfigSmart() {
  const nowMs = Date.now();
  if (_configCache && (nowMs - _configCacheAt) < CONFIG_CACHE_MS) return _configCache;

  const remote = await loadConfigRemote();
  let merged = remote;
  if (!remote.keys || remote.keys.length === 0) merged = loadConfigLocal();

  merged.keys = (merged.keys || []).map((item) => {
    if (typeof item === "string") return { key: item, ttl: merged.expires_default || 172800, reusable: false };
    if (item && typeof item === "object") {
      return {
        key: String(item.key || "").trim(),
        ttl: Number(item.ttl || merged.expires_default || 172800),
        reusable: !!item.reusable
      };
    }
    return null;
  }).filter(Boolean);

  _configCache = merged; _configCacheAt = nowMs;
  return merged;
}

/* ---------- Issued state ---------- */
function loadIssued() {
  if (!fs.existsSync(ISSUED_PATH)) {
    fs.writeFileSync(ISSUED_PATH, "{}", "utf8");
    return {};
  }
  try { return JSON.parse(fs.readFileSync(ISSUED_PATH, "utf8") || "{}"); }
  catch { return {}; }
}
function saveIssued(obj) {
  fs.writeFileSync(ISSUED_PATH, JSON.stringify(obj, null, 2), "utf8");
}

/* ---------- Utils ---------- */
// ทำให้คีย์อยู่ในรูปแบบมาตรฐาน: UFO-XXXXXXXX-48H (ตัวพิมพ์ใหญ่เสมอ)
function normalizeKey(s) {
  let v = String(s || "").trim().toUpperCase();
  if (!v) return "";
  if (!/^UFO-/.test(v)) v = "UFO-" + v.replace(/^-+/, "");
  if (!/-48H$/.test(v)) v = v.replace(/-48H$/, "") + "-48H";
  return v;
}
function sweepExpired(issued, now) {
  let changed = false;
  for (const k of Object.keys(issued)) {
    const t = issued[k];
    if (!t || !t.expires_at || now > Number(t.expires_at)) {
      delete issued[k]; changed = true;
    }
  }
  if (changed) saveIssued(issued);
}
function activeKeyOwners(issued, now) {
  const map = new Map(); // keyString -> id(uid:place)
  for (const id of Object.keys(issued)) {
    const t = issued[id];
    if (t && t.key && t.expires_at && now < Number(t.expires_at)) {
      map.set(String(t.key), id);
    }
  }
  return map;
}
function chooseFreeKey(configKeys, issuedMap, now, selfId, preferCurrentKey) {
  if (preferCurrentKey) {
    const ownerId = issuedMap.get(preferCurrentKey);
    if (!ownerId || ownerId === selfId) return preferCurrentKey;
  }
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
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* ---------- API: GETKEY ---------- */
app.get("/getkey", async (req, res) => {
  const uid   = String(req.query.uid   || "").trim();
  const place = String(req.query.place || "").trim();
  const forceNew   = String(req.query.force_new || "") === "1";
  const extendSecQ = Number(req.query.extend || 0) || 0;
  if (!uid || !place) return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });

  try {
    const config = await loadConfigSmart();
    const issued = loadIssued();
    const now    = Math.floor(Date.now()/1000);
    const id     = `${uid}:${place}`;

    sweepExpired(issued, now);

    const current = issued[id];
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

    const keys  = (config.keys || []).filter(k => k && k.key);
    if (!keys.length) return res.status(500).json({ ok:false, reason:"no_keys_in_config" });

    const issuedMap = activeKeyOwners(issued, now);
    const preferKey = current && current.key;
    const pickedKey = chooseFreeKey(keys, issuedMap, now, id, preferKey);
    if (!pickedKey) {
      return res.status(503).json({ ok:false, reason:"no_free_key" });
    }

    const meta = keys.find(k => k.key === pickedKey) || {};
    const ttl  = Number(meta.ttl || config.expires_default || 172800); // 48h
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
  const keyIn = String(req.query.key   || "").trim();
  if (!uid || !place || !keyIn) return res.status(400).json({ ok:false, valid:false, reason:"missing_uid_place_or_key" });

  try {
    const now    = Math.floor(Date.now()/1000);
    const issued = loadIssued();
    const id     = `${uid}:${place}`;
    const ticket = issued[id];

    const key = normalizeKey(keyIn);

    if (ticket && normalizeKey(ticket.key) === key) {
      if (now > Number(ticket.expires_at)) {
        return res.json({
          ok:true, valid:false, reason:"expired",
          uid, place, key: ticket.key, expired_at: ticket.expires_at
        });
      }
      return res.json({
        ok:true, valid:true,
        uid, place,
        key: ticket.key,
        issued_at: ticket.issued_at,
        expires_at: ticket.expires_at,
        reusable: !!ticket.reusable
      });
    }
    return res.json({ ok:true, valid:false, reason:"invalid_or_mismatch", uid, place });
  } catch (e) {
    console.error("verify error:", e);
    res.status(500).json({ ok:false, valid:false, reason:"server_error" });
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
    if (now > Number(ticket.expires_at)) {
      return res.json({ ok:false, reason:"already_expired", expired_at:ticket.expires_at, uid, place });
    }

    ticket.expires_at = Number(ticket.expires_at) + add;
    ticket.extended_by = (ticket.extended_by || 0) + add;
    saveIssued(issued);

    return res.json({
      ok:true, uid, place,
      key:ticket.key,
      new_expires_at:ticket.expires_at,
      added:add,
      extended_by: ticket.extended_by
    });
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
    if (!ticket) return res.json({ ok:false, reason:"no_ticket", uid, place });

    const left = Math.max(0, Number(ticket.expires_at) - now);
    return res.json({
      ok:true, uid, place,
      key:ticket.key,
      issued_at:ticket.issued_at,
      expires_at:ticket.expires_at,
      remaining:left,
      reusable: !!ticket.reusable
    });
  } catch (e) {
    console.error("status error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* ---------- Health ---------- */
app.get("/health", (req, res) => res.json({ ok:true, ts:Date.now() }));

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`UFO-HUB-X key server running on :${PORT}`);
});
