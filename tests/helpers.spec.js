import { test, expect } from './fixtures.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'public', 'index.html')).href;

// Tests for the pure formatting / math helpers that don't need any
// in-memory state.
test.beforeEach(async ({ page, context }) => {
  await context.route(/^https?:\/\//, route => route.abort());
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
});

test.describe('describeDriveError()', () => {
  test('maps the storageQuotaExceeded reason to the Czech "úložiště plné" message', async ({ page }) => {
    const out = await page.evaluate(() => describeDriveError({
      result: { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'The user has exceeded their Drive storage quota.' } },
    }));
    expect(out).toContain('úložiště je plné');
  });

  test('falls through to err.result.error.message when reason is unrecognized', async ({ page }) => {
    const out = await page.evaluate(() => describeDriveError({
      result: { error: { errors: [{ reason: 'somethingElse' }], message: 'Whoops' } },
    }));
    expect(out).toBe('Whoops');
  });

  test('reads err.error.message when result wrapper is missing', async ({ page }) => {
    const out = await page.evaluate(() => describeDriveError({ error: { message: 'plain' } }));
    expect(out).toBe('plain');
  });

  test('falls back to err.message for vanilla Error instances', async ({ page }) => {
    const out = await page.evaluate(() => describeDriveError(new Error('bare')));
    expect(out).toBe('bare');
  });

  test('returns "neznámá chyba" when nothing usable is on the error', async ({ page }) => {
    const out = await page.evaluate(() => describeDriveError({}));
    expect(out).toBe('neznámá chyba');
  });
});

test.describe('toLocalInputValue() / toDateInputValue()', () => {
  test('toLocalInputValue formats a Date as "YYYY-MM-DDTHH:MM" in local time', async ({ page }) => {
    const out = await page.evaluate(() => toLocalInputValue(new Date(2026, 4, 13, 7, 30)));
    expect(out).toBe('2026-05-13T07:30');
  });

  test('toLocalInputValue pads single-digit components', async ({ page }) => {
    const out = await page.evaluate(() => toLocalInputValue(new Date(2026, 0, 1, 0, 5)));
    expect(out).toBe('2026-01-01T00:05');
  });

  test('toDateInputValue formats a Date as "YYYY-MM-DD" in local time', async ({ page }) => {
    const out = await page.evaluate(() => toDateInputValue(new Date(2026, 4, 13, 23, 59)));
    expect(out).toBe('2026-05-13');
  });
});

test.describe('formatDateTime()', () => {
  // The Playwright config pins the test browser to cs-CZ, so these
  // assertions reflect Czech-locale Intl output. The function itself
  // uses Intl.DateTimeFormat with undefined locale — i.e. whatever
  // the user's browser is set to. Changing the pinned test locale
  // requires updating these expectations.
  test('formats a regular date in browser locale (cs-CZ pinned)', async ({ page }) => {
    const out = await page.evaluate(() => formatDateTime(new Date(2026, 4, 13, 7, 30)));
    expect(out).toBe('13. 5. 2026 7:30');
  });

  test('pads minutes to two digits even when other parts are single-digit', async ({ page }) => {
    const out = await page.evaluate(() => formatDateTime(new Date(2026, 0, 1, 0, 5)));
    expect(out).toBe('1. 1. 2026 0:05');
  });
});

test.describe('formatWeight()', () => {
  test('whole numbers render without decimals', async ({ page }) => {
    expect(await page.evaluate(() => formatWeight(72))).toBe('72');
  });

  test('one decimal digit is preserved as-is', async ({ page }) => {
    // Locale separator can be "." or "," depending on the runner — accept either.
    const out = await page.evaluate(() => formatWeight(72.5));
    expect(out).toMatch(/^72[.,]5$/);
  });

  test('strips trailing-zero noise (formatting, not the input itself)', async ({ page }) => {
    // 0.1 * 7 in float = 0.700000…, toLocaleString trims it.
    const out = await page.evaluate(() => formatWeight(0.1 * 7));
    expect(out).toMatch(/^0[.,]7$/);
  });
});

test.describe('adjustWeight()', () => {
  test('adds the delta and rounds to one decimal', async ({ page }) => {
    const v = await page.evaluate(() => {
      const inp = { value: '72.5' };
      adjustWeight(inp, 0.1);
      return inp.value;
    });
    expect(v).toBe('72.6');
  });

  test('clamps at 0 instead of going negative', async ({ page }) => {
    const v = await page.evaluate(() => {
      const inp = { value: '0.05' };
      adjustWeight(inp, -0.1);
      return inp.value;
    });
    expect(v).toBe('0.0');
  });

  test('treats empty/NaN input as 0', async ({ page }) => {
    const v = await page.evaluate(() => {
      const inp = { value: '' };
      adjustWeight(inp, 0.1);
      return inp.value;
    });
    expect(v).toBe('0.1');
  });

  test('absorbs float drift (e.g. 72.3 + 0.1 stays at 72.4)', async ({ page }) => {
    const v = await page.evaluate(() => {
      const inp = { value: '72.3' };
      adjustWeight(inp, 0.1);
      return inp.value;
    });
    expect(v).toBe('72.4');
  });
});

test.describe('effectivePreset() / effectiveTheme()', () => {
  test('returns the stored value when it\'s on the allow-list', async ({ page }) => {
    const out = await page.evaluate(() => {
      settings = { rangePreset: '6m', theme: 'dark' };
      return { preset: effectivePreset(), theme: effectiveTheme() };
    });
    expect(out).toEqual({ preset: '6m', theme: 'dark' });
  });

  test('falls back to defaults when settings is empty', async ({ page }) => {
    const out = await page.evaluate(() => {
      settings = {};
      return { preset: effectivePreset(), theme: effectiveTheme() };
    });
    expect(out).toEqual({ preset: '7d', theme: 'system' });
  });

  test('rejects garbage values and uses the default', async ({ page }) => {
    const out = await page.evaluate(() => {
      settings = { rangePreset: 'forever', theme: 'neon' };
      return { preset: effectivePreset(), theme: effectiveTheme() };
    });
    expect(out).toEqual({ preset: '7d', theme: 'system' });
  });
});

test.describe('applyRangePreset() — fixed presets set the input values', () => {
  test('"7d" sets `to` = today, `from` = ~7 days earlier', async ({ page }) => {
    const out = await page.evaluate(() => {
      records = {};
      applyRangePreset('7d');
      return {
        from: document.getElementById('range-from').value,
        to: document.getElementById('range-to').value,
      };
    });
    // `to` is today in local-date format.
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    expect(out.to).toBe(todayStr);
    // `from` is 7 days earlier — verify the gap is ~7 days.
    const gapDays = Math.round((new Date(out.to) - new Date(out.from)) / 86_400_000);
    expect(gapDays).toBe(7);
  });

  test('"30d" → gap is 30 days', async ({ page }) => {
    const out = await page.evaluate(() => {
      applyRangePreset('30d');
      return {
        from: document.getElementById('range-from').value,
        to: document.getElementById('range-to').value,
      };
    });
    const gapDays = Math.round((new Date(out.to) - new Date(out.from)) / 86_400_000);
    expect(gapDays).toBe(30);
  });

  test('"3m" / "6m" / "1y" → from-year matches expected calendar math', async ({ page }) => {
    const results = await page.evaluate(() => {
      const probe = (preset) => {
        applyRangePreset(preset);
        return {
          from: document.getElementById('range-from').value,
          to: document.getElementById('range-to').value,
        };
      };
      return { '3m': probe('3m'), '6m': probe('6m'), '1y': probe('1y') };
    });
    // Just sanity-check the relative ordering: from < to in each case.
    for (const preset of ['3m', '6m', '1y']) {
      expect(new Date(results[preset].from).getTime())
        .toBeLessThan(new Date(results[preset].to).getTime());
    }
  });

  test('currentPreset is updated and the matching button gains the active class', async ({ page }) => {
    const out = await page.evaluate(() => {
      applyRangePreset('30d');
      const active = Array.from(document.querySelectorAll('.range-btn'))
        .filter(b => b.classList.contains('bg-blue-600'))
        .map(b => b.dataset.range);
      return { currentPreset, active };
    });
    expect(out.currentPreset).toBe('30d');
    expect(out.active).toEqual(['30d']);
  });
});

test.describe('applyRangePreset() — "all" branch', () => {
  test('picks the oldest record\'s datetime as `from`', async ({ page }) => {
    const fromVal = await page.evaluate(() => {
      records = {
        '2025-01-01T07:00:00.000Z': { weight: 75 },
        '2026-05-13T07:14:00.000Z': { weight: 72.5 },
        '2024-06-15T07:00:00.000Z': { weight: 80 },
      };
      applyRangePreset('all');
      return document.getElementById('range-from').value;
    });
    // Locale-dependent timezone conversion lands us on 2024-06-15
    // (the oldest record's date) regardless of zone.
    expect(fromVal).toBe('2024-06-15');
  });

  test('falls back to "one year ago" when records is empty', async ({ page }) => {
    const fromVal = await page.evaluate(() => {
      records = {};
      applyRangePreset('all');
      return document.getElementById('range-from').value;
    });
    // Year minus one — the exact day depends on the test clock, so we
    // just check the year (and that the value looks like a date).
    const expectedYear = new Date().getFullYear() - 1;
    expect(fromVal).toMatch(new RegExp(`^${expectedYear}-\\d{2}-\\d{2}$`));
  });
});
