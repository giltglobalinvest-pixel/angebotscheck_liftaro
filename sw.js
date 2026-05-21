// Liftaro Service Worker — minimal, pass-through.
// Erfüllt das PWA-Installations-Kriterium (für Chrome/Edge "beforeinstallprompt"-Event),
// macht aber bewusst KEIN Caching: Loader + Auto-Update-Mechanismus sollen weiterhin
// die jeweils aktuellste index.html von GitHub Pages ziehen — ohne Stale-Cache-Probleme.
self.addEventListener('install',  () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
// Bewusst KEIN fetch-Listener — Browser holt alles direkt vom Netzwerk.
