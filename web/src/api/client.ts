/**
 * HTTP client wrapper. Adds JSON headers, Bearer token, and unwraps the
 * server's `{ "error": "..." }` envelope into a thrown `ApiError`.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Skip JSON encoding and send body as-is (raw bytes). */
  rawBody?: BodyInit;
  /** Skip JSON parsing of the response. */
  rawResponse?: boolean;
  /** Override Authorization header. `null` to omit. */
  token?: string | null;
  /** Extra headers. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const BASE = ""; // Same-origin in production; Vite proxy in development.

const REFRESH_KEY = "df_refresh_token";

let authToken: string | null = null;
let refreshToken: string | null = null;
let inflightRefresh: Promise<boolean> | null = null;

/**
 * Registered by the auth store (via App.vue) so client.ts can signal a
 * session-loss event (refresh-token failure) without importing the store
 * directly (which would create a cycle: stores import client, client must
 * not import stores).
 */
export type SessionLostCallback = () => void | Promise<void>;
let sessionLostCallback: SessionLostCallback | null = null;

export function onSessionLost(cb: SessionLostCallback): void {
  sessionLostCallback = cb;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export function setRefreshToken(token: string | null): void {
  refreshToken = token;
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function clearRefreshToken(): void {
  setRefreshToken(null);
}

/** Load a persisted refresh token from localStorage into module state. */
export function loadStoredRefreshToken(): string | null {
  refreshToken = localStorage.getItem(REFRESH_KEY);
  return refreshToken;
}

/**
 * Exchange the current refresh token for a new pair. Uses a raw fetch (not
 * `request`) so it bypasses the 401 interceptor. Concurrent callers share one
 * in-flight promise. Returns false if there is no token or the refresh failed.
 */
async function refreshAndRetry(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  const rt = refreshToken;
  if (!rt) return false;
  inflightRefresh = (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
      const pair = (await res.json()) as { access_token: string; refresh_token: string };
      setAuthToken(pair.access_token);
      setRefreshToken(pair.refresh_token);
      return true;
    } catch {
      clearRefreshToken();
      setAuthToken(null);
      if (sessionLostCallback) {
        try {
          await sessionLostCallback();
        } catch {
          /* swallow; auth store owns its own failures */
        }
      }
      return false;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/** Refresh the access token once; returns false if there is no refresh token or refresh failed. */
export async function refreshAuthToken(): Promise<boolean> {
  return refreshAndRetry();
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    rawBody,
    rawResponse,
    token, // undefined => use current authToken (re-read on replay)
    headers = {},
    signal,
  } = opts;

  const buildInit = (): RequestInit => {
    const effectiveToken = token !== undefined ? token : authToken;
    const finalHeaders: Record<string, string> = { ...headers };
    if (effectiveToken) finalHeaders.Authorization = `Bearer ${effectiveToken}`;
    if (body !== undefined && !rawBody) finalHeaders["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers: finalHeaders, signal };
    if (rawBody !== undefined) init.body = rawBody;
    else if (body !== undefined) init.body = JSON.stringify(body);
    return init;
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, buildInit());
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`, 0);
  }

  // Auto-refresh once on 401 (never on the refresh endpoint itself), then
  // replay the original request so the caller sees a success or a real error.
  if (
    res.status === 401 &&
    !path.startsWith("/api/auth/refresh") &&
    token === undefined &&
    getRefreshToken()
  ) {
    const ok = await refreshAndRetry();
    if (ok) {
      try {
        res = await fetch(`${BASE}${path}`, buildInit());
      } catch (e) {
        throw new ApiError(`Network error: ${(e as Error).message}`, 0);
      }
    }
  }

  if (res.status === 204) return undefined as T;

  if (rawResponse) {
    if (!res.ok) throw new ApiError(res.statusText, res.status);
    return res as unknown as T;
  }

  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText) || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }

  return parsed as T;
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "POST", body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "DELETE" }),
};
