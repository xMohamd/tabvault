browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.open) return browser.tabs.create({ url: msg.open }).then((t) => ({ id: t.id }), (e) => ({ error: String(e) }));
});
