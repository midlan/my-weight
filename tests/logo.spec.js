import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the source HTML + icon.svg from disk and pre-inline the SVG so
// `LOGO_AVAILABLE = !!document.querySelector('#logo .seg-1-a')` is true
// at script-load time (it's a const, can't be flipped after the fact).
// The CI workflow does the same substitution at deploy time via perl;
// we replicate it here so the tests exercise the same shape users see.
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const iconSvg = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon.svg'), 'utf8');
const builtHtml = indexHtml.replace(/<img\s+[^>]*\bdata-inline-svg\b[^>]*\/?>/, iconSvg);

test.beforeEach(async ({ page, context }) => {
  await context.route(/^https?:\/\//, route => route.abort());
  await page.setContent(builtHtml, { waitUntil: 'domcontentloaded' });
});

// Helper: collect the seg-* / dp-after-* class names of every element
// currently carrying `.on`, sorted alphabetically for stable equality.
async function lit(page) {
  // SVG elements expose className as SVGAnimatedString (not a string),
  // so go through getAttribute('class') instead of .className.match.
  return page.evaluate(() => Array.from(document.querySelectorAll('#logo .on'))
    .map(el => {
      const cls = el.getAttribute('class') || '';
      const m = cls.match(/\b(?:seg-\d-[a-g]|dp-after-\d)\b/);
      return m ? m[0] : null;
    })
    .filter(Boolean)
    .sort());
}

test.describe('displayLogoWeight()', () => {
  test('72.5 — blank, "7", "2", ".", "5"', async ({ page }) => {
    await page.evaluate(() => displayLogoWeight(72.5));
    expect(await lit(page)).toEqual([
      // "7" at position 1 → a, b, c
      'seg-1-a', 'seg-1-b', 'seg-1-c',
      // "2" at position 2 → a, b, g, e, d
      'seg-2-a', 'seg-2-b', 'seg-2-d', 'seg-2-e', 'seg-2-g',
      // "5" at position 3 → a, f, g, c, d
      'seg-3-a', 'seg-3-c', 'seg-3-d', 'seg-3-f', 'seg-3-g',
      'dp-after-2',
    ].sort());
  });

  test('0 — blank, blank, "0", ".", "0"', async ({ page }) => {
    await page.evaluate(() => displayLogoWeight(0));
    expect(await lit(page)).toEqual([
      // "0" at position 2 → a, b, c, d, e, f
      'seg-2-a', 'seg-2-b', 'seg-2-c', 'seg-2-d', 'seg-2-e', 'seg-2-f',
      // "0" at position 3
      'seg-3-a', 'seg-3-b', 'seg-3-c', 'seg-3-d', 'seg-3-e', 'seg-3-f',
      'dp-after-2',
    ].sort());
  });

  test('100 — "1", "0", "0", ".", "0"', async ({ page }) => {
    await page.evaluate(() => displayLogoWeight(100));
    expect(await lit(page)).toEqual([
      // "1" at position 0 → b, c
      'seg-0-b', 'seg-0-c',
      'seg-1-a', 'seg-1-b', 'seg-1-c', 'seg-1-d', 'seg-1-e', 'seg-1-f',
      'seg-2-a', 'seg-2-b', 'seg-2-c', 'seg-2-d', 'seg-2-e', 'seg-2-f',
      'seg-3-a', 'seg-3-b', 'seg-3-c', 'seg-3-d', 'seg-3-e', 'seg-3-f',
      'dp-after-2',
    ].sort());
  });

  test('199.9 — the cap, all integer positions filled', async ({ page }) => {
    await page.evaluate(() => displayLogoWeight(199.9));
    expect(await lit(page)).toEqual([
      'seg-0-b', 'seg-0-c',                                                  // "1"
      'seg-1-a', 'seg-1-b', 'seg-1-c', 'seg-1-d', 'seg-1-f', 'seg-1-g',     // "9"
      'seg-2-a', 'seg-2-b', 'seg-2-c', 'seg-2-d', 'seg-2-f', 'seg-2-g',     // "9"
      'seg-3-a', 'seg-3-b', 'seg-3-c', 'seg-3-d', 'seg-3-f', 'seg-3-g',     // "9"
      'dp-after-2',
    ].sort());
  });

  test('values above 199.9 clamp to 199.9', async ({ page }) => {
    const above = await page.evaluate(() => { displayLogoWeight(250); return Array.from(document.querySelectorAll('#logo .on')).map(el => el.getAttribute('class')); });
    const cap = await page.evaluate(() => { displayLogoWeight(199.9); return Array.from(document.querySelectorAll('#logo .on')).map(el => el.getAttribute('class')); });
    expect(above).toEqual(cap);
  });

  test('negative values clamp to 0', async ({ page }) => {
    const neg = await page.evaluate(() => { displayLogoWeight(-5); return Array.from(document.querySelectorAll('#logo .on')).map(el => el.getAttribute('class')); });
    const zero = await page.evaluate(() => { displayLogoWeight(0); return Array.from(document.querySelectorAll('#logo .on')).map(el => el.getAttribute('class')); });
    expect(neg).toEqual(zero);
  });

  test('sub-0.1 differences round to one decimal', async ({ page }) => {
    const a = await page.evaluate(() => { displayLogoWeight(72.55); return Array.from(document.querySelectorAll('#logo .on')).map(el => el.getAttribute('class')); });
    const b = await page.evaluate(() => { displayLogoWeight(72.6); return Array.from(document.querySelectorAll('#logo .on')).map(el => el.getAttribute('class')); });
    expect(a).toEqual(b);
  });

  test('successive calls fully reset prior segment state', async ({ page }) => {
    // 199.9 lights up many segments at position 0; 72.5 should leave
    // position 0 entirely blank.
    await page.evaluate(() => { displayLogoWeight(199.9); displayLogoWeight(72.5); });
    const pos0Lit = await page.evaluate(() => Array.from(document.querySelectorAll('#logo [class*="seg-0-"]'))
      .some(el => el.classList.contains('on')));
    expect(pos0Lit).toBe(false);
  });
});

test.describe('updateLogoFromLatest()', () => {
  test('with no records → displays the 72.5 placeholder', async ({ page }) => {
    await page.evaluate(() => { records = {}; updateLogoFromLatest(); });
    expect(await lit(page)).toEqual([
      'seg-1-a', 'seg-1-b', 'seg-1-c',
      'seg-2-a', 'seg-2-b', 'seg-2-d', 'seg-2-e', 'seg-2-g',
      'seg-3-a', 'seg-3-c', 'seg-3-d', 'seg-3-f', 'seg-3-g',
      'dp-after-2',
    ].sort());
  });

  test('picks the newest record by datetime', async ({ page }) => {
    await page.evaluate(() => {
      records = {
        '2025-01-01T07:00:00.000Z': { weight: 80 },     // older
        '2026-05-13T07:00:00.000Z': { weight: 72.5 },   // newest
        '2024-06-15T07:00:00.000Z': { weight: 90 },     // oldest
      };
      updateLogoFromLatest();
    });
    // 72.5: blank, "7", "2", ".", "5"
    expect(await lit(page)).toEqual([
      'seg-1-a', 'seg-1-b', 'seg-1-c',
      'seg-2-a', 'seg-2-b', 'seg-2-d', 'seg-2-e', 'seg-2-g',
      'seg-3-a', 'seg-3-c', 'seg-3-d', 'seg-3-f', 'seg-3-g',
      'dp-after-2',
    ].sort());
  });

  test('clamps the newest record\'s weight at 199.9', async ({ page }) => {
    await page.evaluate(() => {
      records = { '2026-05-13T07:00:00.000Z': { weight: 250 } };
      updateLogoFromLatest();
    });
    expect(await lit(page)).toEqual([
      'seg-0-b', 'seg-0-c',
      'seg-1-a', 'seg-1-b', 'seg-1-c', 'seg-1-d', 'seg-1-f', 'seg-1-g',
      'seg-2-a', 'seg-2-b', 'seg-2-c', 'seg-2-d', 'seg-2-f', 'seg-2-g',
      'seg-3-a', 'seg-3-b', 'seg-3-c', 'seg-3-d', 'seg-3-f', 'seg-3-g',
      'dp-after-2',
    ].sort());
  });
});
