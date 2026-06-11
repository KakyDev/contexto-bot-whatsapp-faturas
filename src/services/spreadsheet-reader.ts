import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { rawInvoiceJobSchema, toInvoiceJob, type InvoiceJob } from "../domain/invoice-job.js";

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function readCsvRows(filePath: string): Record<string, unknown>[] {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  const headerLine = lines[0];
  if (!headerLine) return [];

  const delimiter = headerLine.includes(";") ? ";" : ",";
  const headers = parseDelimitedLine(headerLine, delimiter);

  return lines.slice(1).map((line) => {
    const cells = parseDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

export function readSpreadsheet(filePath: string): InvoiceJob[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo de entrada nao encontrado: ${filePath}`);
  }

  const extension = path.extname(filePath).toLowerCase();
  const rows =
    extension === ".csv"
      ? readCsvRows(filePath)
      : (() => {
          const workbook = XLSX.readFile(filePath, { cellDates: false });
          const sheetName = workbook.SheetNames[0];
          if (!sheetName) throw new Error("Planilha sem abas");
          return XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
            defval: "",
            raw: false
          });
        })();

  return rows.map((row, index) => {
    const parsed = rawInvoiceJobSchema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Linha ${index + 2}: ${issue?.path.join(".") || "dados"} invalido`);
    }
    try {
      return toInvoiceJob(parsed.data, index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Linha ${index + 2}: ${message}`);
    }
  });
}
