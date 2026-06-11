import fs from "node:fs";
import path from "node:path";
import type { Download } from "playwright";

export async function saveDownload(download: Download, targetPath: string): Promise<string> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await download.saveAs(targetPath);
  assertSavedPdf(targetPath);
  return targetPath;
}

export function assertSavedPdf(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`PDF nao foi salvo no destino: ${targetPath}`);
  }

  const stats = fs.statSync(targetPath);
  if (stats.size === 0) {
    throw new Error(`PDF salvo vazio no destino: ${targetPath}`);
  }
}
