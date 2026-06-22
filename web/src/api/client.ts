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
  method?: "GET" | "POST" | "PUT" | "DELETE";
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

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    rawBody,
    rawResponse,
    token = authToken,
    headers = {},
    signal,
  } = opts;

  const finalHeaders: Record<string, string> = { ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && !rawBody) finalHeaders["Content-Type"] = "application/json";

  const init: RequestInit = {
    method,
    headers: finalHeaders,
    signal,
  };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`, 0);
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
  delete: <T>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "DELETE" }),
};
