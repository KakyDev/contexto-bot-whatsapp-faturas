import { z } from "zod";
import { normalizeDigits } from "../utils/normalize.js";
import { sanitizeFilePart } from "../utils/file-name.js";

export const rawInvoiceJobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  codigo_venda: z.union([z.string(), z.number()]).optional(),
  concessionaria: z.union([z.string(), z.number()]).optional(),
  identificador: z.union([z.string(), z.number()]).optional(),
  uc: z.union([z.string(), z.number()]).optional(),
  cpf: z.union([z.string(), z.number()]).optional(),
  "4 primeiros": z.union([z.string(), z.number()]).optional(),
  "4 ultimos": z.union([z.string(), z.number()]).optional(),
  cpf_cnpj: z.union([z.string(), z.number()]).optional(),
  nome_titular: z.union([z.string(), z.number()]).optional(),
  mes_referencia: z.union([z.string(), z.number()]).optional(),
  ref: z.union([z.string(), z.number()]).optional(),
  empresa: z.union([z.string(), z.number()]).optional(),
  observacao: z.union([z.string(), z.number()]).optional(),
  status: z.string().optional()
}).passthrough();

export type RawInvoiceJob = z.infer<typeof rawInvoiceJobSchema>;

export interface InvoiceJob {
  id: string;
  codigoVenda: string;
  identificador: string;
  uc: string;
  cpfCnpj: string;
  documentLastDigits: string;
  nomeTitular: string;
  mesReferencia: string;
  refOriginal: string;
  empresa: string;
  observacao: string;
  status?: string;
}

function requiredCell(value: unknown, field: string): string {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) throw new Error(`${field} obrigatorio`);
  return text;
}

function normalizeReference(value: string): string {
  const reference = value.trim();
  const monthYear = /^(\d{2})\/(\d{4})$/.exec(reference);
  if (monthYear) return reference;

  const dayMonthYear = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(reference);
  if (dayMonthYear) return `${dayMonthYear[2]}/${dayMonthYear[3]}`;

  throw new Error("ref/mes_referencia deve estar no formato MM/YYYY ou DD/MM/YYYY");
}

function buildJobId(rawId: unknown, codigoVenda: string, refOriginal: string, index: number): string {
  if (rawId !== undefined && rawId !== "") return String(rawId);
  if (codigoVenda) return `${sanitizeFilePart(codigoVenda)}_${sanitizeFilePart(refOriginal)}`;
  return String(index + 1);
}

export function toInvoiceJob(raw: RawInvoiceJob, index: number): InvoiceJob {
  const codigoVenda = raw.codigo_venda === undefined ? "" : String(raw.codigo_venda).trim();
  const identificador = normalizeDigits(requiredCell(raw.identificador ?? raw.uc, "identificador/uc"));
  const cpfCnpj = normalizeDigits(requiredCell(raw.cpf_cnpj ?? raw.cpf, "cpf_cnpj/cpf"));
  const refOriginal = requiredCell(raw.mes_referencia ?? raw.ref, "mes_referencia/ref");
  const mesReferencia = normalizeReference(refOriginal);
  const firstDigitsFromColumn = normalizeDigits(String(raw["4 primeiros"] ?? ""));
  const documentLastDigits = /^\d{4}$/.test(firstDigitsFromColumn) ? firstDigitsFromColumn : cpfCnpj.slice(0, 4);

  if (!/^\d+$/.test(identificador)) throw new Error("identificador deve conter somente numeros");
  if (!/^\d+$/.test(cpfCnpj)) throw new Error("cpf_cnpj deve conter somente numeros");
  if (!/^\d{4}$/.test(documentLastDigits)) throw new Error("4 primeiros do cpf_cnpj/cpf deve conter 4 digitos");

  return {
    id: buildJobId(raw.id, codigoVenda, refOriginal, index),
    codigoVenda,
    identificador,
    uc: raw.uc === undefined ? "" : normalizeDigits(String(raw.uc)),
    cpfCnpj,
    documentLastDigits,
    nomeTitular: raw.nome_titular === undefined ? "" : String(raw.nome_titular).trim(),
    mesReferencia,
    refOriginal,
    empresa: raw.empresa === undefined ? String(raw.concessionaria ?? "").trim() : String(raw.empresa).trim(),
    observacao: raw.observacao === undefined ? "" : String(raw.observacao).trim(),
    status: raw.status
  };
}
