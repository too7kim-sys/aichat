/* aichat PWA service worker (#51).
 *
 * 정적 자원 (JS/CSS/이미지) 만 cache-first, /api 요청은 항상 네트워크
 * 우선 (오프라인 채팅은 의도하지 않음 — Ollama 서버 필요).
 * 새 배포 시 CACHE_VERSION 을 올리면 옛 캐시가 정리됨.
 */
const CACHE_VERSION = "aichat-v1";
const STATIC_HOSTS = self.location.origin;

self.addEventListener("install", (event) => {
  // 첫 인스톨 시 빈 캐시만 준비. 본격 적재는 fetch 단계에서 lazily.
  event.waitUntil(caches.open(CACHE_VERSION));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION && k.startsWith("aichat-"))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // /api 는 항상 네트워크 — 캐시했다 잘못된 응답을 다시 주면 곤란.
  if (url.pathname.startsWith("/api/")) return;
  // SSE / blob / 외부 도메인은 패스.
  if (url.origin !== STATIC_HOSTS) return;
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) {
        // 배경에서 새 버전 받아 캐시 갱신 (stale-while-revalidate).
        fetch(req)
          .then((res) => {
            if (res && res.ok && res.status === 200) cache.put(req, res.clone());
          })
          .catch(() => {});
        return hit;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        // 오프라인 & 캐시에도 없는 자원 — 그냥 throw.
        throw err;
      }
    }),
  );
});
