const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// เก็บ key ตัวอย่าง (จริงๆ จะไปทำระบบสุ่ม/ฐานข้อมูลได้ทีหลัง)
let currentKey = "UFO-HUB-X-12345";

// API ดึง key
app.get("/getkey", (req, res) => {
  res.json({ key: currentKey });
});

// เสิร์ฟไฟล์จาก public
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
