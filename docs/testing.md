# Testing

TabVault is tested at four levels. The first two run in milliseconds without a browser; the
last two load the built extension into real browsers.

| Level | What | Where | Command |
|---|---|---|---|
| Unit and integration | Library modules, the background's message handlers, a full Export → Restore round trip | `tests/*.test.ts` | `pnpm test` |
| Popup components | The React UI rendered in happy-dom, with the background mocked | `tests/popup/*.test.ts` | `pnpm test` |
| Real Chrome | Smoke test and feature checks over the DevTools Protocol | `tests/e2e/smoke.mjs`, `features.mjs` | `pnpm test:e2e`, `pnpm test:e2e:features` |
| Real Firefox | The same flows plus Firefox-only behaviour, over WebDriver BiDi | `tests/e2e/firefox.mjs` | `pnpm test:e2e:firefox` |
| Accessibility | axe-core over every popup state in light and dark, keyboard, reduced motion, 200%/400% zoom | `tests/e2e/a11y.mjs` | `pnpm test:a11y` |

`pnpm check` runs the type check, `pnpm test`, both builds and Mozilla's `web-ext lint`.

## The strict fake browser

Unit tests run against `tests/helpers/fake-browser.ts`, an in-memory browser installed onto
WXT's `fakeBrowser`. It is deliberately **strict**: it rejects calls the way real browsers do
(for example, `tabs.group` refuses a top-level `windowId`, as Chrome does). A permissive mock
would let such bugs pass; this one caught a real bug the original extension shipped with.
See [ADR 0007](adr/0007-strict-fake-browser.md). When a test needs a browser rule the fake
doesn't know yet, add the rule to the fake rather than loosening the test.

## Running the real-browser tests

```bash
# Chrome: needs Chrome for Testing or Chromium. Branded Chrome ignores --load-extension.
npx @puppeteer/browsers install chrome@stable
CHROME=/path/to/chrome pnpm test:e2e
CHROME=/path/to/chrome pnpm test:e2e:features
CHROME=/path/to/chrome pnpm test:a11y

# Firefox: uses /usr/bin/firefox unless FIREFOX is set.
pnpm test:e2e:firefox
```

- `NO_SANDBOX=1` where the system blocks Chrome's sandbox (for example Ubuntu 24+ with AppArmor).
- Firefox: `NO_HEADLESS=1` shows the window; `KEEP=1` keeps the temporary profile. Snap Firefox
  can't read `/tmp`, so the test keeps its files under `$HOME`.
- Firefox won't let the test driver open `moz-extension://` pages, so a tiny helper extension
  (`tests/e2e/firefox/helper-ext`) opens them on the test's behalf.

These scripts are plain Node programs (no test framework): each check prints `ok` or `FAIL`, and
the script exits non-zero if any check failed.

## Writing tests

- **New library code:** a unit test next to the others in `tests/`. Use the fake browser; don't
  stub browser APIs ad hoc.
- **New UI:** a popup test in `tests/popup/` using Testing Library queries by role and label,
  with `routeSend()` (`tests/popup/helpers.ts`) answering the background's messages.
- **New screens or states:** add them to the accessibility audit.
- **Browser behaviour that a fake can't prove** (downloads on disk, the real scroll lock, tab
  discarding): add a check to `features.mjs` or `firefox.mjs`.
- **Regressions:** a test that fails without the fix. Several e2e checks exist for exactly this,
  such as the popup size and the full-tab layout with a menu open.

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **check:** type check, unit and component tests, both builds as zips (uploaded as
   artifacts) and the Firefox lint.
2. **e2e:** downloads Chrome for Testing and Firefox, then runs the smoke test, the feature
   checks, the accessibility audit and the Firefox test.

If unit tests time out locally only, check the machine's load first: under heavy load the
component tests can exceed their timeouts without anything being wrong.
