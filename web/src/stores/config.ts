/**
 * Public config store: holds non-secret runtime flags fetched from
 * `GET /api/config` so the UI can adapt before the user signs in (e.g. hiding
 * the registration form on a locked-down instance).
 */

import { defineStore } from "pinia";
import { ref } from "vue";

import { configApi } from "@/api/config";

export const useConfigStore = defineStore("config", () => {
  // Optimistic default matches the server's open-by-default behaviour so the
  // register link is visible immediately, before the fetch resolves.
  const allowRegistration = ref(true);
  const loaded = ref(false);

  async function load(): Promise<void> {
    try {
      const cfg = await configApi.get();
      allowRegistration.value = cfg.allow_registration;
    } catch {
      // Keep the optimistic default; the backend will reject registration with
      // 403 if it is actually closed, and the form surfaces that error.
    } finally {
      loaded.value = true;
    }
  }

  return { allowRegistration, loaded, load };
});
