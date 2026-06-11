import fs from "node:fs";
import { env, resolveProjectPath } from "./config/env.js";
import { parseCliArgs } from "./cli.js";
import { readSpreadsheet } from "./services/spreadsheet-reader.js";
import { ResultWriter } from "./services/result-writer.js";
import { WhatsAppClient } from "./services/whatsapp-client.js";
import { WhatsAppTerminalClient } from "./services/whatsapp-terminal-client.js";
import { EvolutionApiClient } from "./services/evolution-api-client.js";
import { CeeeConversationBot } from "./services/ceee-conversation-bot.js";
import { logger } from "./services/logger.js";
import type { InvoiceJob } from "./domain/invoice-job.js";
import type { InvoiceStatus } from "./domain/invoice-status.js";

const errorStatuses = new Set<InvoiceStatus>([
  "not_found",
  "invalid_data",
  "authentication_required",
  "conversation_error",
  "download_error",
  "timeout"
]);

function ensureOutputDirs(): void {
  for (const dir of [env.OUTPUT_INVOICES_DIR, env.OUTPUT_ERROR_SCREENSHOTS_DIR]) {
    fs.mkdirSync(resolveProjectPath(dir), { recursive: true });
  }
}

function filterJobsForRetry(jobs: InvoiceJob[], writer: ResultWriter, retryErrors: boolean): InvoiceJob[] {
  if (!retryErrors) return jobs;
  const statuses = writer.readStatusesById();
  return jobs.filter((job) => errorStatuses.has(statuses.get(job.id) as InvoiceStatus));
}

function summarize(statuses: InvoiceStatus[]): void {
  const total = statuses.length;
  const success = statuses.filter((status) => status === "success").length;
  const notFound = statuses.filter((status) => status === "not_found").length;
  const errors = statuses.filter((status) => status !== "success" && status !== "not_found").length;
  logger.info({ total, success, notFound, errors }, "resumo");
  console.log(`Total: ${total}`);
  console.log(`Sucesso: ${success}`);
  console.log(`Nao encontradas: ${notFound}`);
  console.log(`Erros: ${errors}`);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const inputFile = resolveProjectPath(options.input ?? env.INPUT_FILE);
  const writer = new ResultWriter(resolveProjectPath(env.OUTPUT_RESULTS_FILE));
  ensureOutputDirs();

  const jobs = filterJobsForRetry(readSpreadsheet(inputFile), writer, options.retryErrors);
  logger.info({ total: jobs.length, dryRun: options.dryRun, retryErrors: options.retryErrors }, "jobs carregados");

  if (options.dryRun) {
    for (const job of jobs) {
      logger.info({ id: job.id, identificador: job.identificador, mesReferencia: job.mesReferencia }, "linha valida");
    }
    summarize(jobs.map(() => "success"));
    return;
  }

  const client =
    options.transport === "browser"
      ? new WhatsAppClient(env.BOT_ACTION_DELAY_MS)
      : options.transport === "evolution"
        ? new EvolutionApiClient(env.BOT_ACTION_DELAY_MS)
        : new WhatsAppTerminalClient(env.BOT_ACTION_DELAY_MS);
  const bot = new CeeeConversationBot(client);
  const statuses: InvoiceStatus[] = [];

  try {
    await client.open();
    await client.assertAuthenticated();

    for (const job of jobs) {
      const startedAt = new Date().toISOString();
      let tentativas = 0;
      let finalStatus: InvoiceStatus = "conversation_error";
      let arquivoPdf = "";
      const erros: string[] = [];

      while (tentativas < env.MAX_RETRIES && finalStatus !== "success") {
        tentativas += 1;
        logger.info({ id: job.id, tentativa: tentativas }, "iniciando tentativa");
        const result = await bot.process(job);
        finalStatus = result.status;
        arquivoPdf = result.arquivoPdf ?? "";
        if (result.erro) erros.push(`tentativa ${tentativas}: ${result.erro}`);
        logger.info({ id: job.id, tentativa: tentativas, status: finalStatus, erro: result.erro }, "tentativa concluida");
        if (["not_found", "invalid_data", "authentication_required", "download_error", "timeout"].includes(finalStatus)) break;
      }

      statuses.push(finalStatus);
      writer.append({
        job,
        status: finalStatus,
        arquivoPdf,
        erro: erros.join(" | "),
        tentativas,
        startedAt,
        finishedAt: new Date().toISOString()
      });

      if (finalStatus === "authentication_required") break;
    }
  } finally {
    await client.close();
  }

  summarize(statuses);
}

main().catch((error) => {
  logger.error(
    {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error
    },
    "falha fatal"
  );
  process.exitCode = 1;
});
