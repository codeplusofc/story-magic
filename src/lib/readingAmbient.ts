/** Uma única dica no meio do capítulo (o nome do personagem já aparece no cabeçalho da bolha). */
export function midChapterReadingHint(_chapterLabel: string): string {
  return "Você já passou da metade deste capítulo. Alguma coisa te chamou a atenção até aqui?";
}

/** Ao mudar de capítulo, sem repetir o nome no corpo da mensagem. */
export function chapterTransitionMessage(chapterLabel: string): string {
  return `Começamos “${chapterLabel}”. Leia com calma, estou aqui se quiser conversar.`;
}

const MISS_YOU = [
  (ch: string) => `Você sumiu… fiquei pensando no que aconteceu em “${ch}”. Vamos continuar de onde paramos?`,
  (ch: string) => `Que bom que você voltou! Paramos em “${ch}” — ainda tem muita coisa pela frente.`,
  (ch: string) => `Estava te esperando. A história ficou parada em “${ch}”… e eu também.`,
  (ch: string) => `Achei que tinha me esquecido! Voltamos para “${ch}”?`,
];

/**
 * Personagem com saudade, quando o leitor volta ao livro depois de alguns dias (frases prontas:
 * não gastam IA). `days` escolhe a frase, para variar entre as voltas.
 */
export function missYouMessage(chapterLabel: string, days: number): string {
  return MISS_YOU[days % MISS_YOU.length](chapterLabel);
}
