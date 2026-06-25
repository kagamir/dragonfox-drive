import { http } from "./client";
import type { PublicConfig } from "./types";

export const configApi = {
  get: () => http.get<PublicConfig>("/api/config"),
};
