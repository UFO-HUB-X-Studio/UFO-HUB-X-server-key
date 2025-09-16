// ========== State ==========
let step = 0;
let endAt = null; // ms timestamp
const HOUR = 3600 * 1000;

// ========== Elements ==========
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const btnStart = document.getElementById('btnStart');
const btnNext  = document.getElementById('btnNext');
const keyList  = document.getElementById('keyList');
const btnNewKey= document.getElementById('btnNewKey');

// ========== Helpers ==========
const fmt = s => {
  // seconds -> HH:MM:SS
  s = Math.max(0, Math.floor(s));
  const h = String(Math.floor(s/3600)).padStart(2,'0');
  const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
  const sec = String(s%60).padStart(2,'0');
  return `${h}:${m}:${sec}`;
};

function setProgress(n){
  step = n;
  const pct = n===0?0 : n===1?50 : 100;
  progressFill.style.width = pct + '%';
  progressText.textContent = `${n}/2`;
}

function buildKeyRow(key, msLeft){
  const row = document.createElement('div');
  row.className = 'key-row';

  // col1: icon + key + copy
  const c1 = document.createElement('div'); c1.className='key-col';
  const ico = document.createElement('div'); ico.className='file-ico'; ico.textContent='📄';
  const ktx = document.createElement('span'); ktx.className='key-text'; ktx.textContent = key;
  const copy = document.createElement('button'); copy.className='action-btn'; copy.innerHTML='✔︎ Copy';
  copy.addEventListener('click', ()=>{
    navigator.clipboard?.writeText(key);
    copy.innerHTML='✅ Copied';
    setTimeout(()=>copy.innerHTML='✔︎ Copy', 1200);
  });
  c1.append(ico, ktx, copy);

  // col2: time left (countdown)
  const c2 = document.createElement('div'); c2.className='key-col';
  const time = document.createElement('span'); time.className='key-text';
  c2.append(time);

  // col3: status badge
  const c3 = document.createElement('div'); c3.className='key-col';
  const badge = document.createElement('span'); badge.className='badge badge--active'; badge.textContent='ACTIVE';
  c3.append(badge);

  // col4: +24H
  const c4 = document.createElement('div'); c4.className='key-col'; c4.style.justifyContent='flex-start';
  const plus = document.createElement('button'); plus.className='action-btn'; plus.innerHTML='👤 + 24H';
  plus.addEventListener('click', ()=>{
    endAt += 24 * HOUR;
  });
  c4.append(plus);

  row.append(c1,c2,c3,c4);
  keyList.innerHTML = '';
  keyList.append(row);

  // countdown
  function tick(){
    const left = Math.max(0, Math.floor((endAt - Date.now())/1000));
    time.textContent = fmt(left);
    requestAnimationFrame(tick);
  }
  endAt = Date.now() + msLeft;
  tick();
}

// ========== Button flows ==========
btnStart.addEventListener('click', ()=>{
  setProgress(1);
  btnStart.classList.add('is-hidden');
  btnNext.classList.remove('is-hidden');
});

btnNext.addEventListener('click', ()=>{
  setProgress(2);
  btnNext.classList.add('is-hidden');
  const key = 'zZnFp...kwocw';           // เดโม่คีย์
  const startMs = 48 * HOUR;              // เวลาเริ่ม 48 ชั่วโมง
  buildKeyRow(key, startMs);
});

btnNewKey.addEventListener('click', ()=>{
  // ทำไว้โชว์ปุ่มเฉยๆ (ของจริงค่อยผูก API)
  alert('You can get a new key after the timer expires.');
});

// init
setProgress(0);
