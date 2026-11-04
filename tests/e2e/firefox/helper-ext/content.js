// Relays page -> background: web content cannot navigate to moz-extension:// itself.
window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.__tmOpen) browser.runtime.sendMessage({ open: e.data.__tmOpen });
});
