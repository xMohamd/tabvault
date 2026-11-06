import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * WXT generates one manifest per target browser, so each build only contains
 * keys that browser understands (Chrome: background.service_worker,
 * Firefox: background.scripts). No more cross-browser manifest warnings.
 *
 * Build:  pnpm build            -> .output/chrome-mv3
 *         pnpm build:firefox    -> .output/firefox-mv3
 */
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  // Explicit imports everywhere: easier to read, test and mock.
  imports: false,
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    short_name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: [
      'tabs',
      'tabGroups',
      'bookmarks',
      'downloads',
      'storage',
      'unlimitedStorage',
      'alarms',
      'contextMenus',
      // Firefox containers: read names/colors and reopen tabs in them.
      ...(browser === 'firefox' ? ['contextualIdentities', 'cookies'] : []),
    ],
    // Suggested keys avoid Alt+Shift, which many systems use to switch keyboard layout
    // (it swallows Alt+Shift+<key> before the browser sees it), and keys the browsers
    // already own (Alt+Shift+B = Chrome's "focus bookmarks bar"; Ctrl+Shift+K/E/Y in
    // Firefox; Ctrl+Shift+U = Linux Unicode input). Chrome applies suggested keys only on
    // first install; users can change them in the browser's shortcut settings.
    commands: {
      _execute_action: {
        suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
      },
      'backup-now': {
        suggested_key: { default: 'Ctrl+Shift+Period', mac: 'Command+Shift+Period' },
        description: '__MSG_commandBackupNow__',
      },
      'save-window': {
        suggested_key: { default: 'Ctrl+Shift+Comma', mac: 'Command+Shift+Comma' },
        description: '__MSG_commandSaveWindow__',
      },
    },
    incognito: 'not_allowed',
    action: {
      default_title: '__MSG_extActionTitle__',
    },
    // The lazy placeholder page is opened via tabs.create with an extension URL;
    // no web_accessible_resources needed because pages never embed it.
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: '{7ee0807c-6729-4612-a8a7-897c09851973}',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
            gecko_android: { strict_min_version: '142.0' },
          },
        }
      : {
          minimum_chrome_version: '102',
        }),
  }),
});
