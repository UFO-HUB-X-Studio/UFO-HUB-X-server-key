import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// อ่านรายการ upstreams จาก ENV (คั่นด้วย ,) หรือใช้ค่าเริ่มต้น
const UPSTREAMS = (process.env.UPSTREAMS ||
  "https://ufo-hub-x-key1.onrender.com,https://ufo-hub-x-key2.onrender.com"
).split(",").map(s => s.trim()).filter(Boolean);

// หน้า static
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// helper เรียก upstream ทีละตัว พร้อม retry/backoff เบาๆ
async function forward(pathWithQuery) {
  for (let i = 0; i < UPSTREAMS.length; i++) {
    const base = UPSTREAMS[i];
    const url = base + pathWithQuery;
    try {
      const r = await fetch(url, { timeout: 7000 });
      if (!r.ok) continue;
      const text = await r.text();
      return { ok: true, body: text, base };
    } catch (e) {
      // ลองตัวถัดไป
    }
  }
  return { ok: false };
}

// รวม /getkey
app.get("/getkey", async (req, res) => {
  const q = req.originalUrl.replace("/getkey", "");
  const r = await forward("/getkey" + q);
  if (!r.ok) return res.status(502).json({ ok:false, error:"All upstreams failed" });
  // upstream จะตอบ JSON อยู่แล้ว
  try {
    return res.json(JSON.parse(r.body));
  } catch {
    return res.type("text/plain").send(r.body);
  }
});

// รวม /verify
app.get("/verify", async (req, res) => {
  const q = req.originalUrl.replace("/verify", "");
  const r = await forward("/verify" + q);
  if (!r.ok) return res.status(502).json({ ok:false, error:"All upstreams failed" });

  // พยายามแปลงเป็น JSON ก่อน
  try {
    return res.json(JSON.parse(r.body));
  } catch {
    // ถ้าเป็น text/plain ("VALID"/"INVALID") ให้ส่งต่อ
    return res.type("text/plain").send(r.body);
  }
});

app.listen(PORT, () => {
  console.log(`[AGGREGATOR] listening on ${PORT}`);
  console.log("UPSTREAMS =", UPSTREAMS);
});
