const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ================================
// Store คีย์ (in-memory)
// ================================
let keys = {}; // { keyString: { expires: timestamp } }

// อายุคีย์เริ่มต้น (48 ชม.)
const KEY_LIFETIME = 48 * 60 * 60 * 1000;
// ขยายเวลา (+5 ชม.)
const EXTEND_MS = 5 * 60 * 60 * 1000;

// ================================
// API: ออกคีย์ใหม่
// ================================
app.post("/api/getkey", (req, res) => {
  // 1 คน 1 key → ถ้าอยากใช้ IP เป็นตัวแยก user
  const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;

  // หา key ที่ user นี้มีอยู่แล้ว
  const existing = Object.entries(keys).find(([k, data]) => data.ip === ip && Date.now() < data.expires);

  if (existing) {
    return res.status(400).json({ error: "คุณมี Key อยู่แล้ว" });
  }

  const newKey = "UFO-HUB-X-" + uuidv4().split("-")[0].toUpperCase();
  keys[newKey] = {
    ip,
    expires: Date.now() + KEY_LIFETIME,
  };

  return res.json({ key: newKey, expires: keys[newKey].expires });
});

// ================================
// API: ตรวจสอบเวลา key
// ================================
app.get("/api/check/:key", (req, res) => {
  const k = req.params.key;
  if (!keys[k]) {
    return res.status(404).json({ error: "Key not found" });
  }
  const left = keys[k].expires - Date.now();
  return res.json({
    key: k,
    expires: keys[k].expires,
    left: left > 0 ? left : 0,
    status: left > 0 ? "ACTIVE" : "EXPIRED",
  });
});

// ================================
// API: ยืดเวลา key (+5 ชั่วโมง)
// ================================
app.post("/api/extend/:key", (req, res) => {
  const k = req.params.key;
  if (!keys[k]) {
    return res.status(404).json({ error: "Key not found" });
  }

  if (keys[k].expires < Date.now()) {
    // หมดอายุแล้ว → ต่อไม่ได้
    return res.status(400).json({ error: "Key expired" });
  }

  keys[k].expires += EXTEND_MS;
  return res.json({
    key: k,
    newExpires: keys[k].expires,
    added: EXTEND_MS,
  });
});

// ================================
// Serve หน้าเว็บ (static files)
// ================================
app.use(express.static("public"));

// ================================
app.listen(PORT, () => {
  console.log("UFO HUB X API running on port " + PORT);
});
