// Post-deploy smoke against the live deployed URL. Runs after the
// curl-based byte check has confirmed the HTML and static assets
// serve — this step proves the JS actually executes in a real
// browser without console errors. Catches deploy regressions the
// mocked unit suite can't:
//   - CSP changes that block inline scripts
//   - missing or moved CDN dependencies (gapi, gis, chart.js)
//   - GIS / gapi API shape changes that throw during init
//   - Tailwind classes that didn't make it into the built CSS
//
// Invoked by the deploy workflow as `--project=smoke` with
// SMOKE_URL=<deployment-url>. The unit project ignores this file,
// so the default offline suite never hits the live site.

import { test, expect } from '@playwright/test';

const SMOKE_URL = process.env.SMOKE_URL;

test('deployed page boots without console errors', async ({ page }) => {
  test.skip(!SMOKE_URL, 'SMOKE_URL env var not set — smoke is deploy-only');
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(SMOKE_URL, { waitUntil: 'load' });

  // attemptAutoLogin saw no cached token → showSection('auth') →
  // login button visible. Confirms gapi + gis loaded from the real
  // Google CDNs, the inline script reached the end of init without
  // throwing, and Tailwind classes resolve (otherwise the auth
  // section's `.hidden` toggling wouldn't behave as expected).
  await expect(page.locator('#auth-section')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#login-btn')).toBeVisible();

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
