import path from "node:path";
import fs from "node:fs";
import type { InvoiceJob } from "../domain/invoice-job.js";
import type { InvoiceStatus } from "../domain/invoice-status.js";
import { env, resolveProjectPath } from "../config/env.js";
import { logger } from "./logger.js";
import { assertSavedPdf, saveDownload } from "./pdf-downloader.js";
import type { ConversationClient } from "./conversation-client.js";
import { normalizeText } from "../utils/normalize.js";
import { findInvoiceOption, latestInvoiceSelectionBlock, parseInvoices } from "../utils/parse-invoices.js";
import { invoicePdfPathForJob, sanitizeFilePart, timestampForFile } from "../utils/file-name.js";
import { delay } from "../utils/delay.js";
import {
  accountConfirmationPatterns,
  consentRequestPatterns,
  conversationRecoveryPatterns,
  describeConversationIntent,
  documentDigitsInvalidPatterns,
  documentDigitsRequestPatterns,
  donePatterns,
  identifierRequestPatterns,
  invalidDataPatterns,
  invoiceListPatterns,
  invoiceServicePatterns,
  matchesAny,
  moreInvoiceQuestionPatterns,
  moreSubjectQuestionPatterns,
  paymentMethodPatterns,
  pdfReadyPatterns,
  pixQuestionPatterns,
  ratingQuestionPatterns
} from "../utils/conversation-matchers.js";

const QUICK_STATE_TIMEOUT_MS = env.BOT_STEP_TIMEOUT_MS;
const RECOVERY_PROBE_ATTEMPTS = 3;

type ConversationIntent =
  | "consent_request"
  | "identifier_request"
  | "account_confirmation"
  | "invoice_service_options"
  | "document_digits_request"
  | "document_digits_invalid"
  | "invoice_list"
  | "payment_method"
  | "pdf_ready"
  | "pix_question"
  | "more_invoice_question"
  | "more_subject_question"
  | "rating_question"
  | "done"
  | "invalid_data"
  | "unknown";

export interface ConversationResult {
  status: InvoiceStatus;
  arquivoPdf?: string;
  erro?: string;
}

class ConversationFailure extends Error {
  constructor(
    public readonly status: InvoiceStatus,
    message: string
  ) {
    super(message);
  }
}

export class CeeeConversationBot {
  constructor(private readonly client: ConversationClient) {}

  async process(job: InvoiceJob): Promise<ConversationResult> {
    try {
      logger.info({ identificador: job.identificador, state: "INIT" }, "iniciando conversa");
      await this.client.openConversationByPhone(env.WHATSAPP_CONTACT_PHONE);
      await this.client.sendMessage(env.DEFAULT_INITIAL_MESSAGE);

      const currentText = await this.waitInitialResponseAfterHello();
      const invoiceText = await this.navigateUntilInvoiceList(job, currentText);
      this.throwIfInvalidData(invoiceText);
      const invoices = parseInvoices(invoiceText);
      logger.info(
        {
          identificador: job.identificador,
          referenciaCsv: job.refOriginal,
          referenciaProcurada: job.mesReferencia,
          faturasEncontradas: invoices.map((item) => ({
            option: item.option,
            reference: item.reference,
            value: item.value,
            dueDate: item.dueDate
          }))
        },
        "faturas abertas analisadas"
      );
      const invoice = findInvoiceOption(invoiceText, job.mesReferencia);
      if (!invoice) {
        throw new ConversationFailure("not_found", `Fatura ${job.mesReferencia} nao encontrada`);
      }
      logger.info({ identificador: job.identificador, option: invoice.option, reference: invoice.reference }, "fatura selecionada");
      await this.client.sendMessage(invoice.option);

      await this.navigateUntilPdfReady(job);
      const targetPath = invoicePdfPathForJob(resolveProjectPath(env.OUTPUT_INVOICES_DIR), job);
      logger.info({ identificador: job.identificador, arquivoPdf: targetPath }, "baixando pdf");
      const download = await this.client.downloadLatestPdf(env.PDF_DOWNLOAD_TIMEOUT_MS).catch((error) => {
        throw new ConversationFailure("download_error", error instanceof Error ? error.message : String(error));
      });
      const savedPath = typeof download === "string" ? this.moveDownloadedFile(download, targetPath) : await saveDownload(download, targetPath);
      logger.info({ identificador: job.identificador, arquivoPdf: savedPath }, "pdf salvo");

      await this.finishConversation();
      return { status: "success", arquivoPdf: savedPath };
    } catch (error) {
      const status = this.statusFromError(error);
      const message = error instanceof Error ? error.message : String(error);
      await this.resetConversationAfterFailure(status).catch((resetError) => {
        logger.warn({ error: resetError, status }, "falha ao resetar conversa apos erro");
      });
      await this.saveErrorEvidence(job).catch((screenshotError) => {
        logger.warn({ error: screenshotError }, "falha ao salvar screenshot");
      });
      return { status, erro: message };
    }
  }

  private async wait(
    state: string,
    patterns: RegExp[],
    options: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
      recoverWithProbe?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<string> {
    logger.info({ state }, "aguardando estado");
    try {
      const text = await this.client.waitForMessageMatching(patterns, options.timeoutMs ?? env.BOT_STEP_TIMEOUT_MS, options);
      logger.debug({ state, text: text.slice(-1200) }, "mensagens capturadas");
      return text;
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        const recentIncomingText = await this.client.getRecentIncomingText().catch(() => "");
        if (recentIncomingText.trim() && patterns.some((pattern) => pattern.test(normalizeText(recentIncomingText)))) {
          logger.info(
            {
              state,
              intent: describeConversationIntent(recentIncomingText),
              text: recentIncomingText.slice(-1200)
            },
            "estado localizado pela ultima mensagem recebida"
          );
          return recentIncomingText;
        }

        const visibleText = await this.client.getVisibleText().catch(() => "");
        const selectedVisibleText = options.visibleTextSelector?.(visibleText) ?? visibleText;
        if (selectedVisibleText.trim() && patterns.some((pattern) => pattern.test(normalizeText(selectedVisibleText)))) {
          logger.info(
            {
              state,
              intent: describeConversationIntent(selectedVisibleText),
              text: selectedVisibleText.slice(-1200)
            },
            "estado localizado pela tela atual antes de recuperar"
          );
          return selectedVisibleText;
        }

        if (options.recoverWithProbe === false) {
          throw new ConversationFailure("timeout", `Timeout no estado ${state}`);
        }
        return this.recoverStateWithProbe(state, patterns, options);
      }
      throw error;
    }
  }

  private initialResponsePatterns(): RegExp[] {
    return [
      ...consentRequestPatterns,
      ...identifierRequestPatterns,
      ...accountConfirmationPatterns,
      ...invoiceServicePatterns,
      ...documentDigitsRequestPatterns,
      ...invoiceListPatterns,
      ...invalidDataPatterns,
      ...moreInvoiceQuestionPatterns,
      ...moreSubjectQuestionPatterns,
      ...ratingQuestionPatterns,
      ...donePatterns
    ];
  }

  private intentFromText(text: string): ConversationIntent {
    return describeConversationIntent(text) as ConversationIntent;
  }

  private allConversationStatePatterns(): RegExp[] {
    return conversationRecoveryPatterns;
  }

  private async waitForAnyKnownState(
    state: string,
    options: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<string> {
    return this.wait(state, this.allConversationStatePatterns(), {
      includeVisibleTextFallback: true,
      timeoutMs: QUICK_STATE_TIMEOUT_MS,
      ...options
    });
  }

  private async probeAndWaitKnownState(state: string): Promise<string> {
    return this.probeUntilKnownState(state, this.allConversationStatePatterns());
  }

  private async probeUntilKnownState(state: string, patterns: RegExp[]): Promise<string> {
    let lastText = "";

    for (let attempt = 1; attempt <= RECOVERY_PROBE_ATTEMPTS; attempt += 1) {
      logger.warn({ state, attempt }, "mensagem fora do fluxo conhecido; enviando ponto para localizar etapa");
      await this.client.sendMessage(".");

      const text = await this.client
        .waitForMessageMatching(patterns, env.BOT_STEP_TIMEOUT_MS, {
          includeVisibleTextFallback: true,
          requireVisibleTextChange: true
        })
        .catch(async (error) => {
          if (!(error instanceof Error) || error.message !== "timeout") throw error;
          return this.client.getRecentIncomingText().catch(() => "");
        });

      lastText = text;
      const intent = this.intentFromText(text);
      if (intent !== "unknown") {
        logger.info({ state, attempt, intent, text: text.slice(-1200) }, "estado reconhecido apos recuperacao");
        return text;
      }

      logger.warn({ state, attempt, text: text.slice(-500) }, "resposta de recuperacao ainda fora do fluxo conhecido");
    }

    throw new ConversationFailure(
      "timeout",
      `Nao foi possivel localizar etapa reconhecida em ${state}. Ultima mensagem: ${lastText.slice(-500)}`
    );
  }

  private async navigateUntilInvoiceList(job: InvoiceJob, initialText: string): Promise<string> {
    let currentText = initialText;
    const startedAt = Date.now();
    let consentAnswered = false;
    let identifierSent = false;
    let accountConfirmed = false;
    let invoiceServiceSelected = false;

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS * 4) {
      this.throwIfInvalidData(currentText);
      const intent = this.intentFromText(currentText);
      logger.info({ identificador: job.identificador, intent }, "estado da conversa identificado");

      if (intent === "consent_request") {
        if (consentAnswered) {
          currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_REPEATED_CONSENT", [
            ...identifierRequestPatterns,
            ...accountConfirmationPatterns,
            ...invoiceServicePatterns,
            ...invalidDataPatterns
          ], {
            requireVisibleTextChange: true
          });
          continue;
        }
        await this.client.sendOption(["Sim, Clara!", "Sim"], "Sim, Clara!");
        consentAnswered = true;
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_CONSENT", [
          ...identifierRequestPatterns,
          ...accountConfirmationPatterns,
          ...invoiceServicePatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "identifier_request") {
        if (identifierSent) {
          currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_REPEATED_IDENTIFIER_REQUEST", [
            ...accountConfirmationPatterns,
            ...invoiceServicePatterns,
            ...invoiceListPatterns,
            ...invalidDataPatterns
          ], {
            requireVisibleTextChange: true
          });
          continue;
        }
        await this.client.sendMessage(job.identificador);
        identifierSent = true;
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_IDENTIFIER", [
          ...accountConfirmationPatterns,
          ...invoiceServicePatterns,
          ...invoiceListPatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "account_confirmation") {
        if (accountConfirmed) {
          currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_REPEATED_ACCOUNT_CONFIRMATION", [
            ...invoiceServicePatterns,
            ...invoiceListPatterns,
            ...invalidDataPatterns
          ], {
            requireVisibleTextChange: true
          });
          continue;
        }
        this.logHolderDivergence(job, currentText);
        await this.client.sendOption(["Confirmo"], "Confirmo");
        accountConfirmed = true;
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_ACCOUNT_CONFIRMATION", [
          ...invoiceServicePatterns,
          ...invoiceListPatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "invoice_service_options") {
        if (invoiceServiceSelected) {
          currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_REPEATED_INVOICE_SERVICE", [
            ...invoiceListPatterns,
            ...documentDigitsRequestPatterns,
            ...documentDigitsInvalidPatterns,
            ...invalidDataPatterns
          ], {
            visibleTextSelector: latestInvoiceSelectionBlock,
            requireVisibleTextChange: true
          });
          continue;
        }
        await this.client.sendOption(
          ["Segunda via Fatura", "Segunda via de Fatura"],
          "Segunda via Fatura"
        );
        invoiceServiceSelected = true;
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_INVOICE_SERVICE", [
          ...invoiceListPatterns,
          ...documentDigitsRequestPatterns,
          ...documentDigitsInvalidPatterns,
          ...invalidDataPatterns
        ], {
          visibleTextSelector: latestInvoiceSelectionBlock,
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "document_digits_request" || intent === "document_digits_invalid") {
        return this.sendLastDigitsAndWaitForInvoices(job);
      }

      if (intent === "invoice_list") {
        return this.waitForInvoiceListMatchingReference(job, currentText);
      }

      if (intent === "more_invoice_question" || intent === "more_subject_question" || intent === "rating_question" || intent === "done") {
        await this.client.sendMessage(env.DEFAULT_INITIAL_MESSAGE);
        currentText = await this.waitForAnyKnownState("WAITING_STATE_AFTER_RESTART_FROM_FINISHED_CONVERSATION", {
          requireVisibleTextChange: true
        });
        continue;
      }

      currentText = await this.probeAndWaitKnownState("WAITING_RECOGNIZABLE_STATE_BEFORE_INVOICE_LIST");
    }

    throw new ConversationFailure("timeout", "Timeout ao navegar ate a lista de faturas");
  }

  private async waitInitialResponseAfterHello(): Promise<string> {
    const patterns = this.initialResponsePatterns();

    try {
      return await this.wait("WAITING_CONSENT", patterns, {
        includeVisibleTextFallback: true,
        requireVisibleTextChange: true,
        recoverWithProbe: false
      });
    } catch (error) {
      if (!(error instanceof ConversationFailure) || error.status !== "timeout") throw error;

      logger.warn({ state: "WAITING_CONSENT" }, "sem resposta inicial; encerrando conversa suja e reiniciando");
      await this.client.sendMessage("Sair");
      await delay(8000);
      await this.client.sendMessage(env.DEFAULT_INITIAL_MESSAGE);

      return this.wait("WAITING_CONSENT_AFTER_RESET", patterns, {
        includeVisibleTextFallback: true,
        requireVisibleTextChange: true,
        recoverWithProbe: false
      });
    }
  }

  private async clickConsentIfVisibleAndWaitNext(timeoutMs: number): Promise<string | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const visibleText = await this.client.getVisibleText().catch(() => "");
      if (!matchesAny(visibleText, consentRequestPatterns)) {
        await delay(1000);
        continue;
      }

      const clicked = await this.client
        .sendOption(["Sim, Clara!", "Sim"], "Sim, Clara!")
        .then(() => true)
        .catch(() => false);

      if (clicked) {
        logger.info("consentimento clicado por botao visivel");
        try {
          return await this.wait("WAITING_IDENTIFIER_REQUEST_AFTER_CONSENT_CLICK", [
            ...identifierRequestPatterns,
            ...accountConfirmationPatterns,
            ...invoiceServicePatterns,
            ...documentDigitsRequestPatterns,
            ...invoiceListPatterns,
            ...invalidDataPatterns
          ], {
            includeVisibleTextFallback: true,
            requireVisibleTextChange: true,
            recoverWithProbe: false,
            timeoutMs: QUICK_STATE_TIMEOUT_MS
          });
        } catch (error) {
          logger.warn({ error }, "nao capturou nova mensagem apos consentimento; analisando ultima mensagem recebida");
          const recentIncomingText = await this.client.getRecentIncomingText().catch(() => "");
          const recentIntent = this.intentFromText(recentIncomingText);
          if (recentIntent !== "unknown" && recentIntent !== "consent_request") return recentIncomingText;

          logger.warn({ recentIntent }, "ultima mensagem recebida nao localizou etapa; analisando tela atual");
          const visibleText = await this.client.getVisibleText().catch(() => "");
          const intent = this.intentFromText(visibleText);
          if (intent !== "unknown" && intent !== "consent_request") return visibleText;
          return undefined;
        }
      }

      await delay(1000);
    }

    return undefined;
  }

  private async waitForNextActionableState(
    state: string,
    patterns: RegExp[],
    options: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<string> {
    const startedAt = Date.now();
    let lastText = "";

    while (Date.now() - startedAt < (options.timeoutMs ?? env.BOT_STEP_TIMEOUT_MS)) {
      const text = await this.wait(state, patterns, {
        includeVisibleTextFallback: true,
        recoverWithProbe: false,
        timeoutMs: Math.min(15000, options.timeoutMs ?? env.BOT_STEP_TIMEOUT_MS),
        ...options
      }).catch(async (error) => {
        if (!(error instanceof ConversationFailure) || error.status !== "timeout") throw error;
        return this.client.getRecentIncomingText().catch(() => "");
      });

      lastText = options.visibleTextSelector?.(text) ?? text;
      if (lastText.trim() && matchesAny(lastText, patterns)) return lastText;
      if (isTransitionOnlyText(lastText)) {
        logger.info({ state, text: lastText.slice(-500) }, "mensagem intermediaria da CEEE; aguardando proxima etapa");
        await delay(2000);
        continue;
      }
    }

    throw new ConversationFailure("timeout", `Timeout no estado ${state}. Ultima mensagem: ${lastText.slice(-500)}`);
  }

  private async recoverStateWithProbe(
    state: string,
    patterns: RegExp[],
    options: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
    }
  ): Promise<string> {
    const visibleText = await this.client.getVisibleText().catch(() => "");
    const selectedVisibleText = options.visibleTextSelector?.(visibleText) ?? visibleText;
    if (selectedVisibleText.trim() && patterns.some((pattern) => pattern.test(normalizeText(selectedVisibleText)))) {
      logger.info(
        {
          state,
          intent: describeConversationIntent(selectedVisibleText),
          text: selectedVisibleText.slice(-1200)
        },
        "estado localizado na tela atual; recuperacao por ponto ignorada"
      );
      return selectedVisibleText;
    }

    const recoveryPatterns = [...patterns, ...conversationRecoveryPatterns];
    return this.probeUntilKnownState(state, recoveryPatterns);
  }

  private moveDownloadedFile(sourcePath: string, targetPath: string): string {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (sourcePath !== targetPath) {
      fs.copyFileSync(sourcePath, targetPath);
      fs.rmSync(sourcePath, { force: true });
    }
    assertSavedPdf(targetPath);
    return targetPath;
  }

  private throwIfInvalidData(text: string): void {
    if (matchesAny(text, invalidDataPatterns)) {
      throw new ConversationFailure("invalid_data", "Identificador nao localizado pelo bot da CEEE");
    }
  }

  private logHolderDivergence(job: InvoiceJob, text: string): void {
    if (!job.nomeTitular) return;
    const expected = normalizeText(job.nomeTitular);
    if (expected && !normalizeText(text).includes(expected)) {
      logger.warn({ identificador: job.identificador, nomeTitular: job.nomeTitular }, "possivel divergencia de titular");
    }
  }

  private async sendLastDigitsAndWaitForInvoices(job: InvoiceJob): Promise<string> {
    await this.client.sendMessage(job.documentLastDigits);
    const invoiceText = await this.wait("WAITING_OPEN_INVOICES_LIST", [
      ...invoiceListPatterns,
      ...invalidDataPatterns
    ], {
      includeVisibleTextFallback: true,
      visibleTextSelector: latestInvoiceSelectionBlock,
      requireVisibleTextChange: true
    });
    return this.waitForInvoiceListMatchingReference(job, invoiceText);
  }

  private async navigateUntilPdfReady(job: InvoiceJob): Promise<void> {
    let currentText = await this.waitForAnyKnownState("WAITING_STATE_AFTER_INVOICE_SELECTION");
    const startedAt = Date.now();

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS * 3) {
      this.throwIfInvalidData(currentText);
      const intent = this.intentFromText(currentText);
      logger.info({ identificador: job.identificador, intent }, "estado pos-selecao identificado");

      if (intent === "payment_method") {
        await this.client.sendMessage("2");
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_PAYMENT_METHOD", [
          ...documentDigitsRequestPatterns,
          ...documentDigitsInvalidPatterns,
          ...pdfReadyPatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "document_digits_request" || intent === "document_digits_invalid") {
        await this.sendDocumentDigitsUntilAccepted(job);
        return;
      }

      if (intent === "pdf_ready") return;

      currentText = await this.probeAndWaitKnownState("WAITING_RECOGNIZABLE_STATE_BEFORE_PDF");
    }

    throw new ConversationFailure("timeout", "Timeout ao navegar ate o PDF");
  }

  private async sendDocumentDigitsUntilAccepted(job: InvoiceJob): Promise<void> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      logger.info({ identificador: job.identificador, attempt }, "enviando digitos do documento");
      await this.client.sendMessage(job.documentLastDigits);
      const response = await this.wait("WAITING_PDF_OR_DIGITS_RETRY", [
        ...documentDigitsRequestPatterns,
        ...documentDigitsInvalidPatterns,
        ...pdfReadyPatterns
      ], {
        includeVisibleTextFallback: true,
        requireVisibleTextChange: true
      });

      if (matchesAny(response, pdfReadyPatterns)) return;
      if (matchesAny(response, [...documentDigitsInvalidPatterns, ...documentDigitsRequestPatterns])) {
        logger.warn(
          {
            identificador: job.identificador,
            attempt,
            response: response.slice(-500)
          },
          "digitos do documento recusados ou solicitados novamente"
        );
        continue;
      }
    }

    await this.client.sendMessage("Sair");
    throw new ConversationFailure("invalid_data", "Digitos do CPF/CNPJ recusados apos 3 tentativas");
  }

  private async waitForInvoiceListMatchingReference(job: InvoiceJob, initialText: string): Promise<string> {
    const startedAt = Date.now();
    let latestText = latestInvoiceSelectionBlock(initialText);
    let latestInvoices = parseInvoices(latestText);

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS) {
      if (findInvoiceOption(latestText, job.mesReferencia)) return latestText;

      const visibleText = latestInvoiceSelectionBlock(await this.client.getVisibleText());
      const visibleInvoices = parseInvoices(visibleText);
      if (visibleInvoices.length > 0) {
        latestText = visibleText;
        latestInvoices = visibleInvoices;
        if (findInvoiceOption(latestText, job.mesReferencia)) return latestText;
      }

      await delay(1000);
    }

    logger.warn(
      {
        identificador: job.identificador,
        referenciaProcurada: job.mesReferencia,
        faturasEncontradas: latestInvoices.map((item) => ({
          option: item.option,
          reference: item.reference,
          value: item.value,
          dueDate: item.dueDate
        }))
      },
      "referencia nao encontrada apos aguardar lista atual"
    );
    return latestText;
  }

  private async resetConversationAfterFailure(status: InvoiceStatus): Promise<void> {
    if (!["not_found", "invalid_data", "conversation_error", "timeout"].includes(status)) return;

    logger.info({ status }, "resetando conversa antes da proxima linha");
    await this.client.sendMessage("Sair");
    await this.waitForExitAcknowledgement().catch((error) => {
      logger.warn({ error, status }, "nao confirmou encerramento apos sair");
    });
    await delay(3000);
  }

  private async waitForExitAcknowledgement(): Promise<void> {
    await this.client.waitForMessageMatching(
      [
        /tchau/,
        /ate a proxima/,
        /espero ter te ajudado/,
        /e so me chamar/,
        /encerrar/,
        /finalizar/,
        ...donePatterns
      ],
      15000,
      {
        includeVisibleTextFallback: true,
        requireVisibleTextChange: true
      }
    );
  }

  private async finishConversation(): Promise<void> {
    await this.finishConversationWithFollowUp();
    return;

    const optionalSteps: Array<[RegExp[], string[], string, boolean?]> = [
      [[/codigo do pix|copia e cola/], ["Nao", "Não"], "Nao"],
      [[/receber alguma outra conta|deseja mais alguma fatura/], ["Nao", "Não"], "Nao"],
      [[/quer falar sobre mais alguma coisa/], ["Nao", "Não"], "Nao"],
      [[/muito bom|neutro|muito ruim/], [env.DEFAULT_RATING], env.DEFAULT_RATING, true],
      [[/que bom.*feliz.*ajudar/], [], "", true]
    ];

    optionalSteps[0][0] = pixQuestionPatterns;
    optionalSteps[1][0] = moreInvoiceQuestionPatterns;
    optionalSteps[2][0] = moreSubjectQuestionPatterns;
    optionalSteps[3][0] = ratingQuestionPatterns;
    optionalSteps[4][0] = donePatterns;

    for (const [patterns, labels, fallback, doneWhenFound] of optionalSteps) {
      const found = await this.client.waitForMessageMatching(patterns, 10000, {
        includeVisibleTextFallback: true
      }).then(() => true).catch(() => false);
      if (found) {
        if (labels.length > 0) {
          await this.client.sendOption(labels, fallback).catch(async (error) => {
            logger.warn({ error }, "opcao final opcional nao encontrada; enviando fallback textual");
            await this.client.sendMessage(fallback);
          });
        }
        if (doneWhenFound) return;
      }
    }
  }

  private async finishConversationWithFollowUp(): Promise<void> {
    const startedAt = Date.now();
    let answeredPix = false;
    let answeredMoreInvoice = false;
    let answeredMoreSubject = false;
    let answeredRating = false;

    while (Date.now() - startedAt < 90000) {
      const text = await this.client
        .waitForMessageMatching(
          [
            ...pixQuestionPatterns,
            ...moreInvoiceQuestionPatterns,
            ...moreSubjectQuestionPatterns,
            ...ratingQuestionPatterns,
            ...donePatterns
          ],
          10000,
          { includeVisibleTextFallback: true }
        )
        .catch(async () => this.client.getVisibleText().catch(() => ""));

      if (!answeredPix && matchesAny(text, pixQuestionPatterns)) {
        answeredPix = true;
        await this.answerNoAtConversationEnd("pergunta sobre pix");
        continue;
      }

      if (!answeredMoreInvoice && matchesAny(text, moreInvoiceQuestionPatterns)) {
        answeredMoreInvoice = true;
        await this.answerNoAtConversationEnd("pergunta sobre outra conta");
        continue;
      }

      if (!answeredMoreSubject && matchesAny(text, moreSubjectQuestionPatterns)) {
        answeredMoreSubject = true;
        await this.answerNoAtConversationEnd("pergunta sobre outro assunto");
        continue;
      }

      if (!answeredRating && matchesAny(text, ratingQuestionPatterns)) {
        answeredRating = true;
        logger.info({ rating: env.DEFAULT_RATING }, "respondendo avaliacao final");
        await this.client.sendMessage(env.DEFAULT_RATING);
        continue;
      }

      if (matchesAny(text, donePatterns)) return;
      if (answeredRating) return;
    }
  }

  private async answerNoAtConversationEnd(reason: string): Promise<void> {
    logger.info({ reason }, "respondendo nao no encerramento");
    await this.client.sendOption(["Nao", "NÃ£o"], "Nao").catch(async (error) => {
      logger.warn({ error, reason }, "opcao nao do encerramento nao encontrada; enviando fallback textual");
      await this.client.sendMessage("Nao");
    });
  }

  private statusFromError(error: unknown): InvoiceStatus {
    if (error instanceof ConversationFailure) return error.status;
    if (error instanceof Error && error.message === "authentication_required") return "authentication_required";
    return "conversation_error";
  }

  private async saveErrorEvidence(job: InvoiceJob): Promise<void> {
    const base = sanitizeFilePart(job.codigoVenda || job.identificador);
    const reference = sanitizeFilePart(job.refOriginal || job.mesReferencia);
    const file = `${base}_${reference}_${timestampForFile()}.png`;
    await this.client.screenshot(path.join(resolveProjectPath(env.OUTPUT_ERROR_SCREENSHOTS_DIR), file));
  }
}

function isTransitionOnlyText(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /tudo bem.*continuar preciso te identificar/.test(normalized) ||
    /so um momento/.test(normalized) ||
    /consulto o nosso sistema/.test(normalized) ||
    /gero seu protocolo/.test(normalized) ||
    /vamos continuar nossa conversa/.test(normalized)
  );
}
