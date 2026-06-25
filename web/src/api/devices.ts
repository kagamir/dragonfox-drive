import { http } from "./client";
import type { DeviceItem } from "./types";

export interface ListDevicesResponse {
  devices: DeviceItem[];
}

export const devicesApi = {
  list(): Promise<DeviceItem[]> {
    return http
      .get<ListDevicesResponse>("/api/devices")
      .then((r) => r.devices);
  },
  revoke(id: string): Promise<void> {
    return http
      .delete<{ ok: boolean }>(`/api/devices/${encodeURIComponent(id)}`)
      .then(() => undefined);
  },
};
