# Keep the Backup format compatible with chromium-tab-migrator

TabVault is a rewrite of [chromium-tab-migrator](https://github.com/rennerdo30/chromium-tab-migrator),
but it keeps that project's Backup file layout (schema 1.x) instead of designing a new one, so
files move between the two extensions in both directions and existing users' files keep working.
Changes to the format are additive and optional (1.1 only added a tab's `index`); renaming or
removing fields needs a new major version and is avoided. See [backup-format.md](../backup-format.md).
