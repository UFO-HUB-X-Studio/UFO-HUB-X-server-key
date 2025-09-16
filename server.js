const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// เสิร์ฟไฟล์ใน public
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1h'
}));

// endpoint สำหรับ get key
app.get('/getkey', (req,res) => {
  res.json({ key: 'UFO-HUB-X-' + Math.floor(10000 + Math.random()*90000) });
});

// หน้าหลัก
app.get('/', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Server running on ' + PORT));
