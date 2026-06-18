import path from "node:path";
import { normalizeDigits } from "./normalize.js";
import type { InvoiceJob } from "../domain/invoice-job.js";

export function referenceToYearMonth(reference: string): string {
  const match = /^(\d{2})\/(\d{4})$/.exec(reference.trim());
  if (!match) throw new Error("referencia invalida");
  return `${match[2]}-${match[1]}`;
}

export function invoicePdfFileName(identifier: string, reference: string): string {
  return `${normalizeDigits(identifier)}_${referenceToYearMonth(reference)}.pdf`;
}

export function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "-");
}

export function invoicePdfFileNameForJob(job: InvoiceJob): string {
  const base = sanitizeFilePart(job.codigoVenda || job.identificador);
  const reference = sanitizeFilePart(job.mesReferencia || job.refOriginal);
  return `${base}_${reference}.pdf`;
}

export function invoicePdfPathForJob(outputDir: string, job: InvoiceJob): string {
  return path.join(outputDir, invoicePdfFileNameForJob(job));
}

export function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
