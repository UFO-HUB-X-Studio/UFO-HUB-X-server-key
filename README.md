# UFO HUB X — Key Server

## Deploy บน Render
1. สร้าง Git repo ตามโครงนี้ แล้ว push code
2. ไปที่ https://dashboard.render.com > New > Web Service
3. เลือก repo นี้, Runtime: Node, Region ตามสะดวก
4. Build command: *(ไม่ต้องใส่)*  (Render จะ `npm install` อัตโนมัติ)
5. Start command: ใช้จาก package.json คือ `npm start`
6. กด Create Service และรอ deploy เสร็จ

## Endpoints
- `GET /` → Health: `"UFO HUB X Key Server: OK"`
- `GET /getkey?uid=&place=` → คืน `{ ok, key, expires_at }`
- `GET /verify?key=&uid=&place=&format=json`  
  - `format=json` → `{ ok, valid, expires_at, reason }`  
  - ไม่ใส่ `format` → คืนข้อความ `"VALID"` หรือ `"INVALID"`

## หมายเหตุ
- เซิร์ฟเวอร์นี้เก็บคีย์ไว้ในหน่วยความจำ (restart แล้วหาย) — ถ้าต้องการถาวร ใช้ฐานข้อมูลภายนอก (Redis/Upstash, Planetscale, ฯลฯ)
- Allow-list: `JJJMAX`, `GMPANUPHONGARTPHAIRIN` ผ่านเสมอ
- อายุคีย์เริ่มต้น 48 ชั่วโมง ปรับได้ที่ `DEFAULT_TTL_SECONDS`
