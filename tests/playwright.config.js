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
  // Two projects:
  //   - `unit` runs the mocked Drive / GIS suite against the local
  //     pre-inlined .test-built.html (everything except smoke.spec.js).
  //   - `smoke` runs only smoke.spec.js, which hits a live deployed
  //     URL from `SMOKE_URL` and is invoked by the deploy workflow
  //     after a successful deploy.
  // The deploy workflow restricts each step to its own project so the
  // pre-deploy run doesn't try to reach a (nonexistent) SMOKE_URL and
  // the post-deploy run doesn't re-execute the offline unit suite.
  projects: [
    {
      name: 'unit',
      testIgnore: ['**/smoke.spec.js'],
      use: { browserName: 'chromium' },
    },
    {
      name: 'smoke',
      testMatch: ['**/smoke.spec.js'],
      use: { browserName: 'chromium' },
    },
  ],
});
