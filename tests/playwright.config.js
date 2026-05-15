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
  reporter: process.env.CI
    ? [['list'], ['github']]
    : [
        ['list'],
        ['monocart-reporter', {
          name: 'my-weight coverage',
          outputFile: './coverage-reports/report.html',
          coverage: {
            // Only count coverage attributed to the file:// load of
            // public/index.html. logo.spec.js's page.setContent
            // exercises the same code but V8 attributes it to a
            // separate "blank" source — including it would
            // double-count and drag the headline down. Logo
            // coverage shows up via the other specs that hit the
            // SAME functions on initial paint.
            entryFilter: (entry) => /public\/index\.html$/.test(entry.url || ''),
            sourceFilter: (sourcePath) => /public\/index\.html$/.test(sourcePath),
            outputDir: './coverage-reports/coverage',
            reports: ['v8', 'console-summary', 'lcov', 'json-summary'],
          },
        }],
      ],
  // Single chromium project is enough; webkit / firefox add cost without
  // catching anything different for these pure-function checks.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
