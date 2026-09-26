/**
 * Service worker do Storyverse: deixa o app instalável e abre offline.
 * - Páginas: rede primeiro; sem internet, a última versão guardada.
 * - Arquivos do build (/assets/*, com hash no nome) e fontes: guardados na primeira vez.
 * - Texto dos livros já abertos: guardado para ler offline (até MAX_BOOKS livros).
 * - Capas: mostra a guardada e atualiza em segundo plano.
 * Busca, IA e tradução nunca passam por aqui (precisam de internet de qualquer jeito).
 *
 * Lembrete diário (Android com o app instalado): o Chrome acorda este arquivo mais ou menos uma
 * vez por dia ("periodicsync"). Se o leitor ainda não leu hoje, aparece uma notificação montada
 * com os dados que o app deixa no cache "sv-state" (sequência, último livro, personagem).
 */
// Mudar a versão faz quem já tem o app baixar de novo a página e os ícones. Livros e imagens
// (capas, retratos) ficam em caches sem versão: continuam guardados entre atualizações.
const VERSION = "v2";
const SHELL = `storyverse-shell-${VERSION}`;
const BOOKS = "storyverse-books-v1";
const IMAGES = "storyverse-images-v1";
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
        Promise.all(
          keys.filter((k) => k.startsWith("storyverse-shell-") && k !== SHELL).map((k) => caches.delete(k)),
        ),
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
    url.hostname === "covers.openlibrary.org" ||
    // Retratos dos personagens: gerados uma vez, guardados para sempre (e para ler offline).
    url.hostname === "image.pollinations.ai" ||
    url.hostname === "upload.wikimedia.org" ||
    url.hostname === "thumb.wikimedia.org"
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/* ---------------------------- Lembrete diário ---------------------------- */

const STATE_CACHE = "sv-state";
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function readState() {
  const cache = await caches.open(STATE_CACHE);
  const res = await cache.match("/__engagement");
  return res ? res.json() : null;
}

async function maybeNotify(force) {
  const state = await readState();
  if (!state) return;
  const cache = await caches.open(STATE_CACHE);
  const now = new Date();
  const today = dayKey(now);
  const hour = now.getHours();
  // Nada de notificação de madrugada, nem duas no mesmo dia, nem para quem já leu hoje.
  if (!force && (hour < 9 || hour >= 22)) return;
  const last = await cache.match("/__notified");
  if (!force && last && (await last.text()) === today) return;
  if (!force && state.lastReadDay === today) return;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const streakAlive = state.streak > 0 && state.lastReadDay === dayKey(yesterday);
  const book = state.book;
  const who = book && book.character ? book.character : null;

  let title;
  let body;
  if (streakAlive) {
    title = `🔥 Sua sequência de ${state.streak} ${state.streak === 1 ? "dia" : "dias"} acaba hoje!`;
    body = book
      ? `${who ? `${who} está te esperando` : "Sua história continua"} em “${book.title}”. Bastam uns minutinhos.`
      : "Bastam uns minutinhos de leitura para manter a sequência.";
  } else if (book) {
    title = who ? `${who} sente sua falta 💛` : "📖 Sua história está te esperando";
    body = `Que tal continuar “${book.title}”${book.chapterLabel ? ` de onde parou (${book.chapterLabel})` : ""}?`;
  } else {
    title = "📖 Hora de ler";
    body = "Escolha uma história e converse com quem vive nela.";
  }

  await self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "storyverse-daily",
    data: { url: "/" },
  });
  await cache.put("/__notified", new Response(today));
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "storyverse-daily") event.waitUntil(maybeNotify(false));
});

// Usado pelo app para mostrar uma notificação de teste logo depois de ativar.
self.addEventListener("message", (event) => {
  if (event.data === "storyverse-test-reminder") event.waitUntil(maybeNotify(true));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow("/");
    }),
  );
});
