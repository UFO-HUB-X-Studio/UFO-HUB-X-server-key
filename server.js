import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Middlewares ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(morgan("tiny"));
app.use(express.json());

// ---------- Static UI ----------
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

// ---------- In-memory key store (ตัวอย่าง) ----------
const DEFAULT_TTL_MS = 48 * 3600 * 1000; // 48 ชม.
const issued = new Map(); // key -> { uid, place, expiresAt, reusable }

const now = () => Date.now();
const clampTtl = (ms) => Math.max(5 * 60 * 1000, Math.min(ms, DEFAULT_TTL_MS)); // 5m..48h

function createKey(uid, place, ttlMs = DEFAULT_TTL_MS, reusable = false) {
  const key = `UFO-${nanoid(8).toUpperCase()}-${nanoid(4).toUpperCase()}`;
  const exp = now() + clampTtl(ttlMs);
  issued.set(key, { uid, place, expiresAt: exp, reusable });
  return { key, exp, reusable };
}

// ---------- Health / Status ----------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/status", (_req, res) => {
  res.json({ ok: true, service: "ufo-key", time: now() });
});

// ---------- API: getkey ----------
app.get("/getkey", (req, res) => {
  const uid   = String(req.query.uid || "").trim();
  const place = String(req.query.place || "").trim();

  if (!uid || !place) {
    return res.status(400).json({ ok:false, reason:"missing_uid_or_place" });
  }

  // ถ้ามี key เดิมที่ยังไม่หมดอายุและผูกกับ uid/place แล้ว ให้ส่งอันเดิม
  for (const [k, meta] of issued.entries()) {
    if (meta.uid === uid && meta.place === place && meta.expiresAt > now()) {
      return res.json({
        ok: true,
        key: k,
        ttl: Math.floor((meta.expiresAt - now())/1000),
        expires_at: meta.expiresAt,
        reusable: !!meta.reusable,
        note: "existing_active_for_uid",
        meta: { bound_uid: uid, place }
      });
    }
  }

  // ออกคีย์ใหม่ (ตัวอย่าง: non-reusable)
  const { key, exp, reusable } = createKey(uid, place, DEFAULT_TTL_MS, false);
  res.json({
    ok: true,
    key,
    ttl: Math.floor((exp - now())/1000),
    expires_at: exp,
    reusable,
    meta: { bound_uid: uid, place }
  });
});

// ---------- API: verify ----------
app.get("/verify", (req, res) => {
  const key   = String(req.query.key || "").trim();
  const uid   = String(req.query.uid || "").trim();
  const place = String(req.query.place || "").trim();

  if (!key || !uid || !place) {
    return res.status(400).json({ ok:false, valid:false, reason:"missing_params" });
  }

  const meta = issued.get(key);
  if (!meta) {
    return res.json({ ok:true, valid:false, reason:"not_found" });
  }
  if (meta.expiresAt <= now()) {
    issued.delete(key);
    return res.json({ ok:true, valid:false, reason:"expired" });
  }
  if (meta.uid !== uid || meta.place !== place) {
    return res.json({ ok:true, valid:false, reason:"bound_to_another" });
  }

  res.json({ ok:true, valid:true, expires_at: meta.expiresAt });
});

// ---------- API: extend (ขยายอายุคีย์) ----------
app.get("/extend", (req, res) => {
  const key = String(req.query.key || "").trim();
  const add = Number(req.query.add || 3600) * 1000; // seconds -> ms
  const meta = issued.get(key);
  if (!meta) return res.json({ ok:false, reason:"not_found" });
  meta.expiresAt = meta.expiresAt + clampTtl(add);
  res.json({ ok:true, extended:true, expires_at: meta.expiresAt });
});

// ---------- Root -> index.html ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- 404 & Error handler ----------
app.use((req, res) => res.status(404).json({ ok:false, reason:"not_found", path:req.path }));
app.use((err, _req, res, _next) => {
  console.error("[SERVER ERROR]", err);
  res.status(500).json({ ok:false, reason:"server_error" });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
