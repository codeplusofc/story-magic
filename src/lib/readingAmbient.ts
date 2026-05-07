/**
 * Uma única dica no meio do capítulo (o nome do personagem já aparece no cabeçalho da bolha).
 */
export function midChapterReadingHint(chapterLabel: string): string {
  return `Já foi longe em “${chapterLabel}”. Se quiser um trecho inventado só neste capítulo, diga “continua o capítulo” depois da minha próxima resposta.`;
}

/** Ao mudar de capítulo — sem repetir o nome no corpo da mensagem. */
export function chapterTransitionMessage(chapterLabel: string): string {
  return `Agora estamos em “${chapterLabel}”. Vou reagindo à medida que for lendo; pode rolar com calma.`;
}
