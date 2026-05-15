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
  // Tailwind isn't loaded from the source tree (built in CI), so
  // .hidden has no effect by default. Inject the rule manually so
  // toBeHidden() assertions on class="hidden" elements work.
  await page.addStyleTag({ content: '.hidden { display: none !important; }' });
});

test('initial load produces no JS errors (resource-fetch failures from blocked CDNs ignored)', async ({ page, context }) => {
  const errors = [];
  // Resource-load failures are expected — we block external scripts
  // and the source tree doesn't have tailwind.css. Real JS errors
  // (ReferenceError, TypeError, etc.) come through with different
  // shapes and the "Failed to load resource" filter lets them through.
  const isResourceLoad = (text) => /^Failed to load resource:/.test(text);
  page.on('console', m => {
    if (m.type() === 'error' && !isResourceLoad(m.text())) errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(e.message));
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#auth-section')).toBeVisible();
  expect(errors).toEqual([]);
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

test('saveRecord with duplicate datetime → alert with the colliding minute, no upload', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Capture the dup-detection alert.
  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => {
    if (d.type() === 'confirm') d.accept();  // (future-date confirm, etc.)
    else { alertMessage = d.message(); d.accept(); }
  });

  // Flip to custom mode and pick the colliding minute.
  await page.locator('#now-btn').click();
  // datetime-local local-time string that matches the UTC minute we have.
  const local = await page.evaluate(() => {
    const d = new Date('2026-05-13T07:00:00.000Z');
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.locator('#datetime').fill(local);
  await page.locator('#weight').fill('73.0');
  await page.locator('#weight-form button[type=submit]').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Záznam s tímto datem a časem již existuje');
  // The alert names the colliding datetime in brackets — minute precision.
  expect(alertMessage).toMatch(/\d{1,2}\. ?\d{1,2}\. ?2026 \d{1,2}:00/);

  // Nothing was uploaded — file still has only the original record.
  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(Object.keys(stored.records)).toEqual(['2026-05-13T07:00:00.000Z']);
});

test('prefillWeightInput dirty flag: typed value survives a delete, fresh value resumes after save', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: {
      '2026-05-13T07:00:00.000Z': { weight: 72.5 },
      '2026-05-14T07:00:00.000Z': { weight: 72.3 },  // newest, will get prefilled
    },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // After load, the weight input is prefilled with the newest record.
  await expect(page.locator('#weight')).toHaveValue('72.3');

  // User types something custom — input becomes dirty.
  await page.locator('#weight').fill('99.9');
  expect(await page.evaluate(() => weightInputDirty)).toBe(true);

  // Delete the newest record. Dirty input must NOT get clobbered.
  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await page.locator('li[data-key="2026-05-14T07:00:00.000Z"] button[title="Smazat"]').click();
  await expect(page.locator('li[data-key="2026-05-14T07:00:00.000Z"]')).toHaveCount(0);
  await expect(page.locator('#weight')).toHaveValue('99.9');

  // Successful save clears the dirty flag → subsequent record changes
  // re-prefill from the latest record.
  await page.locator('#weight-form button[type=submit]').click();
  await expect.poll(() => page.evaluate(() => weightInputDirty), { timeout: 3000 }).toBe(false);

  // Delete the just-saved 99.9 row. Now the newest is 72.5 again.
  const savedKey = await page.evaluate(() => {
    const list = recordsAsList();
    return list[list.length - 1].datetime;
  });
  await page.locator(`li[data-key="${savedKey}"] button[title="Smazat"]`).click();
  await expect(page.locator(`li[data-key="${savedKey}"]`)).toHaveCount(0);

  // Input should now reflect the surviving record's weight, not the
  // stale 99.9 we typed earlier.
  await expect(page.locator('#weight')).toHaveValue('72.5');
});

test('import my-weight v2 file → records merge, dedup at minute precision', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },  // pre-existing
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());  // accept "Naimportovat X záznamů?" + "Naimportováno X záznamů"

  const importFile = JSON.stringify({
    version: 2,
    records: {
      '2026-05-13T07:00:00.000Z': { weight: 71.0 },   // SAME MINUTE as existing → should dedup
      '2026-05-15T07:00:00.000Z': { weight: 70.0 },   // new
    },
  });
  await page.locator('#import-input').setInputFiles({
    name: 'my-weight-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(importFile),
  });

  // Wait for the new record to land.
  await expect(page.locator('li[data-key="2026-05-15T07:00:00.000Z"]')).toBeVisible({ timeout: 5000 });

  const after = await page.evaluate(() => recordsAsList().map(r => ({ key: r.datetime, w: r.weight })));
  expect(after).toEqual([
    { key: '2026-05-13T07:00:00.000Z', w: 72.5 },   // original preserved (dedup), not 71.0
    { key: '2026-05-15T07:00:00.000Z', w: 70.0 },
  ]);
});

test('import kaloricketabulky.cz format → records added with epoch-ms datetimes', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());

  // Kaloricketabulky format: data.values[].from is epoch-ms, value is kg.
  const epochMay13 = Date.UTC(2026, 4, 13, 7, 0, 0);
  const epochMay14 = Date.UTC(2026, 4, 14, 8, 30, 0);
  const importFile = JSON.stringify({
    data: {
      values: [
        { from: epochMay13, value: 72.5 },
        { from: epochMay14, value: 72.0 },
      ],
      target: [/* goal weight — must be ignored */ { from: epochMay13, value: 70 }],
    },
  });
  await page.locator('#import-input').setInputFiles({
    name: 'kt-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(importFile),
  });

  await expect.poll(() => page.evaluate(() => recordsCount()), { timeout: 5000 }).toBe(2);

  const after = await page.evaluate(() => recordsAsList().map(r => ({ key: r.datetime, w: r.weight })));
  expect(after).toEqual([
    { key: '2026-05-13T07:00:00.000Z', w: 72.5 },
    { key: '2026-05-14T08:30:00.000Z', w: 72.0 },
  ]);
});

test('import where every record is a duplicate → "all duplicates" alert, no upload', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Reset call log so we can check no PATCH happens during import.
  await page.evaluate(() => { __mock.calls.length = 0; });

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  const importFile = JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 71.0 } },  // same minute
  });
  await page.locator('#import-input').setInputFiles({
    name: 'dup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(importFile),
  });

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('už existuje');

  // No PATCH issued.
  const patchCalls = await page.evaluate(() => __mock.calls.filter(c =>
    c.type === 'upload.fetch' && c.method === 'PATCH'));
  expect(patchCalls).toEqual([]);
});

test('saveEdit happy: change weight on a row → file body updated with new weight', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Upravit"]').click();
  await row.locator('input[type="number"]').fill('72.6');
  await row.locator('button[title="Uložit"]').click();

  // After successful save the row re-renders in view mode (no inputs).
  await expect(row.locator('input')).toHaveCount(0);

  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(stored.records).toEqual({ '2026-05-13T07:00:00.000Z': { weight: 72.6 } });
});

test('saveEdit with new datetime: old key removed, new key set in storage', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Upravit"]').click();
  // datetime-local format is "YYYY-MM-DDTHH:MM" in local time. The mock
  // file stores UTC; the edit input shows the local-converted value.
  // To bump just the minute, read the current value and increment.
  const newDt = await page.evaluate(() => {
    const inp = document.querySelector('li[data-key="2026-05-13T07:00:00.000Z"] input[type="datetime-local"]');
    const d = new Date(inp.value);
    d.setMinutes(d.getMinutes() + 5);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await row.locator('input[type="datetime-local"]').fill(newDt);
  await row.locator('button[title="Uložit"]').click();

  // The row's data-key changes, so the original locator goes stale.
  // Wait for the file to be PATCHed.
  await page.waitForFunction((id) => {
    const body = JSON.parse(__mock.files[id].body);
    const keys = Object.keys(body.records);
    return keys.length === 1 && keys[0] !== '2026-05-13T07:00:00.000Z';
  }, fileId);

  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(Object.keys(stored.records)).toHaveLength(1);
  expect(stored.records['2026-05-13T07:00:00.000Z']).toBeUndefined();
  expect(Object.values(stored.records)[0]).toEqual({ weight: 72.5 });
});

test('deleteRecord single: confirm → record removed from memory and Drive', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: {
      '2026-05-13T07:00:00.000Z': { weight: 72.5 },
      '2026-05-14T07:00:00.000Z': { weight: 72.3 },
    },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept()); // accept the "Smazat …?" confirm

  // Delete the older one.
  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Smazat"]').click();

  // Wait until the file body no longer contains the deleted record.
  await page.waitForFunction((id) => {
    const body = JSON.parse(__mock.files[id].body);
    return !body.records['2026-05-13T07:00:00.000Z'];
  }, fileId);

  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(stored.records).toEqual({ '2026-05-14T07:00:00.000Z': { weight: 72.3 } });

  // The remaining row should still be in the DOM; the deleted one gone.
  await expect(page.locator('li[data-key="2026-05-14T07:00:00.000Z"]')).toBeVisible();
  await expect(page.locator('li[data-key="2026-05-13T07:00:00.000Z"]')).toHaveCount(0);
});

test('deleteRecord cancelled: confirm rejected → record stays', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.dismiss()); // reject the confirm

  await page.locator('li[data-key="2026-05-13T07:00:00.000Z"] button[title="Smazat"]').click();

  // Give it a moment in case the dismiss is mishandled; nothing should
  // change. (Dismiss is synchronous; one tick is enough.)
  await page.waitForTimeout(100);

  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(stored.records['2026-05-13T07:00:00.000Z']).toEqual({ weight: 72.5 });
  // No drive.files.delete or upload was triggered.
  const callsAfter = await page.evaluate(() => __mock.calls.filter(c =>
    c.type === 'drive.files.delete' || (c.type === 'upload.fetch' && c.method === 'PATCH')));
  expect(callsAfter).toEqual([]);
});

test('saveRecord with concurrent rev mismatch: refetch + reapply, both writes survive', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Simulate "another device" appended a record AND bumped the
  // headRevisionId between our load and our save. saveRecord's
  // preflight will detect the rev change, refetch, reapply.
  await page.evaluate((id) => {
    const f = __mock.files[id];
    f.body = JSON.stringify({
      version: 2,
      records: {
        '2026-05-13T07:00:00.000Z': { weight: 72.5 },
        '2026-05-13T08:00:00.000Z': { weight: 72.0 },  // appended by "other device"
      },
    });
    f.headRevisionId = 'revFromOtherDevice';
  }, fileId);

  // User saves a brand-new record at a different minute.
  await page.locator('#weight').fill('73.0');
  await page.locator('#weight-form button[type=submit]').click();

  // Wait for the upload to land.
  await page.waitForFunction((id) => {
    const body = JSON.parse(__mock.files[id].body);
    return Object.keys(body.records).length === 3;
  }, fileId);

  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  const keys = Object.keys(stored.records);
  expect(keys).toHaveLength(3);
  expect(stored.records['2026-05-13T07:00:00.000Z']).toEqual({ weight: 72.5 });   // original
  expect(stored.records['2026-05-13T08:00:00.000Z']).toEqual({ weight: 72.0 });   // other device's
  // The user's new record carries weight 73.0; its key is whichever minute it landed in.
  const ours = Object.entries(stored.records).find(([, v]) => v.weight === 73.0);
  expect(ours).toBeDefined();
});

test('unrecognized data → user OKs recovery → raw bytes downloaded, file reset to empty v2', async ({ page }) => {
  // Garbage file: version matches but records is the wrong type.
  const rawBody = JSON.stringify({ version: 2, records: 'garbage', settings: { theme: 'dark' } });
  const fileId = await page.evaluate((body) => __mock.addFile('weight_records.json', body), rawBody);

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept()); // accept the recovery confirm

  // The recovery flow calls downloadJsonText(raw) which creates a Blob
  // URL on an anchor with the download attribute and clicks it. That
  // fires Playwright's "download" event — easier to assert against
  // than stubbing the function (function declarations override any
  // pre-set window binding from addInitScript).
  const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const contents = Buffer.concat(chunks).toString('utf-8');
  expect(contents).toBe(rawBody);

  // File on the "server" was overwritten with an empty v2 envelope.
  const stored = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(stored.version).toBe(2);
  expect(stored.records).toEqual({});
});

test('unrecognized data → user cancels recovery → loading section stays, file untouched', async ({ page }) => {
  const rawBody = JSON.stringify({ version: 2, records: 'garbage' });
  const fileId = await page.evaluate((body) => __mock.addFile('weight_records.json', body), rawBody);

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.dismiss()); // reject the recovery confirm

  await page.locator('#login-btn').click();

  await expect(page.locator('#loading-section')).toBeVisible();
  await expect(page.locator('#app-section')).toBeHidden();

  // File untouched on the "server".
  const stored = await page.evaluate((id) => __mock.files[id].body, fileId);
  expect(stored).toBe(rawBody);

  // No PATCH happened.
  const patchCalls = await page.evaluate(() => __mock.calls.filter(c =>
    c.type === 'upload.fetch' && c.method === 'PATCH'));
  expect(patchCalls).toEqual([]);
});

test('theme buttons toggle the dark class on <html> and persist to settings', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {}, settings: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  await page.locator('#menu-btn').click();
  await page.locator('[data-theme="dark"]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.locator('[data-theme="light"]').click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  // settings.theme should now be "light" in memory; after the 500ms
  // debounced save the on-"server" file picks it up too.
  await page.waitForFunction((id) => {
    try {
      const body = JSON.parse(__mock.files[id].body);
      return body.settings && body.settings.theme === 'light';
    } catch { return false; }
  }, fileId, { timeout: 3000 });

  // Switching back to "system" should DELETE the theme key (so a fresh
  // device with a different OS preference doesn't inherit our choice).
  await page.locator('[data-theme="system"]').click();
  await page.waitForFunction((id) => {
    try {
      const body = JSON.parse(__mock.files[id].body);
      return body.settings && !('theme' in body.settings);
    } catch { return false; }
  }, fileId, { timeout: 3000 });
});

test('About dialog opens with build metadata (local-build placeholders)', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: {
      '2026-05-13T07:00:00.000Z': { weight: 72.5 },
      '2026-05-14T07:00:00.000Z': { weight: 72.3 },
    },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  await page.locator('#menu-btn').click();
  await page.locator('#about-btn').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Moje váha');
  expect(alertMessage).toContain('Schéma dat: v2');
  expect(alertMessage).toContain('Počet záznamů: 2');
  // Source tree → __BUILD_* placeholders survive → showAbout labels
  // them as the local-dev variant.
  expect(alertMessage).toContain('lokální sestavení');
  expect(alertMessage).toContain('github.com/midlan/my-weight');
});

test('privacy modal opens from the menu and closes via X button', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  await page.locator('#menu-btn').click();
  await page.locator('#privacy-menu-btn').click();
  // file:// fetch for "privacy" will fail and we'll see the fallback
  // text — but the overlay itself should be visible either way.
  await expect(page.locator('#privacy-overlay')).toBeVisible();

  await page.locator('#privacy-close-btn').click();
  await expect(page.locator('#privacy-overlay')).toBeHidden();
});

test('install button appears after beforeinstallprompt, and disappears after click', async ({ page }) => {
  // Pre-set the install-prompted flag so the first-login confirm
  // doesn't fire and steal our dialog handler.
  await page.evaluate(() => {
    localStorage.setItem('my-weight:install-prompted', new Date().toISOString());
    __mock.addFile('weight_records.json', JSON.stringify({ version: 2, records: {} }));
  });
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Fire the synthetic beforeinstallprompt event with stubbed prompt().
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.preventDefault = () => {};
    e.prompt = () => Promise.resolve();
    e.userChoice = Promise.resolve({ outcome: 'dismissed', platform: 'web' });
    window.dispatchEvent(e);
  });

  // Button should now be visible inside the menu.
  await page.locator('#menu-btn').click();
  await expect(page.locator('#install-btn')).toBeVisible();

  // Click it — menu closes, button hides (event consumed).
  await page.locator('#install-btn').click();
  await expect(page.locator('#install-btn')).toBeHidden();
});

test('first-login install confirm fires once when prompt event + no prior prompt', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));

  // Capture the confirm before the records-load triggers it.
  page.removeAllListeners('dialog');
  const confirms = [];
  page.on('dialog', d => {
    if (d.type() === 'confirm') {
      confirms.push(d.message());
      d.dismiss();
    } else {
      d.accept();
    }
  });

  // Fire the synthetic beforeinstallprompt right before login so the
  // event handler stores `deferredInstallPrompt` ahead of loadRecords.
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.preventDefault = () => {};
    e.prompt = () => Promise.resolve();
    e.userChoice = Promise.resolve({ outcome: 'dismissed', platform: 'web' });
    window.dispatchEvent(e);
  });

  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  await expect.poll(() => confirms.length, { timeout: 3000 }).toBeGreaterThan(0);
  expect(confirms[0]).toContain('plochu');

  // The install-prompted flag should be persisted to localStorage so
  // we don't ask again on the next login.
  const flag = await page.evaluate(() => localStorage.getItem('my-weight:install-prompted'));
  expect(flag).toBeTruthy();
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
