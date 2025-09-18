const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Allow-list (key พิเศษ)
const ALLOW_KEYS = {
  "JJJMAX": { reusable: true, ttl: 48 * 3600 },
  "GMPANUPHONGARTPHAIRIN": { reusable: true, ttl: 48 * 3600 },
};

// route root
app.get("/", (req, res) => {
  res.send("UFO HUB X Key Server: OK");
});

// getkey endpoint
app.get("/getkey", (req, res) => {
  const { uid, place } = req.query;
  // สร้างคีย์ชั่วคราว (จริง ๆ ต้องเก็บ DB หรือ memory)
  const key = "UFO-" + Math.random().toString(36).substr(2, 8).toUpperCase();
  const ttl = 48 * 3600; // 48 ชั่วโมง
  const expires_at = Math.floor(Date.now() / 1000) + ttl;

  res.json({
    ok: true,
    key,
    ttl,
    expires_at,
    reusable: false,
    note: "generated_from_server",
    active_for_uid: uid || null,
    meta: { place: place || null }
  });
});

// verify endpoint
app.get("/verify", (req, res) => {
  const { key, uid, place, format } = req.query;
  const cleanKey = String(key || "").toUpperCase().trim();

  let valid = false;
  let expires_at = Math.floor(Date.now() / 1000) + (48 * 3600);

  // เช็คใน allow-list
  if (ALLOW_KEYS[cleanKey]) {
    valid = true;
    expires_at = Math.floor(Date.now() / 1000) + ALLOW_KEYS[cleanKey].ttl;
  }

  if (format === "json") {
    res.json({
      ok: true,
      valid,
      expires_at: valid ? expires_at : null,
      reason: valid ? null : "invalid"
    });
  } else {
    res.send(valid ? "VALID" : "INVALID");
  }
});

// run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
