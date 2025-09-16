const btnGet = document.getElementById("btn-get");
const result = document.getElementById("result");
const keytext = document.getElementById("keytext");
const copyBtn = document.getElementById("copy");
const extendBtn = document.getElementById("extend");
const remainSpan = document.getElementById("remain");
const discord = document.getElementById("discord");

// สร้าง deviceId คร่าวๆ จาก UA + random เก็บใน localStorage
function getDeviceId(){
  const k = "ufo_device_id";
  let v = localStorage.getItem(k);
  if (!v){
    v = (navigator.userAgent + "|" + Math.random().toString(36).slice(2,10)).toString();
    localStorage.setItem(k, v);
  }
  return v.slice(0, 120);
}

let timer = null;
function pretty(sec){
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function startCountdown(total){
  clearInterval(timer);
  function tick(){
    if (total <= 0){ remainSpan.textContent = "00:00:00"; clearInterval(timer); return; }
    remainSpan.textContent = pretty(total);
    total--;
  }
  tick();
  timer = setInterval(tick, 1000);
}

btnGet.addEventListener("click", async ()=>{
  btnGet.disabled = true;
  btnGet.textContent = "กำลังรับคีย์…";
  try{
    const r = await fetch("/api/getkey", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ deviceId: getDeviceId() })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "error");

    keytext.textContent = data.key;
    result.classList.remove("hide");
    startCountdown(Number(data.remainingSec || 0));
    btnGet.textContent = "รับคีย์อีกครั้ง";
  }catch(e){
    alert("รับคีย์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }finally{
    btnGet.disabled = false;
  }
});

copyBtn.addEventListener("click", async ()=>{
  try{
    await navigator.clipboard.writeText(keytext.textContent);
    copyBtn.textContent = "Copied ✓";
    setTimeout(()=>copyBtn.textContent = "Copy", 1200);
  }catch{ alert("คัดลอกไม่สำเร็จ"); }
});

extendBtn.addEventListener("click", async ()=>{
  const k = keytext.textContent.trim();
  if (!k || k === "—") return;
  extendBtn.disabled = true;
  try{
    const r = await fetch(`/api/extend/${encodeURIComponent(k)}`, { method: "POST" });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "extend failed");

    startCountdown(Number(data.remainingSec || 0));
    extendBtn.textContent = "+5H ✓";
    setTimeout(()=> extendBtn.textContent = "+5H", 1200);
  }catch(e){
    alert("ต่อเวลาไม่สำเร็จ");
  }finally{
    extendBtn.disabled = false;
  }
});

discord.addEventListener("click", (e)=>{
  e.preventDefault();
  const url = "https://discord.gg/your-server";
  navigator.clipboard.writeText(url).then(()=>{
    discord.textContent = "Copied!";
    setTimeout(()=> discord.textContent = "Join the Discord", 1200);
  });
});
