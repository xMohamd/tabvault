import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { createFakeBrowser } from './helpers/fake-browser';

describe('fake browser helper', () => {
  let fb: ReturnType<typeof createFakeBrowser>;
  beforeEach(() => {
    fb = createFakeBrowser();
  });

  it('is what modules see through wxt/browser', async () => {
    const { window } = fb.seedWindow({}, ['https://a.example/']);
    const all = await browser.windows.getAll({ populate: true });
    expect(all.map((w) => w.id)).toContain(window.id);
  });

  it('rejects a top-level windowId in tabs.group (regression guard)', async () => {
    const { window, tabs } = fb.seedWindow({}, ['https://a.example/']);
    await expect(
      (browser.tabs.group as (o: unknown) => Promise<number>)({ tabIds: [tabs[0].id], windowId: window.id }),
    ).rejects.toThrow(/Unexpected property/);
  });
});
