const BASE = location.origin;

async function apiGetKey(){
  const r = await fetch(BASE + '/api/getkey', { method:'POST' });
  return r.json();
}
async function apiCheck(k){
  const r = await fetch(BASE + '/api/check/' + encodeURIComponent(k));
  return r.json();
}
async function apiExtend(k){
  const r = await fetch(BASE + '/api/extend/' + encodeURIComponent(k), { method:'POST' });
  return r.json();
}
function copyText(s){
  if(!s) return;
  navigator.clipboard?.writeText(s).catch(()=>{});
}
function setProfile(imgEl){
  // รูปโปรไฟล์ (อันที่ 1)
  imgEl.src = "https://cdn.discordapp.com/attachments/1417098355388973154/1417560447279960194/20250916_152130.png?ex=68caed8b&is=68c99c0b&hm=d765fd0dd2ea7abcf19570afee5aee70c89dc0c5c83a337454d4f5a1aa7d0f32&";
}

export { apiGetKey, apiCheck, apiExtend, copyText, setProfile };
