# Releasing

## Version

The version comes from `package.json` (`"version"`), and WXT copies it into both manifests.
Use `MAJOR.MINOR.PATCH`; stores reject a version that is not higher than the published one.

The extension version is separate from the [Backup format](backup-format.md) version.
Change `SCHEMA_VERSION` only when the file layout changes.

## Build

```bash
pnpm check           # type check, tests, both builds, Firefox lint
pnpm zip             # .output/tabvault-<version>-chrome.zip
pnpm zip:firefox     # .output/tabvault-<version>-firefox.zip and -sources.zip
```

Run the real-browser tests too (see [testing](testing.md)), or rely on a green CI run for the
commit you release. CI also uploads both zips as artifacts.

## Chrome Web Store (and Edge Add-ons)

1. Upload the Chrome zip. The same zip works for Edge Add-ons, Opera and other Chromium stores.
2. Listing: name **TabVault**, the short description from `_locales/en/messages.json`
   (`extDescription`), and screenshots from `docs/screenshots/` (Chrome accepts 1280×800 or
   640×400, so place the popup images on a canvas of that size).
3. Privacy: link to [privacy.md](privacy.md) as the privacy policy, state that no data is
   collected, and copy the permission reasons from it.
4. Single purpose: "Back up, search and restore tabs, tab groups and bookmarks."

## Firefox Add-ons (AMO)

1. Upload the Firefox zip.
2. Upload the **sources zip** when asked. The code is bundled, so reviewers rebuild it; tell
   them: `pnpm install && pnpm build:firefox` (Node 22, pnpm).
3. The add-on ID is fixed in `wxt.config.ts` (`browser_specific_settings.gecko.id`). Never
   change it after the first upload: AMO treats a new ID as a different add-on.
4. Data collection is declared in the manifest as none (`data_collection_permissions`).

## After release

Tag the released commit, so the exact code of every version stays easy to find:

```bash
git tag v<version>
git push origin v<version>
```
