const btnGet = document.getElementById("btn-get");
const result = document.getElementById("result");
const keytext = document.getElementById("keytext");
const copyBtn = document.getElementById("copy");
const extendBtn = document.getElementById("extend");
const remainSpan = document.getElementById("remain");
const discord = document.getElementById("discord");

function getiOSDeviceId(){
  const k = "ufo_ios_device_id";
  let v = localStorage.getItem(k);
  if (!v){
    // iOS UA + random
    v = (navigator.userAgent + "|" + Math.random().toString(36).slice(2,8));
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
  const tick = ()=>{
    if (total <= 0){ remainSpan.textContent = "00:00:00"; clearInterval(timer); return; }
    remainSpan.textContent = pretty(total); total--;
  };
  tick();
  timer = setInterval(tick, 1000);
}

// Clipboard fallback for iOS Safari
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch{
    try{
      const tmp = document.createElement("textarea");
      tmp.value = text;
      tmp.style.position = "fixed";
      tmp.style.opacity = "0";
      tmp.setAttribute("readonly", "");
      document.body.appendChild(tmp);
      tmp.focus();
      tmp.select();
      document.execCommand("copy");
      document.body.removeChild(tmp);
      return true;
    }catch{
      return false;
    }
  }
}

btnGet.addEventListener("click", async ()=>{
  btnGet.disabled = true;
  btnGet.textContent = "กำลังรับคีย์…";
  try{
    const r = await fetch("/api/getkey", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ deviceId: getiOSDeviceId() })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "error");

    keytext.textContent = data.key;
    result.classList.remove("hide");
    startCountdown(Number(data.remainingSec || 0));
    btnGet.textContent = "รับคีย์อีกครั้ง";
  }catch(e){
    alert("รับคีย์ไม่สำเร็จ กรุณาลองใหม่");
  }finally{
    btnGet.disabled = false;
  }
});

copyBtn.addEventListener("click", async ()=>{
  const ok = await copyText(keytext.textContent || "");
  copyBtn.textContent = ok ? "คัดลอกแล้ว ✓" : "คัดลอกไม่สำเร็จ";
  setTimeout(()=> copyBtn.textContent = "คัดลอก", 1200);
});

extendBtn.addEventListener("click", async ()=>{
  const k = keytext.textContent.trim();
  if (!k || k === "—") return;
  extendBtn.disabled = true;
  try{
    const r = await fetch(`/api/extend/${encodeURIComponent(k)}`, { method:"POST" });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "extend failed");
    startCountdown(Number(data.remainingSec || 0));
    extendBtn.textContent = "+5H ✓";
    setTimeout(()=> extendBtn.textContent = "+5H", 1200);
  }catch{
    alert("ต่อเวลาไม่สำเร็จ");
  }finally{
    extendBtn.disabled = false;
  }
});

discord.addEventListener("click", (e)=>{
  e.preventDefault();
  const url = "https://discord.gg/your-server";
  copyText(url).then((ok)=>{
    discord.textContent = ok ? "Copied!" : "Open Discord";
    if (!ok) location.href = url;
    setTimeout(()=> discord.textContent = "Join the Discord", 1200);
  });
});
