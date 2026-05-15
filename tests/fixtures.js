import { test as base, expect } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';

// Wraps Playwright's `test` to start V8 coverage before each test
// and feed it into monocart's global coverage report after. Only
// fires locally — CI runs the github reporter and skips coverage.
// The monocart `sourceFilter` in playwright.config.js drops
// everything that isn't `public/index.html`, so injected mock
// scripts don't pollute the numbers.
export const test = process.env.CI
  ? base
  : base.extend({
      page: async ({ page }, use, testInfo) => {
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        await use(page);
        const coverage = await page.coverage.stopJSCoverage();
        await addCoverageReport(coverage, testInfo);
      },
    });

export { expect };
