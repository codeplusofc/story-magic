export type StoryCharacter = {
  id: string;
  name: string;
  role: string;
  color: string;
  systemHint: string;
};

export type Ebook = {
  id: string;
  title: string;
  author: string;
  sourceLabel: string;
  sourceUrl?: string;
  blurb: string;
  cardGradient: string;
  characters: StoryCharacter[];
  /**
   * Caminho público do .txt (ex.: `/stories/livro.txt` em `public/stories/livro.txt`).
   * Mutuamente exclusivo com `embeddedFullText`.
   */
  localStoryUrl?: string;
  /** Texto integral embutido (história original curta). Mutuamente exclusivo com `localStoryUrl`. */
  embeddedFullText?: string;
  /** Idioma do texto integral, para o prompt da IA. */
  textLanguage: "pt" | "en";
  /**
   * Se true, frases como "quero seguir" / "continuar" após a resposta do personagem
   * pedem um trecho narrativo novo (no capítulo atual, se `chapterReading` estiver ativo).
   */
  readerContinuesStory?: boolean;
  /**
   * Mostra um capítulo de cada vez (marcadores CAPÍTULO no .txt), navegação entre capítulos
   * e comentários do personagem conforme a rolagem dentro do capítulo.
   */
  chapterReading?: boolean;
};
