async function getKey() {
  const res = await fetch('/api/getkey', { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    console.log('KEY:', data.key, 'remain', data.remainingSeconds);
  }
}

async function checkKey(k) {
  const res = await fetch('/api/check/' + encodeURIComponent(k));
  return res.json();
}

async function extendKey(k, hours=5) {
  const res = await fetch('/api/extend/' + encodeURIComponent(k), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-token': '<OPTIONAL_TOKEN>' },
    body: JSON.stringify({ hours })
  });
  return res.json();
}
