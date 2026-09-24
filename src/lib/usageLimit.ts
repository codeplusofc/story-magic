/**
 * Limite diário de mensagens para os personagens, por navegador. Protege a cota das chaves de IA
 * de quem manda mensagem sem parar. Não é uma trava de segurança: as chaves `VITE_*` continuam
 * visíveis no navegador (a trava de verdade precisa de uma função no servidor).
 */
export const DAILY_MESSAGE_LIMIT = 30;
const KEY = "storyverse:usage";

type Usage = { day: string; count: number };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function read(): Usage {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) ?? "null") as Usage | null;
    if (u && u.day === today() && typeof u.count === "number") return u;
  } catch {
    // Sem armazenamento: começa do zero.
  }
  return { day: today(), count: 0 };
}

export function messagesLeftToday(): number {
  return Math.max(0, DAILY_MESSAGE_LIMIT - read().count);
}

/** Conta uma resposta recebida da IA (falhas não contam). */
export function countMessage(): number {
  const u = read();
  u.count += 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    // Sem armazenamento: o limite só não é aplicado.
  }
  return Math.max(0, DAILY_MESSAGE_LIMIT - u.count);
}
