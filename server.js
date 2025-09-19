// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ----- helpers -----
function readConfig() {
  const configPath = path.join(__dirname, "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_) {
    return { expires_default: 172800, keys: [] };
  }
}

// ----- root: แนะนำการใช้ -----
app.get("/", (req, res) => {
  const uid   = req.query.uid   || "<UID>";
  const place = req.query.place || "<PLACE>";
  res.json({
    ok: true,
    message: "Use /verify?key=&uid=&place=&format=json",
    uid: String(uid),
    place: String(place),
  });
});

// ----- GETKEY: ดึงคีย์แรกใน config.json -----
app.get("/getkey", (req, res) => {
  const uid   = req.query.uid   || "";
  const place = req.query.place || "";

  try {
    const cfg = readConfig();
    const firstKey = cfg.keys[0] ? cfg.keys[0].key : null;

    res.json({
      ok: true,
      uid,
      place,
      key: firstKey,                           // <— จะเห็นคีย์ตรงนี้
      expires_in: cfg.expires_default || 172800
    });
  } catch (err) {
    console.error("getkey error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----- VERIFY: ตรวจคีย์ -----
app.get("/verify", (req, res) => {
  const key   = (req.query.key || "").trim();
  const uid   = req.query.uid   || "";
  const place = req.query.place || "";

  try {
    const cfg = readConfig();
    const found = cfg.keys.find(k => String(k.key).trim() === key);

    if (!found) {
      return res.json({ ok: true, valid: false, reason: "invalid_key" });
    }

    const ttl = Number(found.ttl || cfg.expires_default || 172800);
    const now = Math.floor(Date.now() / 1000);

    res.json({
      ok: true,
      valid: true,
      uid,
      place,
      expires_at: now + ttl
    });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----- 404 -----
app.use((req, res) => res.status(404).json({ ok:false, error:"not_found" }));

// ----- start -----
app.listen(PORT, () => {
  console.log(`[KEY SERVER] listening on ${PORT}`);
});
