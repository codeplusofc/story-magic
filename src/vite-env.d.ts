/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GROQ_API_KEY?: string;
  readonly VITE_GEMINI_API_KEY?: string;
  /** Opcional. Ex.: gemini-2.5-flash — ver lista em AI Studio / documentação. */
  readonly VITE_GEMINI_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
