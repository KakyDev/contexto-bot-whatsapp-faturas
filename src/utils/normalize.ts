export function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getLastDocumentDigits(cpfCnpj: string, count = 4): string {
  const digits = normalizeDigits(cpfCnpj);
  if (digits.length < count) throw new Error("cpf_cnpj nao possui digitos suficientes");
  return digits.slice(-count);
}
