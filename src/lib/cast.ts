import type { Ebook, StoryCharacter } from "../data/types";
import { suggestBookCharacters } from "./ai";

const CAST_KEY = (bookId: string) => `storyverse:cast:${bookId}`;

function readCached(bookId: string): StoryCharacter[] | null {
  try {
    const raw = localStorage.getItem(CAST_KEY(bookId));
    const list = raw ? (JSON.parse(raw) as StoryCharacter[]) : null;
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

/** Elenco do livro: escrito à mão, guardado no navegador, ou sugerido pela IA (uma vez só). */
export async function loadCast(book: Ebook, opening: string): Promise<StoryCharacter[]> {
  if (book.characters?.length) return book.characters;
  const cached = readCached(book.id);
  if (cached) return cached;

  const cast = await suggestBookCharacters({ title: book.title, author: book.author, opening });
  // Só guarda elenco de verdade; o narrador de reserva pode ser trocado quando a IA voltar.
  if (!(cast.length === 1 && cast[0].id === "narrador")) {
    try {
      localStorage.setItem(CAST_KEY(book.id), JSON.stringify(cast));
    } catch {
      // Sem armazenamento: a IA será chamada de novo na próxima vez.
    }
  }
  return cast;
}
