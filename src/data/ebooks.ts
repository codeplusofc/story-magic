import type { Ebook } from "./types";

const RUINS_FULL = `RUÍNAS DA LANTERNA

Portão de pedra

O vento carrega cinza fina entre os pilares. À sua frente, o portão inclinado ainda guarda runas apagadas pelo tempo. Mara encosta a lanterna no mármore e sussurra: “Se você ouvir passos que não são nossos, não responda.”

Do outro lado da praça, Orion ajeita o manto e acena, como se este encontro já estivesse precificado.

Escolha de rota

Dois caminhos se abrem nas ruínas: a galeria subterrânea, onde o ar cheira a ferro e água parada; ou a torre inclinada, com degraus que rangem sob qualquer peso.

Mara inclina a cabeça, esperando sua palavra. Orion sorri e murmura que “qualquer caminho tem custo — só muda quem cobra”.

Eco distante

Um eco percorre os corredores — não é exatamente uma voz, mas lembra uma pergunta feita duas vezes. A história ainda não escolheu se isso é aviso ou convite.
Você pode falar com Mara ou Orion antes de seguir; o que disser pode mudar o tom do que vem a seguir.`;

/**
 * Catálogo: história original curta + livro em .txt local (`public/stories/…`).
 */
export const ebooks: Ebook[] = [
  {
    id: "seducao-diabolica",
    title: "Sedução Diabólica",
    author: "Barbara Cartland",
    sourceLabel: "Arquivo em public/stories/seducao-diabolica.txt",
    blurb:
      "Leitura por capítulos: o personagem comenta enquanto você rola. Trecho extra no texto só se você pedir (ex.: continua o capítulo) após a resposta dele.",
    cardGradient: "linear-gradient(135deg, #3a2832 0%, #221820 50%, #120c10 100%)",
    textLanguage: "pt",
    localStoryUrl: "/stories/seducao-diabolica.txt",
    chapterReading: true,
    readerContinuesStory: true,
    characters: [
      {
        id: "rochester",
        name: "Conde de Rochester",
        role: "Nobre da corte, cínico e galanteador",
        color: "#c9a88c",
        systemHint:
          "Você é o conde de Rochester, Inglaterra ~1802: espírito esportivo, ironia contida, charme perigoso. Responda em português do Brasil no tom do romance publicado (formal mas calor humano). 2–5 frases. Trate o leitor como visitante íntimo da cena.",
      },
      {
        id: "circe",
        name: "Lady Circe Langstone",
        role: "Anfitriã ambiciosa",
        color: "#9c7a9c",
        systemHint:
          "Você é lady Circe Langstone: inteligência social, sedução calculada, olhar verde famoso. Português BR, época regência. 2–5 frases. Não quebre o suspense cruel do enredo; jogue com poder e vulnerabilidade velada.",
      },
      {
        id: "ofelia",
        name: "Ofélia Langstone",
        role: "Enteada em conflito com a madrasta",
        color: "#a8b8c8",
        systemHint:
          "Você é Ofélia Langstone: juventude, medo e dignidade misturados. Português BR, época. 2–5 frases. Pode confiar ou hesitar com o leitor conforme a conversa.",
      },
    ],
  },
  {
    id: "ruins",
    title: "Ruínas da lanterna",
    author: "Storyverse (original)",
    sourceLabel: "História criada para o Storyverse",
    blurb:
      "Fantasia leve: diga \"quero seguir\" no chat para a leitura avançar com a IA após a fala dos personagens.",
    cardGradient: "linear-gradient(135deg, #2a3530 0%, #1a2220 50%, #0f1412 100%)",
    textLanguage: "pt",
    embeddedFullText: RUINS_FULL,
    readerContinuesStory: true,
    characters: [
      {
        id: "mara",
        name: "Mara",
        role: "Guia nas ruínas",
        color: "#9cb9a8",
        systemHint:
          "Mara é cautelosa, ironia leve, conhece lendas locais. Responde em português do Brasil, 2–5 frases curtas.",
      },
      {
        id: "orion",
        name: "Orion",
        role: "Mercador de relíquias",
        color: "#9eb8c9",
        systemHint:
          "Orion fala rápido, negocia, esconde medo com humor. Português BR, tom coloquial leve.",
      },
    ],
  },
];

export function getEbook(id: string): Ebook | undefined {
  return ebooks.find((b) => b.id === id);
}
