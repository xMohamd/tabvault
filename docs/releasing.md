# Releasing

## Version

The version comes from `package.json` (`"version"`), and WXT copies it into both manifests.
Use `MAJOR.MINOR.PATCH`; stores reject a version that is not higher than the published one.

The extension version is separate from the [Backup format](backup-format.md) version.
Change `SCHEMA_VERSION` only when the file layout changes.

## Release

1. Bump `"version"` in `package.json`, commit, and push to `main`.
2. Tag that commit and push the tag:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

The **Release** workflow (`.github/workflows/release.yml`) then:

1. checks that the tag matches `package.json` (otherwise it stops with an error);
2. runs the full CI, including the real-browser tests;
3. builds `tabvault-<version>-chrome.zip`, `-firefox.zip` and `-sources.zip`;
4. creates a GitHub Release with the three zips and notes grouped by commit type
   (`.github/release-notes.sh`).

A tag with a suffix, such as `v1.1.0-beta.1`, becomes a pre-release. If the workflow fails,
fix the problem, delete the tag (`git push origin :v1.1.0 && git tag -d v1.1.0`) and tag again.

Uploading to the stores is manual for now, using the zips attached to the release.

To build the zips by hand instead:

```bash
pnpm check           # type check, tests, both builds, Firefox lint
pnpm zip             # .output/tabvault-<version>-chrome.zip
pnpm zip:firefox     # .output/tabvault-<version>-firefox.zip and -sources.zip
```

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
