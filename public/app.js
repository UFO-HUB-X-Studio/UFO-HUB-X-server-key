// app.js — UFO HUB X Key Server (compatible with UI v18.1)
// Node.js + Express, in-memory store (Render free: ok)
// Endpoints:
//   GET /getkey?uid=&place=&ttl=    -> { ok, key, expires_at }
//   GET /verify?key=&uid=&place=&format=json -> JSON {ok, valid, expires_at, reason} OR text/plain "VALID"/"INVALID"

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

/* ====== Config ====== */
const DEFAULT_TTL_SEC = Number(process.env.DEFAULT_TTL_SEC || 48 * 3600); // 48h default
const PORT = process.env.PORT || 3000;

// Allow-list (uppercased, normalized)
const ALLOW_KEYS = new Set([
  "JJJMAX",
  "GMPANUPHONGARTPHAIRIN",
  // เพิ่มได้อีกโดยใช้ ENV: ALLOW_KEYS_CSV="KEY1,KEY2"
  ...(process.env.ALLOW_KEYS_CSV
    ? process.env.ALLOW_KEYS_CSV.split(",").map(s => s.trim().toUpperCase())
    : [])
]);

/* ====== Simple in-memory store ======
   keyStore[normKey] = { key, uid, place, expires_at }
*/
const keyStore = Object.create(null);

// cleanup job (ทุก ~5 นาที)
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const k in keyStore) {
    if (keyStore[k].expires_at <= now) delete keyStore[k];
  }
}, 5 * 60 * 1000);

/* ====== Helpers ====== */
function normKey(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[^\w]/g, "")
    .toUpperCase();
}
function normId(s) {
  // uid/place: เก็บแต่เลข/ตัวอักษร, upper-case ไว้
  return String(s || "").trim().toUpperCase();
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function issueKey(uid, place, ttlSec) {
  // คีย์สุ่ม 20 ตัว (A-Z0-9) + checksum 4 ตัวท้าย (ง่าย ๆ)
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let raw = "";
  for (let i = 0; i < 20; i++) raw += ABC[(Math.random() * ABC.length) | 0];
  // checksum ง่าย ๆ : ความยาว + unix time mod 36
  const cs = (raw.length + (nowSec() % 36)).toString(36).toUpperCase().padStart(2, "0");
  const key = (raw + cs).toUpperCase();

  const nk = normKey(key);
  keyStore[nk] = {
    key,
    uid,
    place,
    expires_at: nowSec() + (ttlSec || DEFAULT_TTL_SEC),
  };
  return keyStore[nk];
}

/* ====== Routes ====== */

// health & root
app.get("/", (req, res) => {
  res.type("text/plain").send("UFO HUB X Key Server: OK");
});
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* GET /getkey?uid=&place=&ttl= */
app.get("/getkey", (req, res) => {
  try {
    const uid = normId(req.query.uid || "");
    const place = normId(req.query.place || "");
    let ttl = Number(req.query.ttl || DEFAULT_TTL_SEC);
    if (!Number.isFinite(ttl) || ttl <= 0) ttl = DEFAULT_TTL_SEC;

    if (!uid || !place) {
      return res.status(400).json({ ok: false, reason: "missing_uid_or_place" });
    }

    // ถ้ามีคีย์เดิมที่ยังไม่หมดอายุให้คืนเดิม (ลดภาระผู้ใช้)
    let existing = null;
    for (const nk in keyStore) {
      const it = keyStore[nk];
      if (it.uid === uid && it.place === place && it.expires_at > nowSec()) {
        existing = it;
        break;
      }
    }

    const item = existing || issueKey(uid, place, ttl);
    return res.json({
      ok: true,
      key: item.key,
      expires_at: item.expires_at,
      note: existing ? "reuse_existing" : "new_key",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: "server_error", error: String(e) });
  }
});

/* GET /verify?key=&uid=&place=&format=json */
app.get("/verify", (req, res) => {
  try {
    const format = String(req.query.format || "").toLowerCase();
    const rawKey = req.query.key || "";
    const uid = normId(req.query.uid || "");
    const place = normId(req.query.place || "");

    const nk = normKey(rawKey);

    // 1) allow-list ผ่านแน่
    if (ALLOW_KEYS.has(nk)) {
      const exp = nowSec() + DEFAULT_TTL_SEC;
      if (format === "json") {
        return res.json({ ok: true, valid: true, expires_at: exp });
      } else {
        return res.type("text/plain").send("VALID");
      }
    }

    // 2) ตรวจใน store
    const item = keyStore[nk];
    if (!item) {
      if (format === "json") return res.json({ ok: true, valid: false, reason: "not_found" });
      return res.type("text/plain").send("INVALID");
    }

    // 3) หมดอายุ?
    if (item.expires_at <= nowSec()) {
      delete keyStore[nk];
      if (format === "json") return res.json({ ok: true, valid: false, reason: "expired" });
      return res.type("text/plain").send("INVALID");
    }

    // 4) ผูก uid/place — “ผ่อนปรน” (ยึดคีย์เป็นหลัก, ถ้ามี uid/place ก็ต้องตรง)
    // แนะนำให้ผู้ใช้คัดลอกลิงก์ getkey จากในเกม (UI ทำให้แล้ว)
    if ((uid && item.uid && item.uid !== uid) || (place && item.place && item.place !== place)) {
      if (format === "json") return res.json({ ok: true, valid: false, reason: "uid_place_mismatch" });
      return res.type("text/plain").send("INVALID");
    }

    // ผ่าน!
    if (format === "json") {
      return res.json({ ok: true, valid: true, expires_at: item.expires_at });
    } else {
      return res.type("text/plain").send("VALID");
    }
  } catch (e) {
    // ถ้ามีปัญหา parsing ให้ตอบ invalid (UI จะ fallback)
    const format = String(req.query.format || "").toLowerCase();
    if (format === "json") {
      return res.status(200).json({ ok: true, valid: false, reason: "exception" });
    } else {
      return res.type("text/plain").send("INVALID");
    }
  }
});

app.listen(PORT, () => {
  console.log("UFO HUB X Key Server listening on", PORT);
});
