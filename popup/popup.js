chrome.storage.sync.get(['apiKey'], r => {
  if (r.apiKey) document.getElementById('key').value = r.apiKey;
});
document.getElementById('save').onclick = () => {
  const key = document.getElementById('key').value.trim();
  chrome.storage.sync.set({ apiKey: key }, () => {
    const st = document.getElementById('st');
    st.textContent = key ? '✓ saved' : '✓ cleared';
    setTimeout(() => { st.textContent = ''; }, 2000);
  });
};
