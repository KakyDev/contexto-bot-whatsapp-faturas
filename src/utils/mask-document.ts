import { normalizeDigits } from "./normalize.js";

export function maskDocument(value: string): string {
  const digits = normalizeDigits(value);
  if (!digits) return "";
  return `***${digits.slice(-4)}`;
}
