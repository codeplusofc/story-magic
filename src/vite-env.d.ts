/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_GROQ_API_KEY?: string;
  /** Opcional. Lista separada por vírgula; cada modelo tem cota própria no Groq. */
  readonly VITE_GROQ_MODELS?: string;
  readonly VITE_GEMINI_API_KEY?: string;
  /** Opcional. Um ou mais modelos separados por vírgula. Ex.: gemini-3.5-flash-lite,gemini-flash-lite-latest */
  readonly VITE_GEMINI_MODEL?: string;
  readonly VITE_OPENROUTER_API_KEY?: string;
  /** Opcional. Modelos gratuitos do OpenRouter terminam em ":free". */
  readonly VITE_OPENROUTER_MODELS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
