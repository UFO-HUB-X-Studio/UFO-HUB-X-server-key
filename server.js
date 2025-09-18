import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// เสิร์ฟไฟล์ static จาก public/
app.use(express.static(path.join(__dirname, "public")));

// root → index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Endpoint ตัวอย่าง (ปรับแก้ได้) =====
app.get("/getkey", (req, res) => {
  res.json({ ok: true, key: "UFO-TEST-KEY-48H" });
});

app.get("/verify", (req, res) => {
  // สมมุติว่าคีย์ถูกต้อง
  res.json({ ok: true, valid: true, expires_at: Date.now() + 48 * 3600 * 1000 });
});

app.get("/extend", (req, res) => {
  res.json({ ok: true, extended: true });
});

// ===== Render ต้องใช้ process.env.PORT =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[KEY-SERVER] listening on ${PORT}`);
});
