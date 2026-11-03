/** Parse explicit whole minutes; an empty field must not mean "disable". */
export function parseIdleTimeoutInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}
