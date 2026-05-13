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
  },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  // Single chromium project is enough; webkit / firefox add cost without
  // catching anything different for these pure-function checks.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
