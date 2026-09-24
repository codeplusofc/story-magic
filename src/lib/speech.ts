/**
 * Leitura em voz alta com a voz do próprio aparelho (Web Speech API): grátis e sem internet.
 * Fala um parágrafo por vez (o Chrome corta falas muito longas) e avisa qual está sendo lido.
 */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

/** Melhor voz disponível para o idioma: prefere vozes "naturais"/online, que soam menos robóticas. */
function pickVoice(lang: "pt" | "en"): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const wanted = lang === "pt" ? ["pt-BR", "pt"] : ["en-US", "en-GB", "en"];
  const score = (v: SpeechSynthesisVoice) => {
    const i = wanted.findIndex((w) => v.lang.toLowerCase().startsWith(w.toLowerCase()));
    if (i < 0) return -1;
    const natural = /natural|neural|google|online/i.test(v.name) ? 10 : 0;
    return 100 - i * 20 + natural + (v.localService ? 0 : 1);
  };
  return voices
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)[0]?.v;
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

  const voice = pickVoice(lang);
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

  // No Chrome a lista de vozes chega depois do primeiro acesso.
  if (synth.getVoices().length === 0) {
    let started = false;
    const once = () => {
      synth.removeEventListener("voiceschanged", once);
      if (started) return;
      started = true;
      speakAt(start);
    };
    synth.addEventListener("voiceschanged", once);
    window.setTimeout(once, 600);
  } else {
    speakAt(start);
  }

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(keepAlive);
      synth.cancel();
    },
  };
}
