// Minimal service worker. Its only job is to exist so Chrome treats
// the page as a PWA and surfaces the install prompt. The app needs
// Google Drive at runtime, so a real offline strategy isn't a goal
// (see CLAUDE.md non-goals) — no caching, no fetch interception.
//
// skipWaiting + clients.claim mean a refreshed sw.js takes effect on
// the next page load instead of waiting for every tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
