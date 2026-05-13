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
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  // Single chromium project is enough; webkit / firefox add cost without
  // catching anything different for these pure-function checks.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
