import { test as base, expect } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inlineSvg } from '../scripts/inline-svg.mjs';

// All specs goto this one URL — a temp file in public/ that mirrors
// the deployed shape (icon.svg pre-inlined at the <img data-inline-svg>
// marker). This way:
//   - logo.spec.js can use page.goto like every other spec instead of
//     page.setContent (which V8 attributes to "about:blank", so its
//     coverage wouldn't merge with the rest);
//   - one source path = one merged coverage entry in the report;
//   - the deploy workflow's CLI invocation of inline-svg.mjs is the
//     production source of truth — tests just import the same module
//     so the substitution rule lives in exactly one place.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_HTML = path.join(__dirname, '..', 'public', 'index.html');
const SRC_SVG = path.join(__dirname, '..', 'public', 'icon.svg');
const BUILT_HTML = path.join(__dirname, '..', 'public', '.test-built.html');

// Idempotent build — each Playwright worker imports this module and
// re-runs the substitution; safe to overwrite. The exact-one check
// in inlineSvg() catches a missing or duplicated marker the same
// way the CI step does.
{
  const html = fs.readFileSync(SRC_HTML, 'utf8');
  const svg = fs.readFileSync(SRC_SVG, 'utf8');
  const { html: built, count } = inlineSvg(html, svg);
  if (count !== 1) {
    throw new Error(`fixtures.js: expected 1 <img data-inline-svg> in ${SRC_HTML}, found ${count}`);
  }
  fs.writeFileSync(BUILT_HTML, built);
}

export const PAGE_URL = pathToFileURL(BUILT_HTML).href;

// Wraps Playwright's `test` to start V8 coverage before each test
// and feed it into monocart's global coverage report after. Runs in
// both modes — the CI deploy workflow uploads the generated HTML as
// an artifact so anyone can browse coverage without a local dev env.
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const coverage = await page.coverage.stopJSCoverage();
    await addCoverageReport(coverage, testInfo);
  },
});

export { expect };
