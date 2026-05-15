// Accessibility scan using axe-core. Runs against the same
// .test-built.html the offline unit suite uses, but in its own
// `a11y` project so it doesn't multiply across browsers (axe
// violations are DOM-content checks; the result is browser-
// independent, so running cross-browser would be duplicate work).
//
// Each test sets up a distinct UI state (auth, app with records,
// menu open, privacy modal open) and asserts axe finds no
// WCAG 2.0/2.1 AA violations on that state. The shared mock setup
// from auth.spec.js (MOCK_INIT) isn't needed here — we drive the
// app's top-level functions directly via page.evaluate to land the
// DOM in the state we want to scan.

import AxeBuilder from '@axe-core/playwright';
import { test, expect, PAGE_URL } from './fixtures.js';

test.beforeEach(async ({ page, context }) => {
  // Block external script loads (gapi, gis, chart.js) so the page
  // settles quickly and axe scans a deterministic DOM.
  await context.route(/accounts\.google\.com|apis\.google\.com|googleapis\.com|gstatic\.com|jsdelivr\.net/, r => r.abort());
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  // Tailwind isn't built in test runs; the `.hidden` class needs the
  // utility rule to behave correctly so axe doesn't trip over
  // off-screen-but-not-hidden elements.
  await page.addStyleTag({ content: '.hidden { display: none !important; }' });
});

async function scan(page) {
  return await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
}

function violationSummary(violations) {
  return violations.map(v => `${v.id} (${v.impact}): ${v.help}\n  nodes: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`).join('\n\n');
}

test('auth section: no axe violations', async ({ page }) => {
  // attemptAutoLogin only runs once gapi + gis have loaded, and those
  // are blocked by the route filter — so the page stays on the
  // loading section by default. Force the auth section visible so
  // axe scans the surface a real first-visit user would see.
  await page.evaluate(() => showSection('auth'));
  await expect(page.locator('#auth-section')).toBeVisible();
  const { violations } = await scan(page);
  expect(violations, violationSummary(violations)).toEqual([]);
});

test('app section with records: no axe violations', async ({ page }) => {
  // Sidestep the auth flow — drop into the app section directly with
  // a couple of records so the history list, chart container, form,
  // and menu trigger are all in the DOM.
  await page.evaluate(() => {
    records = {
      '2026-05-13T07:00:00.000Z': { weight: 72.5 },
      '2026-05-14T07:00:00.000Z': { weight: 72.3, note: 'po běhu' },
    };
    settings = { rangePreset: '7d' };
    recordsLoaded = true;
    fileId = 'fake-file-id';
    revisionId = 'rev1';
    showSection('app');
    renderRecords();
  });
  await expect(page.locator('#app-section')).toBeVisible();
  const { violations } = await scan(page);
  expect(violations, violationSummary(violations)).toEqual([]);
});

test('menu overlay open: no axe violations', async ({ page }) => {
  await page.evaluate(() => {
    records = { '2026-05-13T07:00:00.000Z': { weight: 72.5 } };
    settings = {};
    recordsLoaded = true;
    fileId = 'fake-file-id';
    revisionId = 'rev1';
    showSection('app');
    renderRecords();
  });
  await page.locator('#menu-btn').click();
  await expect(page.locator('#menu-overlay')).toBeVisible();
  const { violations } = await scan(page);
  expect(violations, violationSummary(violations)).toEqual([]);
});
