import fs from "node:fs";
import path from "node:path";
import type { InvoiceJob } from "../domain/invoice-job.js";
import type { InvoiceStatus } from "../domain/invoice-status.js";

export interface AttemptRecord {
  job: InvoiceJob;
  status: InvoiceStatus;
  arquivoPdf?: string;
  erro?: string;
  tentativas: number;
  startedAt: string;
  finishedAt: string;
}

const headers = [
  "codigo_venda",
  "uc",
  "ref",
  "status",
  "tentativas",
  "started_at",
  "finished_at",
  "arquivo_pdf",
  "erro"
];

function csvEscape(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export class AttemptRecorder {
  constructor(private readonly outputFile: string) {}

  ensureFile(): void {
    fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
    if (!fs.existsSync(this.outputFile)) {
      fs.writeFileSync(this.outputFile, `${headers.join(",")}\n`, "utf8");
    }
  }

  append(record: AttemptRecord): void {
    this.ensureFile();
    const row = [
      record.job.codigoVenda,
      record.job.uc,
      record.job.refOriginal,
      record.status,
      record.tentativas,
      record.startedAt,
      record.finishedAt,
      record.arquivoPdf ?? "",
      record.erro ?? ""
    ].map(csvEscape);

    fs.appendFileSync(this.outputFile, `${row.join(",")}\n`, "utf8");
  }
}
