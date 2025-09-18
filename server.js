// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Static UI ----------
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  // ป้องกัน cache หน้า index ช่วงแก้บ่อย
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

// root -> index.html
app.get("/", (_req, res) => {
  res.type("html").sendFile(path.join(__dirname, "public", "index.html"));
});

// helper: เช็คว่าคน “เปิดด้วยเบราว์เซอร์” ไหม
function isHumanBrowser(req) {
  const a = (req.headers["accept"] || "").toLowerCase();
  // ถ้าขอ HTML เป็นหลัก ให้ถือว่าเปิดจาก address bar / ลิงก์
  return a.includes("text/html") && !a.includes("application/json");
}

// ------------- API (เวอร์ชันที่ “ไม่เด้งหน้า”) -------------
app.get("/api/status", (_req, res) => {
  res.json({ ok: true, service: "ufo-hub-x", ts: Date.now() });
});

app.get("/api/getkey", (req, res) => {
  const { uid = "web", place = "web" } = req.query;
  // mock ตัวอย่าง — ใส่ลอจิกจริงของคุณแทนได้
  res.json({
    ok: true,
    key: "UFO-" + Math.random().toString(36).slice(2, 8).toUpperCase() + "-48H",
    ttl: 172800, // 48 ชม.
    expires_at: Math.floor(Date.now() / 1000) + 48 * 3600,
    reusable: false,
    meta: { bound_uid: String(uid), place: String(place) }
  });
});

app.get("/api/verify", (req, res) => {
  const { key = "", uid = "web", place = "web" } = req.query;
  // mock verify — ใส่เงื่อนไขจริงแทน
  const valid = String(key).toUpperCase().startsWith("UFO-");
  res.json({
    ok: true,
    valid,
    reason: valid ? null : "invalid_key",
    expires_at: Math.floor(Date.now() / 1000) + (valid ? 24 * 3600 : 0),
    meta: { uid, place }
  });
});

app.get("/api/extend", (req, res) => {
  const { key = "" } = req.query;
  // mock extend — เติมอายุ +48h
  const now = Math.floor(Date.now() / 1000);
  res.json({ ok: true, key, extended: true, expires_at: now + 48 * 3600 });
});

// ------------- Compatibility routes (กัน JSON โผล่จอ) -------------
// ถ้า “เรียกด้วย fetch” -> ส่ง JSON
// ถ้า “เปิดด้วยเบราว์เซอร์” -> เด้งกลับหน้า UI (ไม่เห็น JSON บนจอ)
app.get("/status", (req, res) => {
  if (isHumanBrowser(req)) return res.redirect(302, "/");
  res.redirect(307, "/api/status"); // 307 เพื่อคง method/qs
});
app.get("/getkey", (req, res) => {
  if (isHumanBrowser(req)) return res.redirect(302, "/");
  res.redirect(307, "/api/getkey");
});
app.get("/verify", (req, res) => {
  if (isHumanBrowser(req)) return res.redirect(302, "/");
  res.redirect(307, "/api/verify");
});
app.get("/extend", (req, res) => {
  if (isHumanBrowser(req)) return res.redirect(302, "/");
  res.redirect(307, "/api/extend");
});

// ------------- Fallback -------------
// ให้ SPA/หน้า UI รับทุก path อื่นๆ (กัน 404 เวลา refresh)
app.get("*", (_req, res) => {
  res.type("html").sendFile(path.join(__dirname, "public", "index.html"));
});

// Render ต้องใช้ PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[UFO-HUB-X] listening on ${PORT}`);
});
