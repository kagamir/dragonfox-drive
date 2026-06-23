import { http } from "./client";
import type {
  AuthResponse,
  LoginRequest,
  PreloginResponse,
  RegisterRequest,
  TokenPair,
} from "./types";

export const authApi = {
  register: (body: RegisterRequest) =>
    http.post<AuthResponse>("/api/auth/register", body),

  prelogin: (username: string) =>
    http.post<PreloginResponse>("/api/auth/prelogin", { username }),

  login: (body: LoginRequest) =>
    http.post<AuthResponse>("/api/auth/login", body),

  refresh: (refreshToken: string) =>
    http.post<TokenPair>("/api/auth/refresh", { refresh_token: refreshToken }),
};
