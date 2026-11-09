# Save files through data: URLs and import modules statically in the background

Chromium runs the background as a service worker, which has no `URL.createObjectURL` and forbids
dynamic `import()`. So `downloads.ts` hands the downloads API a `data:` URL there (Firefox's event
page still gets a Blob URL), and the background imports the exporter and every other module
statically, even where lazy loading would look tidier. Changing either back breaks Export,
Snapshots or backup files in Chromium only, which unit tests can't catch; the real-Chrome
tests cover it.
