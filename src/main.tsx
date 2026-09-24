import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import "./index.css";
import { App } from "./App";
import { registerServiceWorker } from "./lib/pwa";

// App instalável e leitura offline (só no build de produção).
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {/* Visitantes e páginas vistas no painel do Vercel (aba Analytics). */}
    <Analytics />
  </StrictMode>,
);
