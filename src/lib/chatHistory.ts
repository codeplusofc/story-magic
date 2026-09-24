/** Conversa com os personagens de cada livro, guardada no navegador para continuar depois. */

export type ChatMsg = { id: string; role: "user" | "assistant"; text: string };
type SavedChat = { threads: Record<string, ChatMsg[]>; activeCharId: string; updatedAt: number };

const KEY = (bookId: string) => `storyverse:chat:${bookId}`;
/** Mensagens guardadas por personagem (as mais recentes); a IA só recebe as últimas 10. */
const MAX_PER_CHARACTER = 80;
/** Conversas guardadas no total: as mais antigas saem quando passar disso. */
const MAX_BOOKS = 25;
const INDEX_KEY = "storyverse:chat-index";

export function loadChat(bookId: string): SavedChat | null {
  try {
    const raw = localStorage.getItem(KEY(bookId));
    const saved = raw ? (JSON.parse(raw) as SavedChat) : null;
    return saved && typeof saved.threads === "object" ? saved : null;
  } catch {
    return null;
  }
}

export function saveChat(bookId: string, threads: Record<string, ChatMsg[]>, activeCharId: string) {
  const trimmed = Object.fromEntries(
    Object.entries(threads).map(([id, msgs]) => [id, msgs.slice(-MAX_PER_CHARACTER)]),
  );
  try {
    localStorage.setItem(
      KEY(bookId),
      JSON.stringify({ threads: trimmed, activeCharId, updatedAt: Date.now() } satisfies SavedChat),
    );
    // Índice dos livros com conversa, para apagar as mais antigas.
    const index = (JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as string[]).filter((b) => b !== bookId);
    index.unshift(bookId);
    for (const old of index.splice(MAX_BOOKS)) localStorage.removeItem(KEY(old));
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Sem espaço: a conversa só não fica guardada.
  }
}

export function forgetChat(bookId: string) {
  try {
    localStorage.removeItem(KEY(bookId));
  } catch {
    // Nada a limpar.
  }
}
