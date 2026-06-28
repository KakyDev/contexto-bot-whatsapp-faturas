import fs from "node:fs";
import { env, resolveProjectPath } from "./config/env.js";
import { getBotRuntimeConfig, type BotRuntimeConfig } from "./config/bots.js";
import { parseCliArgs } from "./cli.js";
import { readSpreadsheet } from "./services/spreadsheet-reader.js";
import { ResultWriter } from "./services/result-writer.js";
import { AttemptRecorder } from "./services/attempt-recorder.js";
import { WhatsAppClient } from "./services/whatsapp-client.js";
import { WhatsAppTerminalClient } from "./services/whatsapp-terminal-client.js";
import { EvolutionApiClient } from "./services/evolution-api-client.js";
import { CeeeConversationBot, type ConversationJobResult } from "./services/ceee-conversation-bot.js";
import { MaranhaoConversationBot } from "./services/maranhao-conversation-bot.js";
import { logger } from "./services/logger.js";
import { groupInvoiceJobs, type InvoiceJob, type InvoiceJobGroup } from "./domain/invoice-job.js";
import type { InvoiceStatus } from "./domain/invoice-status.js";
import type { ConversationClient } from "./services/conversation-client.js";
import type { BotId } from "./domain/bot.js";

function ensureOutputDirs(botConfig: BotRuntimeConfig): void {
  for (const dir of [botConfig.outputInvoicesDir, botConfig.outputErrorScreenshotsDir]) {
    fs.mkdirSync(resolveProjectPath(dir), { recursive: true });
  }
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function assertBotChatIsolation(botConfig: BotRuntimeConfig): void {
  const otherBot = botConfig.id === "ceee" ? "maranhao" : "ceee";
  const otherConfig = getBotRuntimeConfig(otherBot);
  const selectedPhone = digitsOnly(botConfig.whatsappContactPhone);
  const otherPhone = digitsOnly(otherConfig.whatsappContactPhone);

  if (!selectedPhone) {
    throw new Error(`Telefone obrigatorio para ${botConfig.name}; envio bloqueado.`);
  }
  if (otherPhone && selectedPhone === otherPhone) {
    throw new Error(
      `CEEE e Maranhao estao configurados com o mesmo telefone (${selectedPhone}). Corrija os contatos; envio bloqueado para impedir mistura de chats.`
    );
  }
}

function filterJobsForRetry(jobs: InvoiceJob[], writer: ResultWriter, retryErrors: boolean): InvoiceJob[] {
  const statuses = writer.readStatusesById();
  const completedStatuses = new Set<InvoiceStatus>(["success", "not_found"]);
  const remaining = jobs.filter((job) => {
    const status = statuses.get(job.id);
    if (!status) return true;
    return retryErrors && !completedStatuses.has(status);
  });
  logger.info(
    { total: jobs.length, skipped: jobs.length - remaining.length, remaining: remaining.length, retryErrors },
    "filtrando jobs: removendo linhas ja processadas em resultados.csv"
  );
  return remaining;
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

function shouldRetryGroup(results: ConversationJobResult[], attempts: number): boolean {
  return attempts < env.MAX_RETRIES && results.some((result) => result.status === "conversation_error");
}

function groupWithRetryableJobs(group: InvoiceJobGroup, results: ConversationJobResult[]): InvoiceJobGroup {
  const retryableIds = new Set(results.filter((result) => result.status === "conversation_error").map((result) => result.job.id));
  const jobs = group.jobs.filter((job) => retryableIds.has(job.id));
  return groupInvoiceJobs(jobs)[0] ?? { ...group, jobs: [], mesesDesejados: [], mesesBaixados: [], mesesPendentes: [] };
}

function appendProcessingResult(
  writer: ResultWriter,
  attemptRecorder: AttemptRecorder,
  result: ConversationJobResult,
  tentativas: number,
  startedAt: string,
  finishedAt: string,
  erro: string
): void {
  writer.append({
    job: result.job,
    status: result.status,
    arquivoPdf: result.arquivoPdf ?? "",
    erro,
    tentativas,
    startedAt,
    finishedAt
  });
  attemptRecorder.append({
    job: result.job,
    status: result.status,
    arquivoPdf: result.arquivoPdf ?? "",
    erro,
    tentativas,
    startedAt,
    finishedAt
  });
}

function createClient(options: ReturnType<typeof parseCliArgs>, botConfig: BotRuntimeConfig): ConversationClient {
  if (options.transport === "browser") {
    return new WhatsAppClient(env.BOT_ACTION_DELAY_MS, {
      browserProfileDir: botConfig.browserProfileDir,
      outputInvoicesDir: botConfig.outputInvoicesDir
    });
  }

  if (options.transport === "evolution") {
    return new EvolutionApiClient(env.BOT_ACTION_DELAY_MS, {
      outputInvoicesDir: botConfig.outputInvoicesDir
    });
  }

  return new WhatsAppTerminalClient(env.BOT_ACTION_DELAY_MS, {
    terminalAuthDir: botConfig.terminalAuthDir,
    outputInvoicesDir: botConfig.outputInvoicesDir
  });
}

function createBot(bot: BotId, client: ConversationClient, botConfig: BotRuntimeConfig): CeeeConversationBot {
  const conversationConfig = {
    whatsappContactPhone: botConfig.whatsappContactPhone,
    expectedChatName: botConfig.expectedChatName,
    outputInvoicesDir: botConfig.outputInvoicesDir,
    outputErrorScreenshotsDir: botConfig.outputErrorScreenshotsDir,
    defaultInitialMessage: botConfig.defaultInitialMessage,
    defaultRating: botConfig.defaultRating
  };

  if (bot === "maranhao") {
    if (!botConfig.whatsappContactPhone.trim()) {
      throw new Error("MARANHAO_WHATSAPP_CONTACT_PHONE obrigatorio para o Bot Maranhao. Configure esse telefone no .env para evitar envio ao contato generico.");
    }
    return new MaranhaoConversationBot(client, conversationConfig);
  }
  return new CeeeConversationBot(client, conversationConfig);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const botConfig = getBotRuntimeConfig(options.bot ?? env.BOT);
  assertBotChatIsolation(botConfig);
  if (options.sendTest !== undefined) {
    const client = createClient(options, botConfig);
    try {
      await client.open();
      await client.assertAuthenticated();
      await client.openConversationByPhone(botConfig.whatsappContactPhone, botConfig.expectedChatName);
      await client.sendMessage(options.sendTest.trim() ? options.sendTest : botConfig.defaultInitialMessage);
      logger.info(
        {
          bot: botConfig.id,
          transport: options.transport,
          expectedChatName: botConfig.expectedChatName,
          whatsappContactPhone: botConfig.whatsappContactPhone
        },
        "mensagem de teste enviada"
      );
      console.log("Mensagem de teste enviada.");
    } finally {
      await client.close();
    }
    return;
  }

  const inputFile = resolveProjectPath(options.input ?? botConfig.inputFile);
  const writer = new ResultWriter(resolveProjectPath(botConfig.outputResultsFile));
  const attemptRecorder = new AttemptRecorder(resolveProjectPath(botConfig.outputAttemptsFile));
  ensureOutputDirs(botConfig);

  const jobs = filterJobsForRetry(readSpreadsheet(inputFile, { bot: botConfig.id }), writer, options.retryErrors);
  const groups = groupInvoiceJobs(jobs);
  logger.info(
    {
      bot: botConfig.id,
      inputFile,
      outputResultsFile: botConfig.outputResultsFile,
      outputAttemptsFile: botConfig.outputAttemptsFile,
      outputInvoicesDir: botConfig.outputInvoicesDir,
      total: jobs.length,
      grupos: groups.length,
      dryRun: options.dryRun,
      retryErrors: options.retryErrors
    },
    "jobs carregados"
  );

  if (options.dryRun) {
    for (const group of groups) {
      logger.info(
        {
          codigoVenda: group.codigoVenda,
          uc: group.uc,
          identificador: group.identificador,
          mesesDesejados: group.mesesDesejados,
          linhas: group.jobs.map((job) => job.id)
        },
        "grupo valido"
      );
    }
    summarize(jobs.map(() => "success"));
    return;
  }

  const client = createClient(options, botConfig);
  const bot = createBot(botConfig.id, client, botConfig);
  const statuses: InvoiceStatus[] = [];

  try {
    await client.open();
    await client.assertAuthenticated();

    for (const group of groups) {
      const startedAt = new Date().toISOString();
      let tentativas = 0;
      let currentGroup = group;
      const finalResultsById = new Map<string, ConversationJobResult>();
      let latestResults: ConversationJobResult[] = group.jobs.map((job) => ({
        job,
        status: "conversation_error",
        erro: "Job nao executado"
      }));
      const erros: string[] = [];

      while (tentativas < env.MAX_RETRIES && currentGroup.jobs.length > 0) {
        tentativas += 1;
        logger.info(
          {
            grupo: currentGroup.id,
            codigoVenda: currentGroup.codigoVenda,
            uc: currentGroup.uc,
            mesesDesejados: currentGroup.mesesDesejados,
            tentativa: tentativas
          },
          "iniciando tentativa agrupada"
        );
        latestResults = (await bot.processGroup(currentGroup)).results;
        for (const result of latestResults) {
          finalResultsById.set(result.job.id, result);
          if (result.erro) erros.push(`${result.job.id} tentativa ${tentativas}: ${result.erro}`);
        }
        logger.info(
          {
            grupo: currentGroup.id,
            tentativa: tentativas,
            resultados: latestResults.map((result) => ({
              id: result.job.id,
              mesReferencia: result.job.mesReferencia,
              status: result.status,
              arquivoPdf: result.arquivoPdf,
              erro: result.erro
            }))
          },
          "tentativa agrupada concluida"
        );
        if (!shouldRetryGroup(latestResults, tentativas)) break;
        currentGroup = groupWithRetryableJobs(currentGroup, latestResults);
      }

      const finishedAt = new Date().toISOString();
      const finalResults = group.jobs.map(
        (job) =>
          finalResultsById.get(job.id) ?? {
            job,
            status: "conversation_error" as InvoiceStatus,
            erro: "Job nao executado"
          }
      );
      for (const result of finalResults) {
        statuses.push(result.status);
        const erro = erros.filter((item) => item.startsWith(`${result.job.id} `)).join(" | ");
        appendProcessingResult(writer, attemptRecorder, result, tentativas, startedAt, finishedAt, erro);
      }

      if (finalResults.some((result) => result.status === "authentication_required")) break;
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
