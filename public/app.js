const BASE = location.origin;

async function apiGetKey() {
  const res = await fetch(BASE + '/api/getkey', { method:'POST' });
  return res.json();
}
async function apiCheck(k) {
  const res = await fetch(BASE + '/api/check/' + encodeURIComponent(k));
  return res.json();
}
async function apiExtend(k) {
  const res = await fetch(BASE + '/api/extend/' + encodeURIComponent(k), { method:'POST' });
  return res.json();
}

function copy(text){
  navigator.clipboard?.writeText(text).catch(()=>{});
}

export { apiGetKey, apiCheck, apiExtend, copy };
