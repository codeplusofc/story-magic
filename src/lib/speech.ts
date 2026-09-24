/**
 * Leitura em voz alta com as vozes do próprio aparelho (Web Speech API): grátis e sem chave.
 * A qualidade depende do navegador: o Edge tem vozes "Natural" quase humanas; Chrome e Android,
 * as vozes do Google; o iPhone, as vozes "Aprimoradas". A voz robótica do Windows fica por último.
 * Fala um parágrafo por vez (o Chrome corta falas muito longas) e avisa qual está sendo lido.
 */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export type VoiceOption = {
  uri: string;
  /** Nome curto para a lista ("Francisca", "Google português do Brasil"). */
  label: string;
  lang: string;
  /** Voz neural/online, que soa bem mais humana. */
  natural: boolean;
};

const PREFS_KEY = "storyverse:voice-prefs";
type VoicePrefs = { pt?: string; en?: string; rate?: number };

export const RATE_OPTIONS = [0.9, 1, 1.1, 1.25, 1.5] as const;
/** Um pouco mais rápido que o padrão das vozes, que costuma soar arrastado em leitura longa. */
const DEFAULT_RATE = 1.1;

function readPrefs(): VoicePrefs {
  try {
    return (JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as VoicePrefs) ?? {};
  } catch {
    return {};
  }
}

function writePrefs(p: VoicePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Sem armazenamento: a escolha vale só nesta visita.
  }
}

export function savedRate(): number {
  const r = readPrefs().rate;
  return typeof r === "number" && r >= 0.5 && r <= 2 ? r : DEFAULT_RATE;
}

export function saveRate(rate: number) {
  writePrefs({ ...readPrefs(), rate });
}

export function savedVoiceUri(lang: "pt" | "en"): string | undefined {
  return readPrefs()[lang];
}

export function saveVoiceUri(lang: "pt" | "en", uri: string) {
  writePrefs({ ...readPrefs(), [lang]: uri });
}

const isNatural = (v: SpeechSynthesisVoice) =>
  /natural|neural|online|google|enhanced|aprimorad|premium|siri/i.test(v.name) || !v.localService;

function matchesLang(v: SpeechSynthesisVoice, lang: "pt" | "en"): boolean {
  const l = v.lang.toLowerCase().replace("_", "-");
  return lang === "pt" ? l.startsWith("pt") : l.startsWith("en");
}

/** Nota de qualidade: vozes naturais primeiro; português do Brasil antes do de Portugal. */
function score(v: SpeechSynthesisVoice, lang: "pt" | "en"): number {
  const l = v.lang.toLowerCase().replace("_", "-");
  let s = 0;
  if (/natural|neural/i.test(v.name)) s += 40; // Edge: Francisca, Antônio, Thalita…
  else if (/enhanced|aprimorad|premium|siri/i.test(v.name)) s += 32; // iPhone/Mac
  else if (/google/i.test(v.name)) s += 28; // Chrome/Android
  else if (!v.localService) s += 20;
  if (lang === "pt") s += l === "pt-br" ? 10 : 0;
  else s += l === "en-us" ? 6 : l === "en-gb" ? 4 : 0;
  return s;
}

/** Espera a lista de vozes (no Chrome ela chega um pouco depois de a página abrir). */
function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", finish);
    window.setTimeout(finish, 1500);
  });
}

function sortedVoices(all: SpeechSynthesisVoice[], lang: "pt" | "en"): SpeechSynthesisVoice[] {
  let list = all.filter((v) => matchesLang(v, lang));
  // Com voz do Brasil disponível, as de Portugal saem (sotaque estranha a leitura).
  if (lang === "pt" && list.some((v) => /pt-br/i.test(v.lang.replace("_", "-")))) {
    list = list.filter((v) => /pt-br/i.test(v.lang.replace("_", "-")));
  }
  return list.sort((a, b) => score(b, lang) - score(a, lang) || a.name.localeCompare(b.name));
}

function shortLabel(v: SpeechSynthesisVoice): string {
  return v.name
    .replace(/^Microsoft\s+/i, "")
    .replace(/\s+Online\s+\(Natural\)/i, " (Natural)")
    .replace(/\s+-\s+(Portuguese|English).*$/i, "")
    .trim();
}

/** Vozes do idioma para o painel de escolha, da melhor para a pior. */
export async function listVoices(lang: "pt" | "en"): Promise<VoiceOption[]> {
  if (!speechSupported()) return [];
  return sortedVoices(await voicesReady(), lang).map((v) => ({
    uri: v.voiceURI,
    label: shortLabel(v),
    lang: v.lang,
    natural: isNatural(v),
  }));
}

/** Voz escolhida pelo leitor (se ainda existir) ou a melhor disponível. */
async function resolveVoice(lang: "pt" | "en"): Promise<SpeechSynthesisVoice | undefined> {
  const list = sortedVoices(await voicesReady(), lang);
  const chosen = savedVoiceUri(lang);
  return list.find((v) => v.voiceURI === chosen) ?? list[0];
}

/** Frases de até ~280 caracteres (parágrafos enormes travam algumas vozes). */
function pieces(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’»)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > 280) {
      out.push(cur);
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export type SpeechSession = { stop: () => void };

/**
 * Lê os parágrafos a partir de `start`. `onParagraph` recebe o índice do parágrafo atual;
 * `onEnd` é chamado ao terminar o último (não é chamado se `stop()` interromper).
 */
export function speakParagraphs(
  paragraphs: string[],
  start: number,
  lang: "pt" | "en",
  rate: number,
  onParagraph: (index: number) => void,
  onEnd: () => void,
): SpeechSession {
  const synth = window.speechSynthesis;
  synth.cancel();
  let stopped = false;
  // Algumas vozes do Chrome param sozinhas depois de ~15 s: um "resume" periódico evita.
  const keepAlive = window.setInterval(() => {
    if (!stopped && synth.speaking && !synth.paused) synth.resume();
  }, 10_000);

  let voice: SpeechSynthesisVoice | undefined;
  const speakAt = (i: number) => {
    if (stopped) return;
    if (i >= paragraphs.length) {
      window.clearInterval(keepAlive);
      onEnd();
      return;
    }
    const text = paragraphs[i].replace(/_/g, "").trim();
    if (!text) return speakAt(i + 1);
    onParagraph(i);
    const parts = pieces(text);
    parts.forEach((part, k) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = voice?.lang ?? (lang === "pt" ? "pt-BR" : "en-US");
      if (voice) u.voice = voice;
      u.rate = rate;
      if (k === parts.length - 1) u.onend = () => speakAt(i + 1);
      u.onerror = (e) => {
        // "interrupted"/"canceled" = parou de propósito; outros erros pulam para o próximo parágrafo.
        if (!stopped && e.error !== "interrupted" && e.error !== "canceled" && k === parts.length - 1) {
          speakAt(i + 1);
        }
      };
      synth.speak(u);
    });
  };

  void resolveVoice(lang).then((v) => {
    voice = v;
    speakAt(start);
  });

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(keepAlive);
      synth.cancel();
    },
  };
}

/** Amostra curta para o leitor comparar vozes no painel. */
export function speakSample(uri: string, lang: "pt" | "en", rate: number) {
  const synth = window.speechSynthesis;
  synth.cancel();
  const voice = synth.getVoices().find((v) => v.voiceURI === uri);
  const u = new SpeechSynthesisUtterance(
    lang === "pt"
      ? "Era uma vez uma história que ganhava vida enquanto alguém a lia."
      : "Once upon a time, there was a story that came alive while someone read it.",
  );
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = rate;
  synth.speak(u);
}
