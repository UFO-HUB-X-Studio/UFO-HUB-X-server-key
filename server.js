import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ตัวอย่าง endpoint
app.get("/", (req, res) => {
  res.send("UFO HUB X Key Server: OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
