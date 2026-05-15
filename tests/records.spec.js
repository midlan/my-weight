import { test, expect } from './fixtures.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'public', 'index.html')).href;

// Tests for the records-related helpers: findDuplicateRecord,
// recordsAsList, recordsCount, recordMatchesValues. Top-level `let
// records` lives in the realm's lexical environment and is reachable
// from page.evaluate, so we can prime it directly before each call.
test.beforeEach(async ({ page, context }) => {
  await context.route(/^https?:\/\//, route => route.abort());
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
});

test.describe('findDuplicateRecord()', () => {
  test('returns "" (no duplicate) when records is empty', async ({ page }) => {
    const out = await page.evaluate(() => {
      records = {};
      return findDuplicateRecord('2026-05-13T07:14:00.000Z');
    });
    expect(out).toBe('');
  });

  test('returns the matching key when a record exists at that minute', async ({ page }) => {
    const out = await page.evaluate(() => {
      records = { '2026-05-13T07:14:00.000Z': { weight: 72.5 } };
      return findDuplicateRecord('2026-05-13T07:14:30.000Z');
    });
    expect(out).toBe('2026-05-13T07:14:00.000Z');
  });

  test('does not match a record at a different minute', async ({ page }) => {
    const out = await page.evaluate(() => {
      records = { '2026-05-13T07:14:00.000Z': { weight: 72.5 } };
      return findDuplicateRecord('2026-05-13T07:15:00.000Z');
    });
    expect(out).toBe('');
  });

  test('excludeKey lets a record collide with itself without flagging', async ({ page }) => {
    const out = await page.evaluate(() => {
      records = { '2026-05-13T07:14:00.000Z': { weight: 72.5 } };
      return findDuplicateRecord('2026-05-13T07:14:00.000Z', '2026-05-13T07:14:00.000Z');
    });
    expect(out).toBe('');
  });

  test('returns "" for input that doesn\'t parse as a date', async ({ page }) => {
    const out = await page.evaluate(() => {
      records = { '2026-05-13T07:14:00.000Z': { weight: 72.5 } };
      return findDuplicateRecord('not-a-date');
    });
    expect(out).toBe('');
  });
});

test.describe('recordsAsList()', () => {
  test('returns [] when records is empty', async ({ page }) => {
    const list = await page.evaluate(() => {
      records = {};
      return recordsAsList();
    });
    expect(list).toEqual([]);
  });

  test('sorts ascending by datetime and hoists the key into each entry', async ({ page }) => {
    const list = await page.evaluate(() => {
      // Intentionally inserted out of order.
      records = {
        '2026-05-15T07:00:00.000Z': { weight: 71.0 },
        '2026-05-13T07:14:00.000Z': { weight: 72.5 },
        '2026-05-14T07:14:00.000Z': { weight: 72.0, note: 'po běhu' },
      };
      return recordsAsList();
    });
    expect(list).toEqual([
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
      { datetime: '2026-05-14T07:14:00.000Z', weight: 72.0, note: 'po běhu' },
      { datetime: '2026-05-15T07:00:00.000Z', weight: 71.0 },
    ]);
  });
});

test.describe('recordsCount()', () => {
  test('matches Object.keys(records).length', async ({ page }) => {
    const cases = await page.evaluate(() => {
      const out = [];
      records = {};
      out.push(recordsCount());
      records = { 'a': {}, 'b': {} };
      out.push(recordsCount());
      records = { 'x': {}, 'y': {}, 'z': {} };
      out.push(recordsCount());
      return out;
    });
    expect(cases).toEqual([0, 2, 3]);
  });
});

test.describe('recordMatchesValues()', () => {
  test('matches when datetime (at minute), weight, and note are all equal', async ({ page }) => {
    const match = await page.evaluate(() => recordMatchesValues(
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5, note: 'po běhu' },
      '2026-05-13T07:14:30.000Z',   // sub-minute drift OK
      72.5,
      'po běhu',
    ));
    expect(match).toBe(true);
  });

  test('treats missing note and empty string as the same', async ({ page }) => {
    const match = await page.evaluate(() => recordMatchesValues(
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
      '2026-05-13T07:14:00.000Z',
      72.5,
      '',
    ));
    expect(match).toBe(true);
  });

  test('mismatches when weight differs', async ({ page }) => {
    const match = await page.evaluate(() => recordMatchesValues(
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
      '2026-05-13T07:14:00.000Z',
      72.6,
      '',
    ));
    expect(match).toBe(false);
  });

  test('mismatches when the typed datetime is in a different minute', async ({ page }) => {
    const match = await page.evaluate(() => recordMatchesValues(
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
      '2026-05-13T07:15:00.000Z',
      72.5,
      '',
    ));
    expect(match).toBe(false);
  });

  test('mismatches when note differs', async ({ page }) => {
    const match = await page.evaluate(() => recordMatchesValues(
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5, note: 'a' },
      '2026-05-13T07:14:00.000Z',
      72.5,
      'b',
    ));
    expect(match).toBe(false);
  });
});
