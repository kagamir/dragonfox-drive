const mediaByExtension: Record<string, string> = {
  apng: "image/apng", avif: "image/avif", bmp: "image/bmp", gif: "image/gif",
  heic: "image/heic", heif: "image/heif", ico: "image/vnd.microsoft.icon",
  jfif: "image/jpeg", jpeg: "image/jpeg", jpg: "image/jpeg", jxl: "image/jxl",
  png: "image/png", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
  dng: "image/x-adobe-dng", arw: "image/x-sony-arw", cr2: "image/x-canon-cr2",
  cr3: "image/x-canon-cr3", nef: "image/x-nikon-nef", raf: "image/x-fuji-raf",
  rw2: "image/x-panasonic-rw2", orf: "image/x-olympus-orf",
  "3gp": "video/3gpp", avi: "video/x-msvideo", flv: "video/x-flv", m2ts: "video/mp2t",
  m4v: "video/x-m4v", mkv: "video/x-matroska", mov: "video/quicktime", mp4: "video/mp4",
  mpeg: "video/mpeg", mpg: "video/mpeg", mts: "video/mp2t", ogv: "video/ogg",
  webm: "video/webm", wmv: "video/x-ms-wmv",
};

/** An explicit content type wins, even for a misleading file extension. */
export function displayMime(mime?: string, name?: string): string {
  const type = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return type;
  const suffix = name?.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(mediaByExtension, suffix) ? mediaByExtension[suffix] : type;
}

export function mediaKind(mime?: string, name?: string): "image" | "video" | null {
  const type = displayMime(mime, name);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return null;
}
