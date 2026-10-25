// Retired: the site-wide ../sw.js handles offline use now. This file only removes the old
// per-tool worker from browsers that still have it. It can be deleted after 2027-02.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.registration.unregister()));
