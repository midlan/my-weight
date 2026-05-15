import { test as base, expect } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// All specs goto this one URL — a temp file in public/ that mirrors
// the deployed shape (icon.svg pre-inlined at the <img data-inline-svg>
// marker). This way:
//   - logo.spec.js can use page.goto like every other spec instead of
//     page.setContent (which V8 attributes to "about:blank", so its
//     coverage wouldn't merge with the rest);
//   - one source path = one merged coverage entry in the report;
//   - the deploy workflow's perl-based inliner stays the source of
//     truth for production — tests just replicate its effect.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_HTML = path.join(__dirname, '..', 'public', 'index.html');
const SRC_SVG = path.join(__dirname, '..', 'public', 'icon.svg');
const BUILT_HTML = path.join(__dirname, '..', 'public', '.test-built.html');

// Idempotent build — each Playwright worker imports this module and
// re-runs the substitution; safe to overwrite.
{
  const html = fs.readFileSync(SRC_HTML, 'utf8');
  const svg = fs.readFileSync(SRC_SVG, 'utf8');
  const built = html.replace(/<img\s+[^>]*\bdata-inline-svg\b[^>]*\/?>/, svg);
  fs.writeFileSync(BUILT_HTML, built);
}

export const PAGE_URL = pathToFileURL(BUILT_HTML).href;

// Wraps Playwright's `test` to start V8 coverage before each test
// and feed it into monocart's global coverage report after. Only
// fires locally — CI runs the github reporter and skips coverage.
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
