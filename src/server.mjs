import express from "express";
import cors from "cors";
import morgan from "morgan";
import { fetch } from "undici";

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_NAME = "UFO HUB X Gateway";

// ใส่โดเมนของ key1,key2 ใน ENV ชื่อ UPSTREAMS (คั่นด้วยจุลภาค)
const UPSTREAMS = (process.env.UPSTREAMS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (UPSTREAMS.length === 0) {
  console.warn("[GATEWAY] UPSTREAMS is empty. Set it on Render like:");
  console.warn("https://<key1>.onrender.com,https://<key2>.onrender.com");
}

app.use(cors());
app.use(morgan("tiny"));

const okJson = (res, obj) => res.json({ ok: true, ...obj });
const badJson = (res, msg, code = 400) => res.status(code).json({ ok: false, reason: msg });

const qs = o =>
  Object.entries(o)
    .filter(([,v]) => v !== undefined && v !== null)
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

function pickUpstream(uid="") {
  if (!UPSTREAMS.length) return null;
  let h = 0; for (let i=0;i<uid.length;i++) h = (h*131 + uid.charCodeAt(i)) >>> 0;
  return UPSTREAMS[h % UPSTREAMS.length]; // sticky by uid
}

async function tryVerify(upstreams, key, uid, place, wantJSON) {
  for (const base of upstreams) {
    const url = `${base}/verify?${qs({ key, uid, place, format: wantJSON ? "json" : undefined })}`;
    try {
      const r = await fetch(url);
      const t = await r.text();
      if (wantJSON) {
        try {
          const j = JSON.parse(t);
          if (j && j.ok && j.valid) return { valid:true, expires_at:j.expires_at, via:base };
        } catch {}
      } else {
        if (t.trim().toUpperCase() === "VALID") return { valid:true, via:base };
      }
    } catch {}
  }
  return { valid:false };
}

// Health
app.get("/", (_req, res) => res.type("text/plain").send(`${SERVER_NAME}: OK`));

// ออกคีย์ (proxy ไป upstream ตาม uid)
app.get("/getkey", async (req, res) => {
  const { uid="", place="" } = req.query;
  if (!uid || !place) return badJson(res, "missing uid/place");

  const base = pickUpstream(String(uid));
  if (!base) return badJson(res, "no_upstreams_configured", 503);

  const url = `${base}/getkey?${qs({ uid, place })}`;
  try {
    const r = await fetch(url);
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      if (j && j.ok && j.key) return okJson(res, { key:j.key, expires_at:j.expires_at, upstream:base });
    } catch {
      // ถ้า upstream ตอบ text ธรรมดา
      return okJson(res, { key: txt.trim(), expires_at: Math.floor(Date.now()/1000)+172800, upstream:base });
    }
  } catch (e) {
    return badJson(res, `upstream_error: ${e.message||e}`, 502);
  }
});

// ตรวจคีย์ (JSON ก่อน → ไม่ได้ค่อย TEXT)
app.get("/verify", async (req, res) => {
  const { key="", uid="", place="", format } = req.query;
  if (!key || !uid || !place) return badJson(res, "missing key/uid/place");

  const j = await tryVerify(UPSTREAMS, String(key), String(uid), String(place), true);
  if (j.valid) return format==="json"
    ? okJson(res, { valid:true, expires_at:j.expires_at, via:j.via })
    : res.type("text/plain").send("VALID");

  const t = await tryVerify(UPSTREAMS, String(key), String(uid), String(place), false);
  if (t.valid) return format==="json"
    ? okJson(res, { valid:true, expires_at:Math.floor(Date.now()/1000)+172800, via:t.via })
    : res.type("text/plain").send("VALID");

  return format==="json"
    ? okJson(res, { valid:false, reason:"invalid_or_upstream_down" })
    : res.type("text/plain").send("INVALID");
});

app.listen(PORT, () => {
  console.log(`[GATEWAY] ${SERVER_NAME} on ${PORT}`);
  console.log("[GATEWAY] UPSTREAMS =", UPSTREAMS);
});
