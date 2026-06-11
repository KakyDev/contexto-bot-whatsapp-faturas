import fs from "node:fs";
import path from "node:path";
import type { InvoiceJob } from "../domain/invoice-job.js";
import type { InvoiceStatus } from "../domain/invoice-status.js";
import { maskDocument } from "../utils/mask-document.js";

export interface ProcessingResult {
  job: InvoiceJob;
  status: InvoiceStatus;
  arquivoPdf?: string;
  erro?: string;
  tentativas: number;
  startedAt: string;
  finishedAt: string;
}

const headers = [
  "id",
  "codigo_venda",
  "identificador",
  "uc",
  "cpf_cnpj_mascarado",
  "nome_titular",
  "mes_referencia",
  "ref",
  "status",
  "arquivo_pdf",
  "erro",
  "tentativas",
  "started_at",
  "finished_at"
];

function csvEscape(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export class ResultWriter {
  constructor(private readonly outputFile: string) {}

  ensureFile(): void {
    fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
    if (!fs.existsSync(this.outputFile)) {
      fs.writeFileSync(this.outputFile, `${headers.join(",")}\n`, "utf8");
    }
  }

  append(result: ProcessingResult): void {
    this.ensureFile();
    const { job } = result;
    const row = [
      job.id,
      job.codigoVenda,
      job.identificador,
      job.uc,
      maskDocument(job.cpfCnpj),
      job.nomeTitular,
      job.mesReferencia,
      job.refOriginal,
      result.status,
      result.arquivoPdf ?? "",
      result.erro ?? "",
      result.tentativas,
      result.startedAt,
      result.finishedAt
    ].map(csvEscape);

    fs.appendFileSync(this.outputFile, `${row.join(",")}\n`, "utf8");
  }

  readStatusesById(): Map<string, InvoiceStatus> {
    const statuses = new Map<string, InvoiceStatus>();
    if (!fs.existsSync(this.outputFile)) return statuses;
    const lines = fs.readFileSync(this.outputFile, "utf8").split(/\r?\n/).filter(Boolean);
    const [headerLine, ...rows] = lines;
    const columns = headerLine.split(",");
    const idIndex = columns.indexOf("id");
    const statusIndex = columns.indexOf("status");
    if (idIndex < 0 || statusIndex < 0) return statuses;
    for (const row of rows) {
      const cells = row.split(",");
      statuses.set(cells[idIndex], cells[statusIndex] as InvoiceStatus);
    }
    return statuses;
  }
}
