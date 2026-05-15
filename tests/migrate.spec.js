import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'public', 'index.html')).href;

// Load the source HTML once per test. file:// is fine — we only need the
// inline <script> to parse and define top-level functions on window. The
// external script tags (gapi, gis, chart.js, tailwind) get blocked so
// they don't error out asynchronously and pollute the console.
test.beforeEach(async ({ page, context }) => {
  await context.route(/^https?:\/\//, route => route.abort());
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
});

test.describe('migrate()', () => {
  test('v2 envelope passes through unchanged', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 2,
      records: { '2026-05-13T07:14:00.000Z': { weight: 72.5 } },
      settings: { rangePreset: '30d' },
    }));
    expect(result.records).toEqual({
      '2026-05-13T07:14:00.000Z': { weight: 72.5 },
    });
    expect(result.settings).toEqual({ rangePreset: '30d' });
    expect(result.migrated).toBe(false);
    expect(Boolean(result.unrecognized)).toBe(false);
  });

  test('v1 envelope migrates array → object and sets migrated', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [
        { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
        { datetime: '2026-05-13T07:31:00.000Z', weight: 72.3, note: 'po běhu' },
      ],
      settings: { theme: 'dark' },
    }));
    expect(result.records).toEqual({
      '2026-05-13T07:14:00.000Z': { weight: 72.5 },
      '2026-05-13T07:31:00.000Z': { weight: 72.3, note: 'po běhu' },
    });
    expect(result.settings).toEqual({ theme: 'dark' });
    expect(result.migrated).toBe(true);
  });

  test('bare-array (pre-versioning legacy) migrates to v2', async ({ page }) => {
    const result = await page.evaluate(() => migrate([
      { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
    ]));
    expect(result.records).toEqual({
      '2026-05-13T07:14:00.000Z': { weight: 72.5 },
    });
    expect(result.migrated).toBe(true);
  });

  test('per-record {date} legacy converts to noon-local ISO', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      records: [{ date: '2026-05-13', weight: 72.5 }],
    }));
    const keys = Object.keys(result.records);
    expect(keys).toHaveLength(1);
    // Noon local → UTC: exact hour varies with the runner's timezone, but
    // the date and minute/second portions are deterministic.
    expect(keys[0]).toMatch(/^2026-05-13T\d{2}:00:00\.000Z$/);
    expect(result.records[keys[0]]).toEqual({ weight: 72.5 });
    expect(result.migrated).toBe(true);
  });

  test('sub-minute datetimes are normalized to the start of the minute', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [{ datetime: '2026-05-13T07:14:32.456Z', weight: 72.5 }],
    }));
    expect(result.records).toEqual({
      '2026-05-13T07:14:00.000Z': { weight: 72.5 },
    });
    expect(result.migrated).toBe(true);
  });

  test('records without weight (or with non-numeric weight) are dropped', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [
        { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
        { datetime: '2026-05-13T08:00:00.000Z' }, // no weight
        { datetime: '2026-05-13T09:00:00.000Z', weight: 'not-a-number' },
      ],
    }));
    expect(Object.keys(result.records)).toEqual(['2026-05-13T07:14:00.000Z']);
    expect(result.migrated).toBe(true);
  });

  test('empty file content (null) → empty v2, migrated true', async ({ page }) => {
    const result = await page.evaluate(() => migrate(null));
    expect(result.records).toEqual({});
    expect(result.migrated).toBe(true);
    expect(Boolean(result.unrecognized)).toBe(false);
  });

  test('records:"garbage" is flagged unrecognized, not rewritten', async ({ page }) => {
    const result = await page.evaluate(() => migrate({ records: 'garbage' }));
    expect(result.records).toEqual({});
    expect(result.unrecognized).toBe(true);
    expect(result.migrated).toBe(false); // critically: no rewrite
  });

  test('v1 file with every record malformed is flagged unrecognized', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [
        { weight: 'not a number' },
        { date: 'invalid' },
      ],
    }));
    expect(result.records).toEqual({});
    expect(result.unrecognized).toBe(true);
    expect(result.migrated).toBe(false);
  });

  test('partial corruption keeps the good records, drops the bad ones', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [
        { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
        { weight: 'not a number' }, // dropped
      ],
    }));
    expect(Object.keys(result.records)).toHaveLength(1);
    expect(result.migrated).toBe(true);
    expect(Boolean(result.unrecognized)).toBe(false);
  });

  test('duplicate same-minute records — last write wins, flagged migrated', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [
        { datetime: '2026-05-13T07:14:00.000Z', weight: 72.5 },
        { datetime: '2026-05-13T07:14:30.000Z', weight: 73.0 },
      ],
    }));
    expect(result.records).toEqual({
      '2026-05-13T07:14:00.000Z': { weight: 73.0 },
    });
    expect(result.migrated).toBe(true);
  });

  test('future schema version on load → reload code path runs, isReloadPending set', async ({ page }) => {
    // location.reload itself is [Unforgeable] in Chromium so we can't
    // stub it. The migrate code does `location.reload()` immediately
    // before throwing the isReloadPending error, so observing the
    // throw with the flag + the sessionStorage guard being set is
    // sufficient evidence the reload code path executed.
    const result = await page.evaluate(() => {
      sessionStorage.removeItem('my-weight:reloaded-for-newer-schema');
      try {
        migrate({ version: 99, records: {} });
        return { thrown: false };
      } catch (e) {
        return {
          thrown: true,
          isReloadPending: Boolean(e.isReloadPending),
          flagSet: sessionStorage.getItem('my-weight:reloaded-for-newer-schema'),
        };
      }
    });
    expect(result.thrown).toBe(true);
    expect(result.isReloadPending).toBe(true);
    expect(result.flagSet).toBe('1');
  });

  test('future schema version on load with guard already set → surfaces error, does NOT reload again', async ({ page }) => {
    const result = await page.evaluate(() => {
      sessionStorage.setItem('my-weight:reloaded-for-newer-schema', '1');
      try {
        migrate({ version: 99, records: {} });
        return { thrown: false };
      } catch (e) {
        return {
          thrown: true,
          isReloadPending: Boolean(e.isReloadPending),
          newerSchemaVersion: e.newerSchemaVersion,
          message: e.message,
        };
      }
    });
    expect(result.thrown).toBe(true);
    expect(result.isReloadPending).toBe(false);     // no second reload
    expect(result.newerSchemaVersion).toBe(99);
    expect(result.message).toContain('99');
  });

  test('future schema version on import surfaces the version, no reload', async ({ page }) => {
    const err = await page.evaluate(() => {
      try {
        migrate({ version: 99, records: {} }, { source: 'import' });
        return null;
      } catch (e) {
        return {
          message: e.message,
          newerSchemaVersion: e.newerSchemaVersion,
          isReloadPending: Boolean(e.isReloadPending),
        };
      }
    });
    expect(err).not.toBeNull();
    expect(err.newerSchemaVersion).toBe(99);
    expect(err.isReloadPending).toBe(false);
  });

  test('settings field is preserved across migration', async ({ page }) => {
    const result = await page.evaluate(() => migrate({
      version: 1,
      records: [],
      settings: { rangePreset: '6m', theme: 'light' },
    }));
    expect(result.settings).toEqual({ rangePreset: '6m', theme: 'light' });
  });
});

test.describe('toMinuteKey()', () => {
  test('truncates seconds and milliseconds to the start of the minute', async ({ page }) => {
    expect(await page.evaluate(() => toMinuteKey('2026-05-13T07:14:32.456Z')))
      .toBe('2026-05-13T07:14:00.000Z');
  });

  test('returns empty string for non-string / undefined / NaN input', async ({ page }) => {
    expect(await page.evaluate(() => toMinuteKey(null))).toBe('');
    expect(await page.evaluate(() => toMinuteKey(undefined))).toBe('');
    expect(await page.evaluate(() => toMinuteKey('not a date'))).toBe('');
    expect(await page.evaluate(() => toMinuteKey(123))).toBe('');
  });
});
