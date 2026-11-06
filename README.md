# TabVault

<p align="center">
  <img src="public/logo.svg" alt="TabVault logo" width="112" height="112">
</p>

Back up and move tabs, tab groups and bookmarks between Chromium browsers and Firefox.
Built with [WXT](https://wxt.dev), React, TypeScript, Tailwind CSS v4 and [shadcn/ui](https://ui.shadcn.com) (Radix primitives, lucide icons). Design tokens: zinc neutrals with a teal accent and the bundled Geist font; every text color meets WCAG AA (4.5:1) in both themes. This is a rewrite of the
plain-JS [chromium-tab-migrator](https://github.com/rennerdo30/chromium-tab-migrator) reference implementation with the same features
and the same backup format (schema 1.1), so files move freely between the two.

## Supported browsers

| Browser | Export | Import | Notes |
|---|---|---|---|
| Chrome, Edge, Brave, Vivaldi | ✅ | ✅ | Real tab groups |
| Opera | ✅ | ✅ | Tab groups. Workspaces are exported as groups but can't be created: no API exists |
| Firefox 140+ | ✅ | ✅ | Tab groups; background tabs are created already unloaded |
| Safari | — | — | Not supported: Safari Web Extensions lack the bookmarks, downloads and tab group APIs |

Browsers without tab groups get one window per group. Capabilities are probed from the
APIs at runtime, not guessed from the browser name.

## Features

- **Export** tabs, groups and bookmarks to JSON, with a domain filter (exact host or
  subdomain), skipping browser/extension pages, recovering the real address of suspended
  tabs, and window size/position.
- **Import** this extension's backups, OneTab text, Session Buddy backups and JSON exports
  ([documented format](https://www.sessionbuddy.com/formats/#json): saved collections and
  browser-closed history, with tab groups and window layout), bookmark HTML,
  Firefox bookmark JSON, or a plain list of URLs. Preview and pick windows/groups first.
  Tabs keep their order, pinned state and groups; they can stay unloaded, open as a light
  placeholder page, or load normally. Bookmarks merge into the matching folders, go into a
  dated folder, or replace the existing ones (after a confirmation and an automatic
  safety snapshot). Anything that couldn't be restored is listed with the reason.
- **Suspended tabs** from tab-suspender extensions (placeholder pages with a `url=` or
  `uri=` parameter) are restored as the real page, on export and on import.
  In the toolbar popup, choosing a file opens the Import page in a tab: browsers close a
  popup when a file dialog takes focus, which would lose the file. Dropping a file onto
  the popup works directly.
- **Password-protected backups**: Export can encrypt the file (PBKDF2-SHA256, 600,000
  rounds, AES-256-GCM); Import asks for the password. The password is never stored or
  logged. Snapshots kept inside the browser are not encrypted.
- **Restore options**: into new windows or the current window, add tabs to existing groups
  with the same name, and on Firefox reopen tabs in their containers (created if missing).
- **Search inside a backup** and restore only the matching tabs.
- **Quick save**: right-click the toolbar icon or a page ("Save this window" / "Save this
  tab group"), or use the shortcuts Alt+Shift+S (save window), Alt+Shift+B (back up now)
  and Alt+Shift+M (open the popup). Change them at chrome://extensions/shortcuts.
- **Compare two snapshots**: tabs, groups and bookmarks added or removed.
- **Bookmarklets** (`javascript:` bookmarks) have their own option under Bookmarks on both
  Export and Import, on by default. The import summary says how many a file contains,
  since a bookmarklet runs code on the page you click it on. Restored tabs never open
  `javascript:` addresses.
- **Backups**: automatic snapshots (hourly, daily or weekly, keeping the last N), optionally
  also written as files to Downloads/TabVault (so they survive removing the extension), plus
  "back up now", restore, download and delete. Stored only in this browser.
- Restores run in the background, so closing the popup doesn't stop them.
- Light and dark themes, keyboard accessible, localized via `_locales`.
- No network access and no remote code. "Copy diagnostics" excludes URLs.

## Install from source

```bash
pnpm install
pnpm build           # Chrome/Edge/Brave/Opera/Vivaldi -> .output/chrome-mv3
pnpm build:firefox   # Firefox                         -> .output/firefox-mv3
```

- **Chromium browsers:** open `chrome://extensions`, turn on Developer mode, click
  **Load unpacked** and pick `.output/chrome-mv3`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary
  Add-on** and pick `.output/firefox-mv3/manifest.json`.

Each build gets its own manifest: Chrome's uses `background.service_worker`, Firefox's
uses `background.scripts`, so neither browser warns about unsupported keys.

## Development

```bash
pnpm dev             # Chrome with hot reload
pnpm dev:firefox     # Firefox with hot reload
pnpm typecheck       # strict TypeScript
pnpm test            # Vitest: unit, integration and popup component tests
pnpm zip             # store-ready zip (pnpm zip:firefox also writes the sources zip)
pnpm lint:firefox    # Mozilla's web-ext lint on the Firefox build
pnpm check           # all of the above in one go

# Real-browser smoke test: builds, loads the extension in headless Chrome for Testing,
# and checks export, backups, restore order/groups/discard, lazy mode and popup size.
# Branded Chrome ignores --load-extension. NO_SANDBOX=1 where AppArmor blocks namespaces.
CHROME=/path/to/chrome-for-testing pnpm test:e2e

# Accessibility audit: axe-core over every popup state in light + dark, plus keyboard,
# reduced-motion and 200%/400% zoom checks. Fails on serious/critical (and moderate) issues.
CHROME=/path/to/chrome-for-testing pnpm test:a11y

# Real Firefox (WebDriver BiDi via puppeteer-core): export, snapshots, restore with
# discarded tabs, groups and lazy mode, bookmark strategies, UI file import.
pnpm test:e2e:firefox    # FIREFOX=/path/to/firefox to override /usr/bin/firefox
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, both builds, the Firefox lint and
uploads the zips; a second job runs the Chrome smoke test, the accessibility audit and the
real-Firefox test in downloaded browsers.

### Layout

```
src/
├── entrypoints/
│   ├── background.ts        # message handlers, import runner, alarms, downloads
│   ├── popup/               # React UI: App shell + components/ (Export, Import, Backups)
│   └── lazy/                # placeholder page for "don't load" restores (/lazy.html)
├── components/ui/           # shadcn/ui components (generated by the shadcn CLI, owned by us)
├── assets/globals.css       # Tailwind + theme tokens (dark mode follows <html data-theme>)
└── lib/
    ├── types.ts             # popup <-> background protocol and shared result types
    ├── messaging.ts         # typed send() for the popup
    ├── schema.ts            # backup format 1.1: types, validation, counting, ordering
    ├── url-utils.ts         # internal/blank URLs, domain matching, suspended-tab unwrap
    ├── browser-detect.ts    # identity from UA, capabilities from APIs
    ├── exporter.ts, importer.ts, backup-scheduler.ts, logger.ts, i18n.ts, theme.ts
    ├── adapters/            # tab-adapter (windows/tabs/groups), bookmarks-adapter
    └── formats/             # OneTab, Session Buddy, bookmark HTML/JSON, URL list
components.json              # shadcn config: add components with `npx shadcn@latest add <name>`
tests/
├── helpers/fake-browser.ts  # strict in-memory browser, installed onto WXT's fakeBrowser
├── *.test.ts, popup/        # Vitest
└── e2e/smoke.mjs            # real headless Chrome over CDP
public/                      # icons (rendered), logo, _locales
assets-src/                  # icon sources: icon.svg, simplified icon-16.svg
```

Tests use a strict fake browser: for example, `tabs.group` rejects a top-level `windowId`
the way Chrome does, which guards against a real bug the original extension shipped with.

## Credits

This project is based on [chromium-tab-migrator](https://github.com/rennerdo30/chromium-tab-migrator) by rennerdo30, released
under the MIT License (see [LICENSE](LICENSE)). It started from that extension's code and
design, and extends it with a rewrite on WXT, React and TypeScript and additional features.

## License

MIT, see [LICENSE](LICENSE).
