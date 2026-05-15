import { defineConfig } from '@playwright/test';

// Pure-function tests against the source public/index.html. Page.evaluate
// calls top-level functions (migrate, toMinuteKey, etc.) which become
// window.* properties because the inline script is a regular <script>
// (not type=module). No UI smoke is done here — the deploy workflow's
// curl-based post-deploy smoke covers that.
export default defineConfig({
  testDir: '.',
  // Block external script loads (gapi, gis, chart.js) so the page settles
  // quickly and console isn't noisy with network errors. Our tests don't
  // need them — the functions under test are pure and synchronous.
  use: {
    headless: true,
    // The app uses Intl with undefined locale (= browser locale). Pin
    // the test browser to cs-CZ so locale-driven formatting (datetime
    // strings, number separators) is deterministic — matches the
    // app's primary audience.
    locale: 'cs-CZ',
  },
  // monocart-reporter runs in both modes so the coverage HTML is
  // produced on CI (uploaded as an artifact by the deploy workflow)
  // as well as locally. ['github'] reporter is CI-only — it emits
  // annotations and a job summary that only render on GH Actions.
  reporter: [
    ['list'],
    ...(process.env.CI ? [['github']] : []),
    ['monocart-reporter', {
      name: 'my-weight coverage',
      outputFile: './coverage-reports/report.html',
      coverage: {
        // All specs goto the pre-inlined `.test-built.html` (see
        // fixtures.js). That single source path collects every
        // tests's coverage — including the logo functions, which
        // only run when the SVG is present at script-load.
        entryFilter: (entry) => /public\/\.test-built\.html$/.test(entry.url || ''),
        sourceFilter: (sourcePath) => /public\/\.test-built\.html$/.test(sourcePath),
        outputDir: './coverage-reports/coverage',
        reports: ['v8', 'console-summary', 'lcov', 'json-summary'],
      },
    }],
  ],
  // Two dimensions of projects: suite (unit / smoke) × browser
  // (chromium / webkit / firefox). Each combination is its own
  // Playwright project so the deploy workflow can pick exact subsets
  // and so per-browser failures show up distinctly in reports.
  //
  // Cross-browser matters because public users are on more than
  // Chromium — iOS Safari is the only browser on iPhone (and the
  // only PWA-install path there), and Webkit + Firefox each have
  // their own Intl / localStorage / popup quirks.
  //
  // V8 coverage in fixtures.js is gated to chromium (page.coverage
  // is a chromium-only API), so the coverage report numbers reflect
  // the chromium runs.
  projects: [
    ...['chromium', 'webkit', 'firefox'].flatMap(browserName => [
      {
        name: `unit-${browserName}`,
        testIgnore: ['**/smoke.spec.js'],
        use: { browserName },
      },
      {
        name: `smoke-${browserName}`,
        testMatch: ['**/smoke.spec.js'],
        use: { browserName },
      },
    ]),
  ],
});
