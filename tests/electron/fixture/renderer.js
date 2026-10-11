document.querySelector('#ping').addEventListener('click', async () => {
  const result = await window.harness.ping('ping');
  document.querySelector('#result').textContent = `IPC verified · Electron ${result.electron}`;
});
