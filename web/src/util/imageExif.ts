import { parse } from "exifr";

export type CameraData = Partial<Record<
  "camera" | "lens" | "focalLength" | "aperture" | "shutter" | "sensitivity" | "captured", string
>>;

const tags = ["Make", "Model", "LensMake", "LensModel", "FocalLength", "FNumber", "ExposureTime", "ISO", "DateTimeOriginal"];

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 180) : "";
}

function product(make: unknown, model: unknown) {
  const brand = text(make);
  const name = text(model);
  return name.toLowerCase().startsWith(brand.toLowerCase()) ? name : [brand, name].filter(Boolean).join(" ");
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const rounded = (n: number) => String(Number(n.toPrecision(4)));

export async function readCameraData(bytes: Uint8Array): Promise<CameraData> {
  if (bytes.length < 4) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const magic = view.getUint32(0);
  if (!(magic >>> 16 === 0xffd8 || magic === 0x49492a00 ||
      magic === 0x4d4d002a || (bytes.length >= 12 && view.getUint32(4) === 0x66747970))) {
    return {};
  }
  const raw = await parse(bytes, { pick: tags, reviveValues: false, gps: false, xmp: false, icc: false,
    iptc: false, ifd1: false, makerNote: false, userComment: false }) as Record<string, unknown> | undefined;
  if (!raw) return {};
  const result: CameraData = {};
  const camera = product(raw.Make, raw.Model);
  const lens = product(raw.LensMake, raw.LensModel);
  const focal = positive(raw.FocalLength);
  const f = positive(raw.FNumber);
  const sec = positive(raw.ExposureTime);
  const iso = positive(raw.ISO);
  const date = text(raw.DateTimeOriginal);
  if (camera) result.camera = camera;
  if (lens) result.lens = lens;
  if (focal) result.focalLength = rounded(focal) + " mm";
  if (f) result.aperture = "ƒ/" + rounded(f);
  if (sec) result.shutter = sec <= .5 ? "1/" + rounded(1 / sec) + " s" : rounded(sec) + " s";
  if (iso) result.sensitivity = rounded(iso);
  if (date) result.captured = date.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  return result;
}

export async function readCameraBlob(blob: Blob): Promise<CameraData> {
  const limit = 4 * 1024 * 1024;
  const head = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (head.byteLength < 12) return {};
  const webp = head.getUint32(0) === 0x52494646 && head.getUint32(8) === 0x57454250;
  const png = head.getUint32(0) === 0x89504e47 && head.getUint32(4) === 0x0d0a1a0a;
  if (!webp && !png) return readCameraData(new Uint8Array(await blob.slice(0, limit).arrayBuffer()));

  // Both formats may store EXIF *after* compressed pixels. Seek from header to
  // header and read only the tagged segment, regardless of the size of the image.
  let offset = webp ? 12 : 8;
  while (offset + 8 <= blob.size) {
    const chunk = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    const size = webp ? chunk.getUint32(4, true) : chunk.getUint32(0);
    const type = chunk.getUint32(webp ? 0 : 4);
    const start = offset + 8;
    if (start + size > blob.size) throw new Error("Truncated image chunk");
    if (type === (webp ? 0x45584946 : 0x65584966)) {
      if (size > limit) throw new Error("EXIF segment exceeds read limit");
      const bytes = new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
      const withPrefix = bytes.length >= 6 && [69, 120, 105, 102, 0, 0].every((n, i) => bytes[i] === n);
      return readCameraData(withPrefix ? bytes.subarray(6) : bytes);
    }
    offset = start + size + (webp ? size % 2 : 4);
  }
  return {};
}
