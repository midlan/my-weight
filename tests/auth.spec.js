import { test, expect, PAGE_URL } from './fixtures.js';

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
//                                  shape: { status, message?, reason? }
//   __mock.forceNextDeleteError — one-shot for drive.files.delete
//                                  same shape; lets wipe-error tests
//                                  exercise the gapi-throw path
//   __mock.forceNextFetchDelay  — milliseconds; pauses the next
//                                  upload fetch so tests can observe
//                                  transient UI ("Ukládám…", spinner)
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
    forceNextDeleteError: null,
    // Milliseconds to artificially delay the next upload fetch
    // (PATCH/POST). Lets tests observe transient UI states like
    // "Ukládám..." or the delete spinner that would otherwise
    // disappear in microseconds.
    forceNextFetchDelay: 0,
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
    err.result = {
      error: {
        code: spec.status,
        message: err.message,
        // Drive's structured error shape — describeDriveError reads
        // errors[0].reason to map e.g. storageQuotaExceeded to a
        // friendly Czech message.
        errors: spec.reason ? [{ reason: spec.reason }] : undefined,
      },
    };
    return err;
  }
  function forcedBody(spec) {
    return {
      error: {
        code: spec.status,
        message: spec.message || '',
        errors: spec.reason ? [{ reason: spec.reason }] : undefined,
      },
    };
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
            if (window.__mock.forceNextDeleteError) {
              const f = window.__mock.forceNextDeleteError;
              window.__mock.forceNextDeleteError = null;
              if (f.status === 401) window.__mock.tokenIsValid = false;
              throw forcedErr(f);
            }
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
      if (window.__mock.forceNextFetchDelay) {
        const delay = window.__mock.forceNextFetchDelay;
        window.__mock.forceNextFetchDelay = 0;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      if (window.__mock.forceNextFetchError) {
        const f = window.__mock.forceNextFetchError;
        window.__mock.forceNextFetchError = null;
        if (f.status === 401) window.__mock.tokenIsValid = false;
        return new Response(JSON.stringify(forcedBody(f)), {
          status: f.status,
          headers: { 'Content-Type': 'application/json' },
        });
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
  // shapes and these filters let them through.
  // Each browser uses different wording for the same underlying
  // "couldn't fetch this URL" event:
  //   - chromium: "Failed to load resource: ..."
  //   - webkit:   "Not allowed to load local resource: file:///..."
  //               "Origin null is not allowed by Access-Control-Allow-Origin..."
  //   - firefox:  "NetworkError when attempting to fetch resource"
  //               "Cross-Origin Request Blocked: ..."
  const isResourceLoad = (text) =>
    /^Failed to load resource:/.test(text)
    || /^Not allowed to load local resource:/.test(text)
    || /Access-Control-Allow-Origin/.test(text)
    || /NetworkError when attempting to fetch/.test(text)
    || /Cross-Origin Request Blocked/.test(text);
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

test('cached valid token in localStorage → app loads without user click', async ({ page }) => {
  // Seed localStorage + a Drive file via a second addInitScript so
  // both fire on the reload below (the first one, MOCK_INIT, is
  // already registered in beforeEach and runs ahead of this one,
  // so window.__mock exists when this runs).
  await page.addInitScript(() => {
    localStorage.setItem('my-weight:token', JSON.stringify({
      token: 'fake_cached_token',
      expiresAt: Date.now() + 3_600_000,
    }));
    __mock.addFile('weight_records.json', JSON.stringify({
      version: 2,
      records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
    }));
  });
  await page.reload();
  await page.addStyleTag({ content: '.hidden { display: none !important; }' });

  // attemptAutoLogin's cached-token branch: loadStoredToken returns
  // the seeded token, accessToken is set, onSignIn() fires — app
  // section appears without us clicking #login-btn.
  await expect(page.locator('#app-section')).toBeVisible();
  await expect(page.locator('#history-list li').first()).toContainText('72,5 kg');

  // The cached path skips the token client entirely — neither a
  // silent (prompt:'none') nor an interactive token request fires.
  const tokenRequests = await page.evaluate(() =>
    __mock.calls.filter(c => c.type === 'requestAccessToken'));
  expect(tokenRequests).toEqual([]);
});

test('save when Drive file deleted on another device → new file created, old data dropped', async ({ page }) => {
  const oldFileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();
  await expect(page.locator('#history-list li').first()).toContainText('72,5 kg');

  // Simulate the file being deleted on another device between load
  // and save. uploadWithConflictRetry's preflight (readRemoteRevision)
  // gets a 404 from drive.files.get, returns null. The mismatch branch
  // then treats null as "start from empty": resets fileId/records/
  // settings, re-runs applyIntent on the empty state, and uploadRecords
  // POSTs a fresh file. The previously-loaded record is intentionally
  // dropped — that's the documented design choice.
  await page.evaluate((id) => { delete __mock.files[id]; }, oldFileId);

  await page.locator('#weight').fill('73.0');
  await page.locator('#weight-form button[type=submit]').click();

  // After the save, history should show only the new record.
  await expect(page.locator('#history-list li')).toHaveCount(1);
  await expect(page.locator('#history-list li').first()).toContainText('73 kg');

  // A new Drive file exists under the same name, with a different id
  // than the one we deleted (so the helper definitely went down the
  // POST-create branch instead of trying to PATCH the missing id).
  const created = await page.evaluate((removedId) => {
    const f = __mock.getFile('weight_records.json');
    return { exists: f !== null, sameAsDeleted: f && f.id === removedId };
  }, oldFileId);
  expect(created.exists).toBe(true);
  expect(created.sameAsDeleted).toBe(false);

  // And the POST path was actually traversed (not just PATCH).
  const posted = await page.evaluate(() =>
    __mock.calls.some(c => c.type === 'upload.fetch' && c.method === 'POST'));
  expect(posted).toBe(true);
});

test('expired cached token at page load → silent reauth succeeds, app loads', async ({ page }) => {
  // Token record present but expired: loadStoredToken() returns null
  // (since expiresAt is in the past) while hasStoredTokenRecord()
  // returns true — that combination is what makes attemptAutoLogin
  // fire requestAccessToken({prompt:'none'}) on page load instead of
  // just showing the auth section.
  await page.addInitScript(() => {
    localStorage.setItem('my-weight:token', JSON.stringify({
      token: 'expired_token',
      expiresAt: Date.now() - 1000,
    }));
    __mock.addFile('weight_records.json', JSON.stringify({
      version: 2,
      records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
    }));
  });
  await page.reload();
  await page.addStyleTag({ content: '.hidden { display: none !important; }' });

  // Silent token request returned a fresh token → onSignIn → records load.
  await expect(page.locator('#app-section')).toBeVisible();
  await expect(page.locator('#history-list li').first()).toContainText('72,5 kg');

  // Exactly one silent request fired; no interactive prompt.
  const reauthed = await page.evaluate(() =>
    __mock.calls.filter(c => c.type === 'requestAccessToken' && c.prompt === 'none').length);
  expect(reauthed).toBe(1);
  const interactive = await page.evaluate(() =>
    __mock.calls.some(c => c.type === 'requestAccessToken' && c.prompt !== 'none'));
  expect(interactive).toBe(false);
});

test('expired cached token at page load → silent reauth fails, auth section shown', async ({ page }) => {
  // Same expired-token setup, but silent reauth fires error_callback
  // instead of resolving. The page-load branch of error_callback
  // (no pendingSilentReauth) clears silent state and shows the auth
  // section. No alert — page-load silent failures are quiet because
  // the user hasn't tried to do anything yet.
  let unexpectedAlert = '';
  page.removeAllListeners('dialog');
  page.on('dialog', d => { unexpectedAlert = d.message(); d.accept(); });

  await page.addInitScript(() => {
    localStorage.setItem('my-weight:token', JSON.stringify({
      token: 'expired_token',
      expiresAt: Date.now() - 1000,
    }));
    __mock.silentReauthSucceeds = false;
  });
  await page.reload();
  await page.addStyleTag({ content: '.hidden { display: none !important; }' });

  await expect(page.locator('#auth-section')).toBeVisible();
  await expect(page.locator('#app-section')).toBeHidden();
  expect(unexpectedAlert).toBe('');

  const reauthed = await page.evaluate(() =>
    __mock.calls.some(c => c.type === 'requestAccessToken' && c.prompt === 'none'));
  expect(reauthed).toBe(true);
});

test('settings save during 401 + silent fail → console.error only, no alert, stays on app', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {}, settings: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // No alerts expected — fail loudly if one shows.
  let unexpectedAlert = '';
  page.removeAllListeners('dialog');
  page.on('dialog', d => { unexpectedAlert = d.message(); d.accept(); });

  // Capture console.error so we can confirm the silent-fail log fired.
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // Make the next Drive metadata get 401, and silent reauth fail.
  // scheduleSettingsSave's chain: uploadWithConflictRetry →
  // readRemoteRevision (gapi.files.get) → 401 → withReauth →
  // attemptSilentReauth → rejects → original 401 re-thrown →
  // .catch(err => console.error('Failed to save settings', err)).
  await page.evaluate(() => {
    __mock.forceNextGetError = { status: 401 };
    __mock.silentReauthSucceeds = false;
  });

  // Theme change triggers scheduleSettingsSave (500 ms debounce).
  await page.locator('#menu-btn').click();
  await page.locator('[data-theme="dark"]').click();

  // Wait for the silent-fail log to land (debounce + reauth timeout
  // shortcuts via error_callback fast in the mock, so 1.5 s is plenty).
  await expect.poll(() => errors.some(e => e.includes('Failed to save settings')),
    { timeout: 3000 }).toBe(true);

  // Still on app section — silent settings-save failures do NOT call
  // handleFatal401, so the user keeps working until their next
  // explicit Drive op surfaces the auth screen.
  await expect(page.locator('#app-section')).toBeVisible();
  expect(unexpectedAlert).toBe('');
});

test('concurrent silent reauth attempts share one token request (pendingSilentReauth dedup)', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Clear the call log so we only count the dedup attempt below.
  await page.evaluate(() => { __mock.calls = []; });

  // Two near-simultaneous attemptSilentReauth() calls. The function
  // sets pendingSilentReauth = state synchronously before the mock's
  // tokenClient setTimeout(0) fires, so the second call must observe
  // the existing promise and return it instead of issuing a second
  // requestAccessToken.
  await page.evaluate(async () => {
    const a = attemptSilentReauth();
    const b = attemptSilentReauth();
    await Promise.all([a, b]);
  });

  const requestCount = await page.evaluate(() =>
    __mock.calls.filter(c => c.type === 'requestAccessToken' && c.prompt === 'none').length);
  expect(requestCount).toBe(1);
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

test('pagination: 15 records render 10 per page; prev/next move between pages', async ({ page }) => {
  // Build 15 records on consecutive dates.
  const records = {};
  for (let i = 0; i < 15; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i, 7, 0, 0));
    records[d.toISOString()] = { weight: 70 + i * 0.1 };
  }
  await page.evaluate((recs) => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: recs,
  })), records);
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Page 1: 10 newest records, "Prev" disabled.
  await expect(page.locator('#history-list li')).toHaveCount(10);
  await expect(page.locator('#prev-page')).toBeDisabled();
  await expect(page.locator('#next-page')).toBeEnabled();
  await expect(page.locator('#page-info')).toContainText('1–10 z 15');

  // Click next → page 2: 5 records.
  await page.locator('#next-page').click();
  await expect(page.locator('#history-list li')).toHaveCount(5);
  await expect(page.locator('#prev-page')).toBeEnabled();
  await expect(page.locator('#next-page')).toBeDisabled();
  await expect(page.locator('#page-info')).toContainText('11–15 z 15');

  // Bump page size to 25 → 15 records fit on one page, prev/next
  // both disabled. (Pagination element itself only hides when total
  // records <= ALLOWED_PAGE_SIZES[0]=10; with 15 records it stays
  // visible so the user can see "1–15 z 15" + the page-size selector.)
  await page.locator('#page-size').selectOption('25');
  await expect(page.locator('#history-list li')).toHaveCount(15);
  await expect(page.locator('#prev-page')).toBeDisabled();
  await expect(page.locator('#next-page')).toBeDisabled();
  await expect(page.locator('#page-info')).toContainText('1–15 z 15');
});

test('note expand/collapse: clicking a row with a note toggles the expanded layout', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5, note: 'po dlouhém běhu' } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  // Initially collapsed: row uses items-center; note span is truncated.
  await expect(row).toHaveClass(/items-center/);

  // Click on the note text — it always has the toggle handler in both
  // states (in collapsed mode via the parent content div, in expanded
  // mode on the noteSpan itself).
  await row.getByText('po dlouhém běhu').click();
  await expect(row).toHaveClass(/flex-col/);

  // Click again to collapse.
  await row.getByText('po dlouhém běhu').click();
  await expect(row).toHaveClass(/items-center/);
});

test('stepper +/− buttons in the new-record form update the input and set dirty flag', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Sanity: input is empty, dirty flag is false (no records to prefill from).
  await expect(page.locator('#weight')).toHaveValue('');
  expect(await page.evaluate(() => weightInputDirty)).toBe(false);

  // Three "+" clicks then one "−" — math is tested in unit specs,
  // here we verify the wiring through the click handlers.
  await page.locator('#weight-increment').click();
  await page.locator('#weight-increment').click();
  await page.locator('#weight-increment').click();
  await expect(page.locator('#weight')).toHaveValue('0.3');
  await page.locator('#weight-decrement').click();
  await expect(page.locator('#weight')).toHaveValue('0.2');

  // Stepper clicks mark the input dirty too (programmatic value
  // changes don't fire the 'input' event, so the handlers set the
  // flag explicitly).
  expect(await page.evaluate(() => weightInputDirty)).toBe(true);
});

test('"teď" → custom datetime toggle: clicking #now-btn reveals the datetime input', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  await expect(page.locator('#now-btn')).toBeVisible();
  await expect(page.locator('#datetime')).toBeHidden();

  await page.locator('#now-btn').click();
  await expect(page.locator('#now-btn')).toBeHidden();
  await expect(page.locator('#datetime')).toBeVisible();

  // The value is pre-filled with "now" — should match today's date.
  const value = await page.locator('#datetime').inputValue();
  const todayStr = await page.evaluate(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  expect(value.startsWith(todayStr)).toBe(true);
});

test('future-date submit triggers a confirm; dismissing aborts the save', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Switch to custom datetime mode and pick a date a year in the future.
  await page.locator('#now-btn').click();
  const future = await page.evaluate(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.locator('#datetime').fill(future);
  await page.locator('#weight').fill('72.5');

  // Dismiss the future-date confirm.
  page.removeAllListeners('dialog');
  const dialogs = [];
  page.on('dialog', d => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'confirm') d.dismiss();
    else d.accept();
  });

  await page.locator('#weight-form button[type=submit]').click();
  // Give the cancellation a tick to settle.
  await page.waitForTimeout(100);

  expect(dialogs.some(d => d.type === 'confirm' && d.message.includes('budoucnosti'))).toBe(true);
  // No upload happened.
  const patchCalls = await page.evaluate(() => __mock.calls.filter(c =>
    c.type === 'upload.fetch' && (c.method === 'PATCH' || c.method === 'POST')));
  expect(patchCalls).toEqual([]);
  const fileBody = await page.evaluate((id) => JSON.parse(__mock.files[id].body), fileId);
  expect(fileBody.records).toEqual({});
});

test('export downloads the live Drive bytes verbatim', async ({ page }) => {
  const rawBody = JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
    settings: { theme: 'dark' },
  });
  await page.evaluate((body) => __mock.addFile('weight_records.json', body), rawBody);
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
  await page.locator('#menu-btn').click();
  await page.locator('#export-btn').click();
  const download = await downloadPromise;

  // Filename pattern: my-weight-YYYY-MM-DD.json
  expect(download.suggestedFilename()).toMatch(/^my-weight-\d{4}-\d{2}-\d{2}\.json$/);

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf-8');
  expect(text).toBe(rawBody);
});

test('editingRowHasChanges + restoreEditingDraft: track and restore typed edits', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Enter edit mode.
  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Upravit"]').click();

  // editingRowHasChanges is false right after entering edit mode
  // (input values match the stored record).
  expect(await page.evaluate(() => editingRowHasChanges())).toBe(false);

  // Mutate the weight input → editingRowHasChanges flips to true.
  await row.locator('input[type="number"]').fill('73.0');
  expect(await page.evaluate(() => editingRowHasChanges())).toBe(true);

  // restoreEditingDraft writes given values back into the editing
  // row's inputs.
  await page.evaluate(() => restoreEditingDraft({
    dtValue: document.querySelector('li[data-key="2026-05-13T07:00:00.000Z"] input[type=datetime-local]').value,
    weightValue: '72.5',
    noteValue: '',
  }));
  await expect(row.locator('input[type="number"]')).toHaveValue('72.5');
  expect(await page.evaluate(() => editingRowHasChanges())).toBe(false);
});

test('saveRecord with 403 storageQuotaExceeded → friendly "úložiště je plné" alert', async ({ page }) => {
  // No file yet — first save creates the file (POST). The 403 lands
  // on the multipart POST.
  await page.locator('#login-btn').click();
  await expect(page.locator('#auth-section')).toBeHidden();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  await page.evaluate(() => {
    __mock.forceNextFetchError = { status: 403, reason: 'storageQuotaExceeded', message: 'Quota exceeded' };
  });

  await page.locator('#weight').fill('72.5');
  await page.locator('#weight-form button[type=submit]').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Vaše Google úložiště je plné');

  // No file got created on the "server".
  const fileExists = await page.evaluate(() => !!__mock.getFile('weight_records.json'));
  expect(fileExists).toBe(false);
});

test('saveRecord with generic 500 → "Chyba při ukládání" alert + record reverted', async ({ page }) => {
  // Existing file — the failed PATCH is followed by fetchFromDrive in
  // the catch which restores the in-memory state from the unchanged
  // file body.
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  await page.evaluate(() => { __mock.forceNextFetchError = { status: 500, message: 'Internal Error' }; });

  await page.locator('#weight').fill('73.0');
  await page.locator('#weight-form button[type=submit]').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Chyba při ukládání');
  expect(alertMessage).toContain('Internal Error');

  // The in-memory record set was reverted to the on-"server" content.
  const count = await page.evaluate(() => recordsCount());
  expect(count).toBe(1);
});

test('saveEdit upload 500 → alert + edit row keeps the typed values for retry', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Upravit"]').click();
  await page.evaluate(() => { __mock.forceNextFetchError = { status: 500, message: 'kaput' }; });
  await row.locator('input[type="number"]').fill('73.0');
  await row.locator('button[title="Uložit"]').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Chyba při ukládání');
  // The row should still be in edit mode with the typed values
  // preserved (so the user can retry).
  await expect(row.locator('input[type="number"]')).toHaveValue('73.0');
});

test('deleteRecord upload 500 → alert + record refetched back into memory', async ({ page }) => {
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
  page.on('dialog', d => {
    if (d.type() === 'confirm') d.accept();
    else { alertMessage = d.message(); d.accept(); }
  });

  await page.evaluate(() => { __mock.forceNextFetchError = { status: 500, message: 'boom' }; });
  await page.locator('li[data-key="2026-05-13T07:00:00.000Z"] button[title="Smazat"]').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Chyba při mazání');

  // After the failed PATCH, the catch refetches from Drive — both
  // records should be back in memory (and in the DOM).
  const count = await page.evaluate(() => recordsCount());
  expect(count).toBe(2);
  await expect(page.locator('li[data-key="2026-05-13T07:00:00.000Z"]')).toBeVisible();
});

test('wipeAllData with 500 on drive.files.delete → "Chyba při mazání" alert, file preserved', async ({ page }) => {
  const fileId = await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => {
    if (d.type() === 'prompt') d.accept('smazat vše');
    else { alertMessage = d.message(); d.accept(); }
  });

  await page.evaluate(() => { __mock.forceNextDeleteError = { status: 500, message: 'server angry' }; });

  await page.locator('#menu-btn').click();
  await page.locator('#wipe-btn').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Chyba při mazání');
  expect(alertMessage).toContain('server angry');

  // File untouched on the "server".
  const stillThere = await page.evaluate((id) => !!__mock.files[id], fileId);
  expect(stillThere).toBe(true);
});

test('export with 500 on Drive fetch → "Chyba při exportu" alert, no download', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => { alertMessage = d.message(); d.accept(); });

  // Export calls fetchFromDrive which uses gapi.client.drive.files.get
  // for the file content. Force that to 500.
  await page.evaluate(() => { __mock.forceNextGetError = { status: 500, message: 'boom' }; });

  let downloaded = false;
  page.on('download', () => { downloaded = true; });

  await page.locator('#menu-btn').click();
  await page.locator('#export-btn').click();

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Chyba při exportu');
  expect(alertMessage).toContain('boom');

  // Give the download event time to fire if it was going to.
  await page.waitForTimeout(200);
  expect(downloaded).toBe(false);
});

test('import upload 500 → "Chyba při importu" alert, no records added in memory', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  let alertMessage = '';
  page.on('dialog', d => {
    if (d.type() === 'confirm') d.accept();   // "Naimportovat X záznamů?"
    else { alertMessage = d.message(); d.accept(); }
  });

  // The upload PATCH inside the import will fail.
  await page.evaluate(() => { __mock.forceNextFetchError = { status: 500, message: 'nope' }; });

  const importFile = JSON.stringify({
    version: 2,
    records: { '2026-05-15T07:00:00.000Z': { weight: 70.0 } },
  });
  await page.locator('#import-input').setInputFiles({
    name: 'data.json',
    mimeType: 'application/json',
    buffer: Buffer.from(importFile),
  });

  await expect.poll(() => alertMessage, { timeout: 3000 }).toContain('Chyba při importu');

  // The catch refetches Drive (which still has empty records), so
  // in-memory state ends up at 0 — the imported record didn't stick.
  const count = await page.evaluate(() => recordsCount());
  expect(count).toBe(0);
});

test('saveRecord shows "Ukládám..." in the submit button while upload is in flight', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2, records: {},
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  // Pause the upload so the transient state has a window to be
  // observable. 500 ms is comfortably above Playwright's polling
  // interval and below the test's default 5 s expect timeout.
  await page.evaluate(() => { __mock.forceNextFetchDelay = 500; });

  const submit = page.locator('#weight-form button[type=submit]');
  const originalText = (await submit.textContent()).trim();

  await page.locator('#weight').fill('72.5');
  await submit.click();

  await expect(submit).toContainText('Ukládám');

  // Once the upload completes the button text is restored.
  await expect(submit).toHaveText(originalText);
});

test('saveEdit shows "Ukládám..." in the edit row while upload is in flight', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Upravit"]').click();
  await row.locator('input[type="number"]').fill('73.0');

  await page.evaluate(() => { __mock.forceNextFetchDelay = 500; });
  await row.locator('button[title="Uložit"]').click();

  // The action area swaps the save / cancel buttons for an
  // "Ukládám..." span while the upload runs.
  await expect(row.getByText('Ukládám...')).toBeVisible();

  // Eventually the row returns to view mode (no inputs).
  await expect(row.locator('input')).toHaveCount(0);
});

test('deleteRecord shows a spinner in the trash slot while upload is in flight', async ({ page }) => {
  await page.evaluate(() => __mock.addFile('weight_records.json', JSON.stringify({
    version: 2,
    records: { '2026-05-13T07:00:00.000Z': { weight: 72.5 } },
  })));
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-section')).toBeVisible();

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());

  await page.evaluate(() => { __mock.forceNextFetchDelay = 500; });
  const row = page.locator('li[data-key="2026-05-13T07:00:00.000Z"]');
  await row.locator('button[title="Smazat"]').click();

  // The trash icon is replaced with a spinner button titled "Mažu...".
  await expect(row.locator('button[title="Mažu..."]')).toBeVisible();

  // After the upload, the row is gone.
  await expect(page.locator('li[data-key="2026-05-13T07:00:00.000Z"]')).toHaveCount(0);
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
