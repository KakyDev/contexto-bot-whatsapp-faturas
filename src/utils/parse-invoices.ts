export interface ParsedInvoice {
  option: string;
  reference: string;
  value: string;
  dueDate: string;
  raw: string;
}

const invoiceRegex =
  /(?:^|\s)(\d{1,3})\s*(?:-|\u2013|\u2014)?\s*Refer\S*ncia\s*:?\s*(\d{2}\/\d{4})\s*(?:-|\u2013|\u2014)?\s*Valor\s*:?\s*R\$\s*([\d.,]+)\s*(?:-|\u2013|\u2014)?\s*Vencimento\s*:?\s*(\d{2}\/\d{2}\/\d{4})/giu;

export function parseInvoices(text: string): ParsedInvoice[] {
  const normalizedText = normalizeInvoiceText(text).replace(/\r?\n/g, " ");
  return [...normalizedText.matchAll(invoiceRegex)].map((match) => ({
    option: match[1],
    reference: match[2],
    value: match[3],
    dueDate: match[4],
    raw: match[0].trim()
  }));
}

export function findInvoiceOption(text: string, reference: string): ParsedInvoice | undefined {
  return parseInvoices(text).find((invoice) => invoice.reference === reference);
}

export function latestInvoiceSelectionBlock(text: string): string {
  const normalized = text.replace(/\r?\n/g, "\n");
  const lower = normalized.toLowerCase();
  const searchable = normalizeInvoiceText(lower);
  const lastQuestionIndex = lower.lastIndexOf("qual conta");
  const lastOpenInvoicesIndex = lower.lastIndexOf("faturas em aberto");
  const lastMarkerIndex = Math.max(lastQuestionIndex, lastOpenInvoicesIndex);
  if (lastMarkerIndex >= 0) return normalized.slice(lastMarkerIndex);

  const lastReferenceIndex = searchable.lastIndexOf("referencia:");
  if (lastReferenceIndex < 0) return normalized;

  const lineStart = normalized.lastIndexOf("\n", lastReferenceIndex);
  return normalized.slice(lineStart < 0 ? lastReferenceIndex : lineStart + 1);
}

function normalizeInvoiceText(text: string): string {
  return text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/[*_~`]/g, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u00a0/g, " ");
}
