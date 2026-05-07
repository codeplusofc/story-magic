/** Trecho do livro perto de onde o leitor está na rolagem (para o prompt da IA). */
export function excerptNearScrollRatio(
  fullText: string,
  scrollRatio01: number,
  maxChars = 3200,
): string {
  if (!fullText.length) return "";
  const r = Math.max(0, Math.min(1, scrollRatio01));
  const center = Math.floor(r * fullText.length);
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, center - half);
  const end = Math.min(fullText.length, start + maxChars);
  const left = start > 0;
  const right = end < fullText.length;
  const body = fullText.slice(start, end);
  return `${left ? "…" : ""}${body}${right ? "…" : ""}`;
}
