import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { Agent } from "node:https";

/**
 * Só IPv4: em algumas redes o gutenberg.org não responde por IPv6, e a conexão ficava 21 s
 * pendurada até falhar. O keep-alive reaproveita a conexão entre buscas.
 */
const agent = new Agent({ family: 4, keepAlive: true });

/**
 * Os .txt do Project Gutenberg não liberam CORS; em produção o `vercel.json` faz o mesmo papel.
 * As chaves terminam em "/" porque o Vite casa pelo começo do caminho: sem isso, "/gutenberg"
 * também capturaria "/gutenberg-mirror" e "/gutenberg-search".
 */
const gutenbergProxy: Record<string, ProxyOptions> = {
  /** Busca: o gutenberg.org exige a barra final em "search.opds/", então ela fica fixa aqui. */
  "/gutenberg-search": {
    target: "https://www.gutenberg.org",
    changeOrigin: true,
    agent,
    rewrite: (path) => path.replace(/^\/gutenberg-search\/?/, "/ebooks/search.opds/"),
  },
  "/gutenberg/": {
    target: "https://www.gutenberg.org",
    changeOrigin: true,
    agent,
    rewrite: (path) => path.replace(/^\/gutenberg/, ""),
  },
  "/gutenberg-mirror/": {
    target: "https://aleph.pglaf.org",
    changeOrigin: true,
    agent,
    rewrite: (path) => path.replace(/^\/gutenberg-mirror/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: gutenbergProxy },
  preview: { proxy: gutenbergProxy },
});
