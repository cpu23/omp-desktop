export const IMAGE_FILE_LIMIT = 32 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function imageExtensionForMime(type: string): string | undefined {
  return Object.hasOwn(IMAGE_EXTENSIONS, type) ? IMAGE_EXTENSIONS[type] : undefined;
}
