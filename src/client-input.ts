export const MAX_INPUT_CHUNK_CODE_UNITS = 16_384;

/** Split terminal input into protocol-safe chunks without separating UTF-16 pairs. */
export function* splitInputChunks(data: string): Generator<string> {
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + MAX_INPUT_CHUNK_CODE_UNITS, data.length);
    if (end < data.length) {
      const last = data.charCodeAt(end - 1);
      const next = data.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    yield data.slice(start, end);
    start = end;
  }
}
