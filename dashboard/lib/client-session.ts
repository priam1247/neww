import { AuthUser, UserQuota } from './types';

export const AUTH_TOKEN_STORAGE_KEY = 'zafar_session_token_v1';

export function getSavedSessionToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setSavedSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore storage errors
  }
}

export function clearSavedSessionToken(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function authHeaders(): HeadersInit {
  const token = getSavedSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['x-session-token'] = token;
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchCurrentSession(): Promise<{
  user: AuthUser;
  quota: UserQuota | null;
} | null> {
  try {
    const token = getSavedSessionToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['x-session-token'] = token;
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch('/api/auth/me', {
      headers,
      cache: 'no-store',
    });
    if (!res.ok) {
      if (token) clearSavedSessionToken();
      return null;
    }
    const data = await res.json();
    if (!data?.user) return null;
    return { user: data.user, quota: data.quota || null };
  } catch {
    return null;
  }
}

export async function performSignOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  clearSavedSessionToken();
}
