export type StoryCharacter = {
  id: string;
  name: string;
  /** Nome curto para botões e sugestões (ex.: "Holmes" em vez de "Sherlock Holmes"). */
  shortName?: string;
  role: string;
  color: string;
  systemHint: string;
  /** Primeira fala no chat, na voz do personagem. */
  greeting?: string;
};

/** Exemplo de conversa exibido na página inicial (só para livros em destaque). */
export type HeroDemo = {
  chapterLabel: string;
  /** Início real do texto do livro. */
  pageOpening: string;
  question: string;
  answer: string;
};

export type Ebook = {
  id: string;
  /** Número do livro no Project Gutenberg — o texto é baixado de lá. */
  gutenbergId: number;
  title: string;
  author: string;
  /** Gênero curto exibido na capa (ex.: "Mistério"). */
  genre?: string;
  blurb?: string;
  /** Capa do Gutenberg; sem ela, o app desenha uma capa tipográfica. */
  coverUrl?: string;
  /** Idioma do texto integral, para o prompt da IA e o selo na estante. */
  textLanguage: "pt" | "en";
  /** Personagens escritos à mão. Sem eles, a IA sugere os personagens ao abrir o livro. */
  characters?: StoryCharacter[];
  demo?: HeroDemo;
  /** Seção da estante em destaque. */
  shelf?: "pt" | "terror" | "classicos";
  /** "local": importado pelo leitor, com o texto guardado só no navegador (id negativo). */
  source?: "gutenberg" | "local";
};
