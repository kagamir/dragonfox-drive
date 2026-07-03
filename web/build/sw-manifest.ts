import { computeBuildHash, type HashEntry } from "../src/sw/hash";

export interface SwManifest {
  version: string;
  buildHash: string;
  assets: string[];
}

export async function buildManifest(version: string, entries: HashEntry[]): Promise<SwManifest> {
  const assets = entries.map((e) => e.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const buildHash = await computeBuildHash(entries);
  return { version, buildHash, assets };
}
