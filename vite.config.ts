import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/** Os .txt do Project Gutenberg não liberam CORS; em produção o `vercel.json` faz o mesmo papel. */
const gutenbergProxy: Record<string, ProxyOptions> = {
  "/gutenberg": {
    target: "https://www.gutenberg.org",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/gutenberg/, ""),
  },
  "/gutenberg-mirror": {
    target: "https://aleph.pglaf.org",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/gutenberg-mirror/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: gutenbergProxy },
  preview: { proxy: gutenbergProxy },
});
