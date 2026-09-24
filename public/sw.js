/**
 * Service worker do Storyverse: deixa o app instalável e abre offline.
 * - Páginas: rede primeiro; sem internet, a última versão guardada.
 * - Arquivos do build (/assets/*, com hash no nome) e fontes: guardados na primeira vez.
 * - Texto dos livros já abertos: guardado para ler offline (até MAX_BOOKS livros).
 * - Capas: mostra a guardada e atualiza em segundo plano.
 * Busca, IA e tradução nunca passam por aqui (precisam de internet de qualquer jeito).
 */
const VERSION = "v1";
const SHELL = `storyverse-shell-${VERSION}`;
const BOOKS = `storyverse-books-${VERSION}`;
const IMAGES = `storyverse-images-${VERSION}`;
const MAX_BOOKS = 30;
const MAX_IMAGES = 200;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/manifest.webmanifest", "/icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("storyverse-") && !k.endsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put("/", res.clone());
    return res;
  } catch {
    return (await cache.match("/")) ?? Response.error();
  }
}

async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Só guarda resposta completa e do tipo certo (o proxy às vezes devolve HTML de erro).
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && !(cacheName === BOOKS && type.includes("text/html"))) {
    await cache.put(request, res.clone());
    if (max) trim(cacheName, max);
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(request);
  const update = fetch(request)
    .then((res) => {
      if (res.ok || res.type === "opaque") {
        cache.put(request, res.clone());
        trim(IMAGES, MAX_IMAGES);
      }
      return res;
    })
    .catch(() => hit);
  return hit ?? update;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate" && sameOrigin) {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (sameOrigin && url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  if (sameOrigin && /^\/gutenberg(-mirror)?\/cache\/epub\/\d+\/pg\d+\.txt$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, BOOKS, MAX_BOOKS));
    return;
  }
  if (
    (sameOrigin && /^\/gutenberg\/cache\/epub\/\d+\/.*\.jpg$/.test(url.pathname)) ||
    url.hostname === "covers.openlibrary.org"
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
