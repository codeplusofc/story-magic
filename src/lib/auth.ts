const SESSION_KEY = "storyverse:supabase-session";
const LEGACY_AUTH_KEY = "storyverse:auth";

export type SupabaseUser = {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
};

export type SupabaseSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: SupabaseUser;
};

type AuthResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: SupabaseUser;
  msg?: string;
  message?: string;
  error_description?: string;
};

function authConfig() {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error("Autenticação indisponível: configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.");
  }
  try {
    const parsed = new URL(url);
    const localDevelopment = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !localDevelopment) {
      throw new Error("A conexão com o Supabase precisa usar HTTPS.");
    }
  } catch {
    throw new Error("A URL do Supabase é inválida ou não usa uma conexão segura.");
  }
  return { url, anonKey };
}

function describeAuthError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (normalized.includes("user already registered")) return "Já existe uma conta com este e-mail. Faça login.";
  if (normalized.includes("email not confirmed")) return "Confirme seu e-mail antes de fazer login.";
  if (normalized.includes("password should be at least")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (normalized.includes("signup is disabled")) return "O cadastro está temporariamente indisponível.";
  if (normalized.includes("too many requests")) return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  return message;
}

async function authRequest(path: string, body?: Record<string, unknown>, accessToken?: string): Promise<AuthResponse> {
  const { url, anonKey } = authConfig();
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/${path}`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Não foi possível conectar ao serviço de autenticação. Verifique sua conexão.");
  }

  const payload = (await response.json().catch(() => ({}))) as AuthResponse;
  if (!response.ok) {
    const message = payload.msg ?? payload.message ?? payload.error_description ?? "Falha na autenticação.";
    throw new Error(describeAuthError(message));
  }
  return payload;
}

function makeSession(payload: AuthResponse): SupabaseSession | null {
  if (!payload.access_token || !payload.refresh_token || !payload.user) return null;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at ?? Math.floor(Date.now() / 1000) + (payload.expires_in ?? 3600),
    user: payload.user,
  };
}

function storeSession(session: SupabaseSession | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export function clearLegacyCredentials() {
  localStorage.removeItem(LEGACY_AUTH_KEY);
}

export async function signInWithPassword(email: string, password: string): Promise<SupabaseSession> {
  const payload = await authRequest("token?grant_type=password", { email, password });
  const session = makeSession(payload);
  if (!session) throw new Error("O serviço não retornou uma sessão válida.");
  storeSession(session);
  return session;
}

export async function signUpWithPassword(
  email: string,
  password: string,
  name: string,
): Promise<{ session: SupabaseSession | null }> {
  const redirect = encodeURIComponent(window.location.origin);
  const payload = await authRequest(`signup?redirect_to=${redirect}`, {
    email,
    password,
    data: { name },
  });
  const session = makeSession(payload);
  storeSession(session);
  return { session };
}

export async function refreshAuthSession(refreshToken: string): Promise<SupabaseSession> {
  const payload = await authRequest("token?grant_type=refresh_token", { refresh_token: refreshToken });
  const session = makeSession(payload);
  if (!session) throw new Error("Não foi possível renovar a sessão. Entre novamente.");
  storeSession(session);
  return session;
}

export async function restoreAuthSession(): Promise<SupabaseSession | null> {
  clearLegacyCredentials();
  const stored = localStorage.getItem(SESSION_KEY);
  if (!stored) return null;

  let session: SupabaseSession;
  try {
    session = JSON.parse(stored) as SupabaseSession;
  } catch {
    storeSession(null);
    return null;
  }
  if (
    !session.access_token ||
    !session.refresh_token ||
    !session.user?.id ||
    !Number.isFinite(session.expires_at)
  ) {
    storeSession(null);
    return null;
  }
  if (session.expires_at * 1000 <= Date.now() + 60_000) {
    try {
      return await refreshAuthSession(session.refresh_token);
    } catch (error) {
      storeSession(null);
      throw error;
    }
  }
  return session;
}

export async function signOut(session: SupabaseSession): Promise<void> {
  try {
    await authRequest("logout", undefined, session.access_token);
  } finally {
    storeSession(null);
  }
}
