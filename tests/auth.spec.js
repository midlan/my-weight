import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'public', 'index.html')).href;

// Mock harness for window.google / window.gapi / window.fetch — installed
// via addInitScript so it runs before the inline app script. Real Google
// hosts are blocked via context.route, so the GIS / gapi <script src>
// tags fail to load but the mock globals are already in place by then.
//
// Per-test knobs (set via page.evaluate before triggering the action):
//   __mock.tokenIsValid         — controls whether 401 fires from network
//   __mock.silentReauthSucceeds — whether `requestAccessToken({prompt:'none'})`
//                                  resolves OK or fires error_callback
//   __mock.forceNextGetError    — one-shot { status, message } for
//                                  drive.files.get (consumed on the next call)
//   __mock.forceNextFetchError  — one-shot for upload fetch (PATCH/POST)
const MOCK_INIT = `
(() => {
  window.__mock = {
    files: Object.create(null),
    revisionCounter: 1,
    nextFileId: 1,
    tokenIsValid: true,
    silentReauthSucceeds: true,
    forceNextGetError: null,
    forceNextFetchError: null,
    calls: [],
    addFile(name, body) {
      const id = 'file' + (this.nextFileId++);
      const rev = 'rev' + (this.revisionCounter++);
      this.files[id] = { name, headRevisionId: rev, body };
      return id;
    },
    getFile(name) {
      for (const id in this.files) {
        if (this.files[id].name === name) return Object.assign({ id }, this.files[id]);
      }
      return null;
    },
  };

  function authError() {
    const err = new Error('auth required');
    err.status = 401;
    err.result = { error: { code: 401, message: 'Invalid Credentials' } };
    return err;
  }
  function forcedErr(spec) {
    const err = new Error(spec.message || 'forced');
    err.status = spec.status;
    err.result = { error: { code: spec.status, message: err.message } };
    return err;
  }

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (opts) => ({
          requestAccessToken(o) {
            const prompt = (o && o.prompt) || '';
            window.__mock.calls.push({ type: 'requestAccessToken', prompt });
            if (prompt === 'none' && !window.__mock.silentReauthSucceeds) {
              setTimeout(() => opts.error_callback({ type: 'popup_failed_to_open' }), 0);
              return;
            }
            window.__mock.tokenIsValid = true;
            setTimeout(() => opts.callback({
              access_token: 'fake_token_' + Date.now(),
              expires_in: 3600,
            }), 0);
          }
        }),
        revoke: () => { window.__mock.calls.push({ type: 'revoke' }); },
      },
    },
  };

  window.gapi = {
    load: (name, cb) => { window.__mock.calls.push({ type: 'gapi.load' }); setTimeout(cb, 0); },
    client: {
      init: async () => { window.__mock.calls.push({ type: 'gapi.client.init' }); },
      setToken: () => { window.__mock.calls.push({ type: 'gapi.client.setToken' }); },
      drive: {
        files: {
          list: async ({ q } = {}) => {
            window.__mock.calls.push({ type: 'drive.files.list', q });
            if (!window.__mock.tokenIsValid) throw authError();
            const match = q && q.match(/name='([^']+)'/);
            const target = match ? match[1] : null;
            const files = [];
            for (const id in window.__mock.files) {
              const f = window.__mock.files[id];
              if (!target || f.name === target) files.push({ id, name: f.name, headRevisionId: f.headRevisionId });
            }
            return { result: { files } };
          },
          get: async ({ fileId, alt, fields } = {}) => {
            window.__mock.calls.push({ type: 'drive.files.get', fileId, alt, fields });
            if (window.__mock.forceNextGetError) {
              const f = window.__mock.forceNextGetError;
              window.__mock.forceNextGetError = null;
              if (f.status === 401) window.__mock.tokenIsValid = false;
              throw forcedErr(f);
            }
            if (!window.__mock.tokenIsValid) throw authError();
            const f = window.__mock.files[fileId];
            if (!f) {
              const err = new Error('not found');
              err.status = 404;
              err.result = { error: { code: 404 } };
              throw err;
            }
            if (alt === 'media') return { body: f.body };
            if (fields === 'headRevisionId') return { result: { headRevisionId: f.headRevisionId } };
            return { result: {} };
          },
          delete: async ({ fileId } = {}) => {
            window.__mock.calls.push({ type: 'drive.files.delete', fileId });
            if (!window.__mock.tokenIsValid) throw authError();
            delete window.__mock.files[fileId];
            return {};
          },
        },
      },
    },
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    init = init || {};
    const url = typeof input === 'string' ? input : input.url;
    if (url.indexOf('upload/drive/v3/files') >= 0) {
      window.__mock.calls.push({ type: 'upload.fetch', method: init.method });
      if (window.__mock.forceNextFetchError) {
        const f = window.__mock.forceNextFetchError;
        window.__mock.forceNextFetchError = null;
        if (f.status === 401) window.__mock.tokenIsValid = false;
        return new Response(JSON.stringify({ error: { code: f.status, message: f.message || '' } }), { status: f.status });
      }
      if (!window.__mock.tokenIsValid) {
        return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
      }
      if (init.method === 'PATCH') {
        const idMatch = url.match(/files\\/([^?]+)/);
        const fileId = idMatch ? idMatch[1] : null;
        const body = await new Response(init.body).text();
        const f = window.__mock.files[fileId];
        if (f) {
          f.body = body;
          f.headRevisionId = 'rev' + (window.__mock.revisionCounter++);
        }
        return new Response(JSON.stringify({ id: fileId, headRevisionId: f && f.headRevisionId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (init.method === 'POST') {
        // Multipart create — for our purposes just register a new file
        // with empty body; tests that need the body can read it from
        // __mock.files[id].body after the upload.
        const id = window.__mock.addFile('weight_records.json', '{}');
        return new Response(JSON.stringify({ id, headRevisionId: window.__mock.files[id].headRevisionId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return origFetch(input, init);
  };
})();
`;

test.beforeEach(async ({ page, context }) => {
  await context.route(/accounts\.google\.com|apis\.google\.com|googleapis\.com|gstatic\.com|jsdelivr\.net/, r => r.abort());
  await page.addInitScript(MOCK_INIT);
  // Default: accept any dialog. Individual tests that need to inspect
  // a dialog message override this with their own listener BEFORE
  // triggering the action.
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(PAGE_URL);
});

test('initial load with no Drive file → auth section visible, login button shown', async ({ page }) => {
  await expect(page.locator('#auth-section')).toBeVisible();
  await expect(page.locator('#login-btn')).toBeVisible();
  await expect(page.locator('#app-section')).toBeHidden();
});

test('login + load existing v2 file → records render in history', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: {
      '2026-05-13T07:00:00.000Z': { weight: 72.5 },
      '2026-05-14T07:00:00.000Z': { weight: 72.3, note: 'po běhu' },
    },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const count = await page.evaluate(() => recordsCount());
  expect(count).toBe(2);
  // Newest record (72.3) should be the first history row.
  await expect(page.locator('#history-list li').first()).toContainText('72,3 kg');
});

test('legacy v1 file gets rewritten as v2 on first load', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 1,
    records: [{ datetime: '2026-05-13T07:00:00.000Z', weight: 72.5 }],
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // After the rewrite, the file on the "server" should be v2 shape.
  const onDisk = await page.evaluate(() => JSON.parse(__mock.getFile('weight_records.json').body));
  expect(onDisk.version).toBe(2);
  expect(onDisk.records).toEqual({ '2026-05-13T07:00:00.000Z': { weight: 72.5 } });
});

test('mid-session 401 → silent reauth recovers, save still succeeds', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Force the next Drive call to 401. saveRecord's preflight
  // (readRemoteRevision -> gapi.drive.files.get fields:headRevisionId)
  // will hit it; withReauth should silently re-auth and retry.
  await page.evaluate(() => { __mock.forceNextGetError = { status: 401 }; });

  await page.locator('#weight').fill('72.5');
  await page.locator('#weight-form button[type=submit]').click();

  // Record should land in history despite the 401.
  await expect(page.locator('#history-list li').first()).toContainText('72,5 kg');

  // Verify silent reauth was actually requested.
  const reauthed = await page.evaluate(() =>
    __mock.calls.some(c => c.type === 'requestAccessToken' && c.prompt === 'none'));
  expect(reauthed).toBe(true);
});

test('mid-session 401 + silent reauth fails → fatal 401, auth section shown', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Force the 401 AND make silent reauth fail. Capture the alert.
  let alertMessage = '';
  page.removeAllListeners('dialog');
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  await page.evaluate(() => {
    __mock.forceNextGetError = { status: 401 };
    __mock.silentReauthSucceeds = false;
  });

  await page.locator('#weight').fill('72.5');
  await page.locator('#weight-form button[type=submit]').click();

  await expect(page.locator('#auth-section')).toBeVisible();
  expect(alertMessage).toContain('Přihlášení vypršelo');

  // In-memory state should be wiped (records, fileId, etc.).
  const state = await page.evaluate(() => ({ count: recordsCount() }));
  expect(state.count).toBe(0);
});

test('wipe with correct confirmation → file deleted, records cleared', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // prompt() for the typed confirmation; alert() for the "deleted" message.
  page.removeAllListeners('dialog');
  let finalAlert = '';
  page.on('dialog', d => {
    if (d.type() === 'prompt') d.accept('smazat vše');
    else { finalAlert = d.message(); d.accept(); }
  });

  await page.locator('#menu-btn').click();
  await page.locator('#wipe-btn').click();

  // Wait for the post-wipe alert to land.
  await expect.poll(() => finalAlert, { timeout: 5000 }).toContain('smazána');

  // File gone from the "server".
  const stillThere = await page.evaluate((id) => !!__mock.files[id], fileId);
  expect(stillThere).toBe(false);
  // In-memory records cleared.
  const count = await page.evaluate(() => recordsCount());
  expect(count).toBe(0);
  // App section still visible (not auth) — user remains logged in.
  await expect(page.locator('#app-section')).toBeVisible();
});

test('wipe with mismatched confirmation → file preserved, mismatch alert', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => {
    if (d.type() === 'prompt') d.accept('wrong text');
    else { alertMessage = d.message(); d.accept(); }
  });

  await page.locator('#menu-btn').click();
  await page.locator('#wipe-btn').click();

  await expect.poll(() => alertMessage, { timeout: 5000 }).toContain('neshoduje');

  // File untouched.
  const stillThere = await page.evaluate((id) => !!__mock.files[id], fileId);
  expect(stillThere).toBe(true);
  // Records still in memory.
  const count = await page.evaluate(() => recordsCount());
  expect(count).toBe(1);
});

test('logout clears state and shows auth section', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Open menu, click logout.
  await page.locator('#menu-btn').click();
  await page.locator('#logout-btn').click();

  await expect(page.locator('#auth-section')).toBeVisible();
  const state = await page.evaluate(() => ({
    count: recordsCount(),
    hasToken: !!localStorage.getItem('my-weight:token'),
  }));
  expect(state.count).toBe(0);
  expect(state.hasToken).toBe(false);
  // google.accounts.oauth2.revoke should have been called.
  const revoked = await page.evaluate(() =>
    __mock.calls.some(c => c.type === 'revoke'));
  expect(revoked).toBe(true);
});
