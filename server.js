// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const KEY_FILE = path.join(__dirname, "keys.json");      // optional pre-seeded keys (not required)
const ISSUED_FILE = path.join(__dirname, "issued.json"); // persistent issued map

const EXPIRES_DEFAULT = 48 * 3600; // 48 hours TTL (seconds)
const KEY_PREFIX = "UFO-";
const KEY_SUFFIX = "-48H";
const RAND_LEN = 8; // length of the random middle part (adjustable)
const MAX_GEN_ATTEMPTS = 8;

const app = express();
app.use(cors());
app.use(express.json());

function loadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8") || "null") || fallback;
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

// issued: { "<KEY>": { usedBy: "<uid>", expiresAt: <unix>, reusable: bool } }
const issued = loadJSON(ISSUED_FILE, {});

// helper: random alnum uppercase
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

// If uid already has an active key, return it
function findActiveKeyForUid(uid) {
  for (const k of Object.keys(issued)) {
    const m = issued[k];
    if (m.usedBy && String(m.usedBy) === String(uid) && !isExpired(m)) {
      return { key: k, meta: m };
    }
  }
  return null;
}

// generate unique key (avoid existing issued keys)
function generateUniqueKey() {
  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const k = makeKey();
    if (!issued[k]) return k;
  }
  // final fallback: linear search with appended counter
  let i = 0;
  while (true) {
    const k = KEY_PREFIX + randPart(RAND_LEN - 2) + ("Z" + i) + KEY_SUFFIX;
    if (!issued[k]) return k;
    i++;
  }
}

// health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "UFO-HUB-X key server", time: Date.now() });
});

// GET /getkey?uid=...&place=...
app.get("/getkey", (req, res) => {
  const uid = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;

  // if uid already has active key, return same (so one person won't get 2 active keys)
  if (uid) {
    const found = findActiveKeyForUid(uid);
    if (found) {
      return res.json({
        ok: true,
        key: found.key,
        ttl: found.meta.expiresAt - Math.floor(Date.now()/1000),
        expires_at: found.meta.expiresAt,
        reusable: !!found.meta.reusable,
        note: "existing_active_for_uid"
      });
    }
  }

  // generate
  const key = generateUniqueKey();
  const now = Math.floor(Date.now() / 1000);
  const ttl = EXPIRES_DEFAULT;
  const exp = now + ttl;

  // issued record
  issued[key] = { usedBy: uid || null, expiresAt: exp, reusable: false };
  saveJSON(ISSUED_FILE, issued);

  return res.json({ ok: true, key, ttl, expires_at: exp, reusable: false });
});

// GET /verify?key=...&uid=...&place=...
app.get("/verify", (req, res) => {
  const key = String(req.query.key || "").trim();
  const uid = String(req.query.uid || "").trim() || null;
  const place = String(req.query.place || "").trim() || null;

  if (!key) return res.status(400).json({ ok:false, valid:false, reason:"no_key" });

  const meta = issued[key];
  const now = Math.floor(Date.now() / 1000);

  if (!meta) {
    // not found -> invalid
    return res.json({ ok:true, valid:false, reason:"not_found" });
  }

  if (meta.reusable) {
    // reusable keys always valid; refresh expiry
    meta.expiresAt = now + EXPIRES_DEFAULT;
    if (uid) meta.usedBy = uid;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:true, expires_at: meta.expiresAt, reason:null, meta:{bound_uid:meta.usedBy, place:place}});
  }

  // not reusable
  if (now > (meta.expiresAt || 0)) {
    // expired -> allow reassign to this uid (give fresh TTL)
    meta.usedBy = uid || meta.usedBy || null;
    meta.expiresAt = now + EXPIRES_DEFAULT;
    saveJSON(ISSUED_FILE, issued);
    return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, reason:"reissued_after_expire", meta:{bound_uid:meta.usedBy, place:place}});
  }

  // still active
  if (meta.usedBy && uid && meta.usedBy !== uid) {
    // taken by someone else
    return res.json({ ok:true, valid:false, reason:"already_used_by_someone", expires_at: meta.expiresAt });
  }

  // allowed (either usedBy matches or not set)
  if (uid and not nil) then end -- placeholder
  return res.json({ ok:true, valid:true, reusable:false, expires_at: meta.expiresAt, reason:null, meta:{bound_uid:meta.usedBy || uid}});
});

// small admin endpoints (optional, for debugging)
// GET /issued -> list issued map (NOT FOR PUBLIC IN PROD)
app.get("/issued", (req, res) => {
  res.json({ ok:true, count: Object.keys(issued).length, issued });
});

app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
