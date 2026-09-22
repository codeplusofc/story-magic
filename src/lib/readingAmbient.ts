/** Uma única dica no meio do capítulo (o nome do personagem já aparece no cabeçalho da bolha). */
export function midChapterReadingHint(_chapterLabel: string): string {
  return "Você já passou da metade deste capítulo. Alguma coisa te chamou a atenção até aqui?";
}

/** Ao mudar de capítulo, sem repetir o nome no corpo da mensagem. */
export function chapterTransitionMessage(chapterLabel: string): string {
  return `Começamos “${chapterLabel}”. Leia com calma, estou aqui se quiser conversar.`;
}
