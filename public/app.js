const $ = (id)=>document.getElementById(id);
const out = $("out");
const log = (o)=>{ out.textContent = typeof o === "string" ? o : JSON.stringify(o,null,2); };

async function jget(path, params){
  const qs = new URLSearchParams(params||{}).toString();
  const url = `${path}${qs ? ("?"+qs) : ""}`;
  const res = await fetch(url, {credentials:"omit"});
  const json = await res.json().catch(()=>({ok:false, reason:"json_parse_error"}));
  return json;
}

// status pill
async function refreshStatus(){
  const pill = $("statusPill");
  try{
    const j = await jget("/status");
    if(j.ok){
      pill.textContent = "• online";
      pill.style.color = "#aef3cf";
      pill.style.borderColor = "#0f4130";
      pill.style.background = "#14221b";
    }else throw 0;
  }catch{
    pill.textContent = "• offline";
    pill.style.color = "#ffb3b3";
    pill.style.borderColor = "#512020";
    pill.style.background = "#2a1515";
  }
}
refreshStatus(); setInterval(refreshStatus, 10000);

// prefill จาก query string
const urlq = new URLSearchParams(location.search);
$("uid").value   = urlq.get("uid")   || "";
$("place").value = urlq.get("place") || "";
$("key").value   = urlq.get("key")   || "";

// ปุ่ม
$("btnGetKey").onclick = async ()=>{
  const uid = $("uid").value.trim();
  const place = $("place").value.trim();
  if(!uid || !place){ log("กรอก UID และ Place ก่อน"); return; }
  const j = await jget("/getkey", {uid, place});
  if(j.key) $("key").value = j.key;
  log(j);
};

$("btnVerify").onclick = async ()=>{
  const uid = $("uid").value.trim();
  const place = $("place").value.trim();
  const key = $("key").value.trim();
  if(!uid || !place || !key){ log("กรอก UID / Place / Key ให้ครบ"); return; }
  const j = await jget("/verify", {uid, place, key});
  log(j);
};

$("btnCopyApi").onclick = async ()=>{
  const uid = $("uid").value.trim();
  const place = $("place").value.trim();
  const url = `${location.origin}/getkey?uid=${encodeURIComponent(uid)}&place=${encodeURIComponent(place)}`;
  try{
    await navigator.clipboard.writeText(url);
    log("Copied: " + url);
  }catch{
    log("Copy failed, url: " + url);
  }
};

$("openDiscord").onclick = (e)=>{ e.preventDefault(); location.href = "https://discord.gg/your-server"; };
