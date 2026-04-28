const $ = (id) => document.getElementById(id);

async function send(msg) {
  return await chrome.runtime.sendMessage(msg);
}

async function refresh() {
  const status = await send({ type: 'popup:status' });
  const exp = await send({ type: 'popup:export' });
  const recording = !!status?.recording;
  $('statusText').textContent = recording ? 'Recording…' : 'Idle';
  $('status').classList.toggle('recording', recording);
  $('start').style.display = recording ? 'none' : 'block';
  $('stop').style.display  = recording ? 'block' : 'none';
  $('count').textContent = status?.session?.actions?.length || 0;
  $('sessionCount').textContent = exp?.sessions?.length || 0;
}

$('start').addEventListener('click', async () => {
  await send({ type: 'popup:start' });
  await refresh();
});

$('stop').addEventListener('click', async () => {
  await send({ type: 'popup:stop' });
  await refresh();
});

$('export').addEventListener('click', async () => {
  const res = await send({ type: 'popup:export' });
  const json = JSON.stringify(res.sessions || [], null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `interaction-sessions-${Date.now()}.json`,
    saveAs: true
  });
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Clear all stored sessions? This cannot be undone.')) return;
  await send({ type: 'popup:clear' });
  await refresh();
});

refresh();
setInterval(refresh, 1000);
