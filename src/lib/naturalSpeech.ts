/**
 * Deixa a resposta da IA com cara de fala de chat. Os modelos insistem em travessões (—), ações
 * entre asteriscos (*sorri*), negrito e listas, mesmo quando o prompt pede para não usar; aqui a
 * resposta é limpa antes de aparecer (e antes de ir para o histórico da conversa).
 */

/** Instrução de estilo enviada no prompt de todos os personagens. */
export const NATURAL_SPEECH_RULES =
  "Escreva como uma mensagem de conversa falada: frases simples, pontuadas só com vírgulas, pontos, interrogação e exclamação. " +
  "Não use travessão (—), hífen como pausa, reticências em excesso, asteriscos, ações ou gestos entre asteriscos ou parênteses, listas, títulos nem negrito. " +
  "Não escreva seu nome antes da fala.";

/** Trecho entre asteriscos ou parênteses que descreve uma ação ("*sorri*", "(suspira)"). */
const ACTION = /(^|[.!?…]\s+|\n)\s*(\*[^*\n]{1,80}\*|\([^()\n]{1,80}\))\s*/g;
const TRAILING_ACTION = /\s*(\*[^*\n]{1,80}\*|\([^()\n]{1,80}\))\s*$/;

export function naturalizeReply(raw: string, names: string[] = []): string {
  let t = raw.replace(/\r\n?/g, "\n").trim();

  // "Isaura: ..." ou "**Isaura:** ..." no começo.
  for (const name of names.filter(Boolean)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\**\\s*${esc}\\s*\\**\\s*:\\s*\\**`, "i"), "");
  }

  // Resposta inteira entre aspas.
  const quoted = t.match(/^["“«](.*)["”»]$/s);
  if (quoted && !/["“”«»]/.test(quoted[1])) t = quoted[1].trim();

  // Markdown: títulos e negrito.
  t = t
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1");

  // Lista vira enumeração falada: "ler, cantar e a liberdade".
  t = t.replace(/(?:^[ \t]*(?:[-•*]|\d+[.)])[ \t]+.+(?:\n|$))+/gm, (block) => {
    const items = block
      .split("\n")
      .map((l) => l.replace(/^[ \t]*(?:[-•*]|\d+[.)])[ \t]+/, "").replace(/[.;,]+$/, "").trim())
      .filter(Boolean)
      // "Nunca mentir" vira "nunca mentir" no meio da frase; nome solto ("Isaura") fica como está.
      .map((item) => (/\s/.test(item) ? item.charAt(0).toLowerCase() + item.slice(1) : item));
    const spoken = items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}` : items[0] ?? "";
    return `${spoken}.\n`;
  });
  // "três coisas:" + lista na linha de baixo fica na mesma frase.
  t = t.replace(/:\s*\n/g, ": ");

  // Ações no começo da frase ou no fim da fala saem; ênfase curta (*muito*) vira texto normal.
  t = t.replace(ACTION, (_m, before: string) => (before.trim() ? `${before.trimEnd()} ` : before));
  t = t.replace(TRAILING_ACTION, "");
  t = t.replace(/\*([^*\n]+)\*/g, "$1").replace(/_([^_\n]+)_/g, "$1");

  // Travessões: de diálogo no começo da linha saem; no meio da frase viram vírgula.
  t = t
    .replace(/^\s*(?:—|–|--|-)\s*/gm, "")
    .replace(/\s*(?:—|–|--)\s*/g, ", ")
    .replace(/\s+-\s+/g, ", ");

  // Linhas soltas viram um texto só (como uma mensagem).
  t = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?…:,;]$/.test(l) ? l : `${l}.`))
    .join(" ");

  // Arruma a pontuação que sobrou das trocas.
  t = t
    .replace(/,\s*([.!?…])/g, "$1")
    .replace(/([.!?…])\s*,/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^\s*,\s*/, "")
    .replace(/,\s*$/, ".")
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/([,.!?…])(?=[\p{L}])/gu, "$1 ")
    .replace(/\.{4,}/g, "...")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Maiúscula no começo da fala e depois de ponto final (não depois de reticências).
  t = t.replace(/(^|(?<![.…])[.!?]\s+)(\p{Ll})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
  return t || raw.trim();
}
