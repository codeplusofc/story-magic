import type { Ebook } from "../data/types";

/**
 * Livros que o leitor importou. Ficam só neste navegador (IndexedDB): o arquivo nunca sai do
 * aparelho. O localStorage não serve aqui porque um livro inteiro passa do limite dele.
 */
const DB_NAME = "storyverse-books";
const STORE = "books";

type StoredBook = { id: number; book: Ebook; text: string; importedAt: number };

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Armazenamento do navegador indisponível."));
    };
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * Livros importados usam `gutenbergId` negativo: assim progresso, traduções e elenco guardados
 * funcionam igual aos do acervo, sem colidir com os números do Gutenberg.
 */
export function newLocalBookId(): number {
  return -Date.now();
}

export function isLocalBook(book: Ebook): boolean {
  return book.source === "local";
}

export async function saveLocalBook(book: Ebook, text: string): Promise<void> {
  try {
    await run("readwrite", (s) =>
      s.put({ id: book.gutenbergId, book, text, importedAt: Date.now() } satisfies StoredBook),
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      throw new Error("Não há espaço no navegador para este livro. Remova um livro importado e tente de novo.");
    }
    throw e;
  }
}

export async function loadLocalBookText(id: number): Promise<string> {
  const stored = await run<StoredBook | undefined>("readonly", (s) => s.get(id));
  if (!stored) {
    throw new Error("Este livro não está mais neste aparelho. Importe o arquivo de novo.");
  }
  return stored.text;
}

/** Livros importados, do mais recente para o mais antigo. */
export async function listLocalBooks(): Promise<Ebook[]> {
  try {
    const all = await run<StoredBook[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.importedAt - a.importedAt).map((b) => b.book);
  } catch {
    return [];
  }
}

export async function deleteLocalBook(id: number): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}
