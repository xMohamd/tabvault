import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { _resetI18nCache, t, tp } from '@/lib/i18n';

const MESSAGES: Record<string, string> = {
  hello: 'Hello',
  greeting: 'Hi {0}',
  items_one: '{0} item',
  items_other: '{0} items',
  single_other: 'many {0}',
};

function install(language = 'en') {
  (browser as unknown as { i18n: unknown }).i18n = {
    getUILanguage: () => language,
    getMessage: (key: string, subs?: string | string[]) => {
      const text = MESSAGES[key];
      if (text === undefined) return '';
      const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
      return text.replace(/\{(\d)\}/g, (_, i: string) => list[Number(i)] ?? '');
    },
  };
  _resetI18nCache();
}

beforeEach(() => install());

describe('t', () => {
  it('returns the message', () => {
    expect(t('hello')).toBe('Hello');
  });

  it('returns the key when the message is missing', () => {
    expect(t('nope')).toBe('nope');
  });

  it('stringifies substitutions', () => {
    expect(t('greeting', 3)).toBe('Hi 3');
    expect(t('greeting', ['Ada'])).toBe('Hi Ada');
  });

  it('survives a missing or throwing i18n API', () => {
    (browser as unknown as { i18n: unknown }).i18n = {
      getMessage: () => {
        throw new Error('invalidated');
      },
    };
    expect(t('hello')).toBe('hello');
    (browser as unknown as { i18n: unknown }).i18n = undefined;
    expect(t('hello')).toBe('hello');
  });
});

describe('tp', () => {
  it('picks _one for 1 and _other otherwise', () => {
    expect(tp('items', 1, '1')).toBe('1 item');
    expect(tp('items', 0, '0')).toBe('0 items');
    expect(tp('items', 5, '5')).toBe('5 items');
  });

  it('falls back to _other when the category has no message', () => {
    expect(tp('single', 1, 'x')).toBe('many x');
  });

  it('returns <key>_other when nothing exists', () => {
    expect(tp('ghost', 2)).toBe('ghost_other');
  });
});

describe('count labels', () => {
  it('have a singular for one and a plural for other counts', async () => {
    const messages = (await import('../public/_locales/en/messages.json')).default as Record<string, { message: string }>;
    for (const [one, other] of [['Tab', 'Tabs'], ['Window', 'Windows'], ['Group', 'Groups'], ['Bookmark', 'Bookmarks']]) {
      expect(messages[`label${other}_one`]?.message).toBe(one);
      expect(messages[`label${other}_other`]?.message).toBe(other);
      expect(messages[`label${other}`]).toBeUndefined(); // no plural-blind key left behind
    }
    expect(messages.countTabs_one?.message).toBe('$COUNT$ tab');
    expect(messages.countTabs_other?.message).toBe('$COUNT$ tabs');
    expect(messages.countBookmarks_one?.message).toBe('$COUNT$ bookmark');
    expect(messages.countBookmarks_other?.message).toBe('$COUNT$ bookmarks');
  });
});
