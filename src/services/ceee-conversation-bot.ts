import path from "node:path";
import fs from "node:fs";
import type { InvoiceJob, InvoiceJobGroup } from "../domain/invoice-job.js";
import type { InvoiceStatus } from "../domain/invoice-status.js";
import { env, resolveProjectPath } from "../config/env.js";
import { logger } from "./logger.js";
import { assertSavedPdf, saveDownload } from "./pdf-downloader.js";
import type { ConversationClient } from "./conversation-client.js";
import { normalizeText } from "../utils/normalize.js";
import { maskDocument } from "../utils/mask-document.js";
import { findInvoiceOption, latestInvoiceSelectionBlock, parseInvoices, type ParsedInvoice } from "../utils/parse-invoices.js";
import { invoicePdfPathForJob, sanitizeFilePart, timestampForFile } from "../utils/file-name.js";
import { delay } from "../utils/delay.js";
import {
  accountConfirmationPatterns,
  birthDateRequestPatterns,
  consentRequestPatterns,
  conversationRecoveryPatterns,
  describeConversationIntent,
  documentDigitsInvalidPatterns,
  documentDigitsRequestPatterns,
  donePatterns,
  finalGoodbyePatterns,
  identifierRejectedPatterns,
  identifierRequestPatterns,
  invalidDataPatterns,
  invoiceListPatterns,
  invoiceServicePatterns,
  isPedindoDataDeNascimento,
  isPedindoRg,
  isPedindoUltimos,
  matchesAny,
  moreInvoiceQuestionPatterns,
  moreSubjectQuestionPatterns,
  noOpenDebtsPatterns,
  paymentMethodPatterns,
  pdfReadyPatterns,
  pixQuestionPatterns,
  ratingQuestionPatterns,
  rgDigitsRequestPatterns,
  suspendedSupplyQuestionPatterns,
  unsupportedSubjectPatterns
} from "../utils/conversation-matchers.js";

const QUICK_STATE_TIMEOUT_MS = env.BOT_STEP_TIMEOUT_MS;
const RECOVERY_PROBE_ATTEMPTS = 3;
const UNSUPPORTED_SUBJECT_PROBE_TIMEOUT_MS = Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000);

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
  | "no_open_debts"
  | "suspended_supply_question"
  | "unsupported_subject"
  | "unknown";

export interface ConversationResult {
  status: InvoiceStatus;
  arquivoPdf?: string;
  erro?: string;
}

export interface ConversationJobResult extends ConversationResult {
  job: InvoiceJob;
}

export interface ConversationGroupResult {
  results: ConversationJobResult[];
}

class ConversationFailure extends Error {
  constructor(
    public readonly status: InvoiceStatus,
    message: string,
    public readonly conversationClosed = false
  ) {
    super(message);
  }
}

export class CeeeConversationBot {
  constructor(private readonly client: ConversationClient) {}

  async process(job: InvoiceJob): Promise<ConversationResult> {
    const group = this.groupFromSingleJob(job);
    const result = await this.processGroup(group);
    const [firstResult] = result.results;
    return firstResult ?? { status: "conversation_error", erro: "Nenhum resultado retornado" };
  }

  async processGroup(group: InvoiceJobGroup): Promise<ConversationGroupResult> {
    const representativeJob = group.jobs[0];
    if (!representativeJob) return { results: [] };

    const results = new Map<string, ConversationResult>();
    const pendingReferences = new Set(group.mesesDesejados);
    const downloadedReferences = new Set<string>();
    let lastDownloadedJob = representativeJob;

    try {
      logger.info(
        {
          identificador: representativeJob.identificador,
          codigoVenda: group.codigoVenda,
          uc: group.uc,
          mesesDesejados: group.mesesDesejados,
          state: "INIT"
        },
        "iniciando conversa agrupada"
      );
      await this.client.openConversationByPhone(env.WHATSAPP_CONTACT_PHONE);
      await this.client.sendMessage(env.DEFAULT_INITIAL_MESSAGE);

      const currentText = await this.waitInitialResponseAfterHello();
      let invoiceText = await this.navigateUntilInvoiceList(representativeJob, currentText, [...pendingReferences]);

      while (pendingReferences.size > 0) {
        this.throwIfInvalidData(invoiceText);
        const selected = this.selectPendingInvoice(group, invoiceText, pendingReferences);

        if (!selected) {
          this.markPendingReferencesAsNotFound(group, pendingReferences, results, "mes desejado nao localizado na lista atual");
          await this.exitInvoiceSelectionWithoutDownload(group, [...pendingReferences]);
          pendingReferences.clear();
          break;
        }

        const { invoice, job } = selected;
        lastDownloadedJob = job;
        logger.info(
          {
            identificador: job.identificador,
            codigoVenda: group.codigoVenda,
            uc: group.uc,
            option: invoice.option,
            reference: invoice.reference,
            mesesPendentes: [...pendingReferences]
          },
          "fatura selecionada no atendimento agrupado"
        );
        await this.client.sendMessage(invoice.option);

        await this.navigateUntilPdfReady(job);
        const targetPath = invoicePdfPathForJob(resolveProjectPath(env.OUTPUT_INVOICES_DIR), job);
        logger.info({ identificador: job.identificador, mesReferencia: job.mesReferencia, arquivoPdf: targetPath }, "baixando pdf");
        const download = await this.client.downloadLatestPdf(env.PDF_DOWNLOAD_TIMEOUT_MS).catch((error) => {
          throw new ConversationFailure("download_error", error instanceof Error ? error.message : String(error));
        });
        const savedPath = typeof download === "string" ? this.moveDownloadedFile(download, targetPath) : await saveDownload(download, targetPath);
        logger.info({ identificador: job.identificador, mesReferencia: job.mesReferencia, arquivoPdf: savedPath }, "pdf salvo");

        downloadedReferences.add(invoice.reference);
        pendingReferences.delete(invoice.reference);
        group.mesesBaixados = [...downloadedReferences];
        group.mesesPendentes = [...pendingReferences];
        this.markReferenceResult(group, invoice.reference, results, { status: "success", arquivoPdf: savedPath });

        const nextInvoiceText = await this.finishConversationWithGroupedFollowUp(group, [...pendingReferences]);
        if (!nextInvoiceText) break;
        invoiceText = this.handleGroupedFollowUpText(group, nextInvoiceText, pendingReferences, results);
      }

      if (pendingReferences.size > 0) {
        this.markPendingReferencesAsNotFound(group, pendingReferences, results, "sem nova lista para meses pendentes");
      }

      await this.finishConversationWithFollowUp();
      return { results: this.resultsForGroup(group, results) };
    } catch (error) {
      const status = this.statusFromError(error);
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof ConversationFailure && error.conversationClosed)) {
        await this.resetConversationAfterFailure(status).catch((resetError) => {
          logger.warn({ error: resetError, status }, "falha ao resetar conversa apos erro");
        });
      }
      await this.saveErrorEvidence(lastDownloadedJob).catch((screenshotError) => {
        logger.warn({ error: screenshotError }, "falha ao salvar screenshot");
      });
      for (const job of group.jobs) {
        if (!results.has(job.id)) results.set(job.id, { status, erro: message });
      }
      return { results: this.resultsForGroup(group, results) };
    }
  }

  private groupFromSingleJob(job: InvoiceJob): InvoiceJobGroup {
    return {
      id: job.id,
      codigoVenda: job.codigoVenda,
      uc: job.uc || job.identificador,
      identificador: job.identificador,
      documento: job.cpfCnpj,
      jobs: [job],
      mesesDesejados: [job.mesReferencia],
      mesesBaixados: [],
      mesesPendentes: [job.mesReferencia]
    };
  }

  private selectPendingInvoice(
    group: InvoiceJobGroup,
    invoiceText: string,
    pendingReferences: Set<string>
  ): { invoice: ParsedInvoice; job: InvoiceJob } | undefined {
    const latestText = latestInvoiceSelectionBlock(invoiceText);
    const invoices = parseInvoices(latestText);
    const foundReferences = invoices.map((item) => item.reference);
    const foundDesiredReferences = foundReferences.filter((reference) => group.mesesDesejados.includes(reference));
    const missingReferences = [...pendingReferences].filter((reference) => !foundReferences.includes(reference));

    logger.info(
      {
        codigoVenda: group.codigoVenda,
        uc: group.uc,
        mesesDesejados: group.mesesDesejados,
        mesesBaixados: group.mesesBaixados,
        mesesPendentes: [...pendingReferences],
        mesesEncontrados: foundDesiredReferences,
        mesesNaoLocalizadosNaLista: missingReferences,
        faturasEncontradas: invoices.map((item) => ({
          option: item.option,
          reference: item.reference,
          value: item.value,
          dueDate: item.dueDate
        }))
      },
      "comparando faturas exibidas com meses desejados"
    );

    for (const reference of group.mesesDesejados) {
      if (!pendingReferences.has(reference)) continue;
      const invoice = findInvoiceOption(latestText, reference);
      if (!invoice) continue;
      const job = group.jobs.find((item) => item.mesReferencia === reference);
      if (!job) continue;
      return { invoice, job };
    }

    return undefined;
  }

  private markReferenceResult(
    group: InvoiceJobGroup,
    reference: string,
    results: Map<string, ConversationResult>,
    result: ConversationResult
  ): void {
    for (const job of group.jobs) {
      if (job.mesReferencia !== reference) continue;
      if (results.has(job.id)) continue;
      results.set(job.id, result);
      logger.info(
        {
          id: job.id,
          codigoVenda: job.codigoVenda,
          uc: job.uc || job.identificador,
          mesReferencia: reference,
          status: result.status,
          arquivoPdf: result.arquivoPdf,
          erro: result.erro
        },
        "resultado do mes registrado"
      );
    }
  }

  private markPendingReferencesAsNotFound(
    group: InvoiceJobGroup,
    pendingReferences: Set<string>,
    results: Map<string, ConversationResult>,
    reason: string
  ): void {
    for (const reference of pendingReferences) {
      logger.warn(
        {
          codigoVenda: group.codigoVenda,
          uc: group.uc,
          mesReferencia: reference,
          reason
        },
        "mes desejado pendente nao localizado"
      );
      this.markReferenceResult(group, reference, results, {
        status: "not_found",
        erro: `Fatura ${reference} nao encontrada (${reason})`
      });
    }
    group.mesesPendentes = [...pendingReferences];
  }

  private resultsForGroup(group: InvoiceJobGroup, results: Map<string, ConversationResult>): ConversationJobResult[] {
    return group.jobs.map((job) => ({
      job,
      ...(results.get(job.id) ?? { status: "conversation_error", erro: "Resultado nao registrado" })
    }));
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
      ...noOpenDebtsPatterns,
      ...suspendedSupplyQuestionPatterns,
      ...unsupportedSubjectPatterns,
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
      if (intent === "unsupported_subject") {
        return this.recoverFromUnsupportedSubject(state, text, true);
      }

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

  private async navigateUntilInvoiceList(job: InvoiceJob, initialText: string, targetReferences = [job.mesReferencia]): Promise<string> {
    let currentText = initialText;
    const startedAt = Date.now();
    let consentAnswered = false;
    let identifierSent = false;
    let cpfIdentifierSent = false;
    let accountConfirmed = false;
    let invoiceServiceSelected = false;

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS * 4) {
      this.throwIfInvalidData(currentText);
      if (matchesAny(currentText, noOpenDebtsPatterns)) {
        await this.handleNoOpenDebts(job, currentText);
      }

      const intent = this.intentFromText(currentText);
      logger.info({ identificador: job.identificador, intent }, "estado da conversa identificado");

      if (intent === "suspended_supply_question") {
        await this.answerOtherSubjectForSuspendedSupply(job);
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_SUSPENDED_SUPPLY_OTHER_SUBJECT", [
          ...invoiceServicePatterns,
          ...moreSubjectQuestionPatterns,
          ...ratingQuestionPatterns,
          ...donePatterns,
          ...finalGoodbyePatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "unsupported_subject") {
        currentText = await this.recoverFromUnsupportedSubject("UNSUPPORTED_SUBJECT_BEFORE_INVOICE_LIST", currentText);
        continue;
      }

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
        if (identifierSent && !cpfIdentifierSent && matchesAny(currentText, identifierRejectedPatterns)) {
          logger.info(
            {
              identificador: job.identificador,
              cpfCnpjMascarado: maskDocument(job.cpfCnpj)
            },
            "UC nao reconhecida; tentando CPF/CNPJ como identificador"
          );
          await this.client.sendMessage(job.cpfCnpj);
          cpfIdentifierSent = true;
          currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_CPF_IDENTIFIER", [
            ...accountConfirmationPatterns,
            ...invoiceServicePatterns,
            ...invoiceListPatterns,
            ...identifierRequestPatterns,
            ...identifierRejectedPatterns,
            ...noOpenDebtsPatterns,
            ...suspendedSupplyQuestionPatterns,
            ...invalidDataPatterns
          ], {
            requireVisibleTextChange: true
          });
          continue;
        }

        if (identifierSent && cpfIdentifierSent && matchesAny(currentText, identifierRejectedPatterns)) {
          logger.warn(
            {
              identificador: job.identificador,
              cpfCnpjMascarado: maskDocument(job.cpfCnpj),
              tentativasIdentificacao: ["UC", "CPF/CNPJ"]
            },
            "UC e CPF/CNPJ nao reconhecidos; encerrando atendimento e seguindo para proxima linha"
          );
          throw new ConversationFailure(
            "invalid_data",
            "UC e CPF/CNPJ nao localizados pelo bot da CEEE; tentativas realizadas e atendimento encerrado"
          );
        }

        if (identifierSent) {
          currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_REPEATED_IDENTIFIER_REQUEST", [
            ...accountConfirmationPatterns,
            ...invoiceServicePatterns,
            ...invoiceListPatterns,
            ...identifierRequestPatterns,
            ...identifierRejectedPatterns,
            ...noOpenDebtsPatterns,
            ...suspendedSupplyQuestionPatterns,
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
          ...identifierRequestPatterns,
          ...identifierRejectedPatterns,
          ...suspendedSupplyQuestionPatterns,
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
            ...noOpenDebtsPatterns,
            ...suspendedSupplyQuestionPatterns,
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
            ...noOpenDebtsPatterns,
            ...suspendedSupplyQuestionPatterns,
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
            ...noOpenDebtsPatterns,
            ...moreSubjectQuestionPatterns,
            ...ratingQuestionPatterns,
            ...donePatterns,
            ...finalGoodbyePatterns,
            ...invalidDataPatterns
          ], {
            visibleTextSelector: latestInvoiceSelectionBlock,
            requireVisibleTextChange: true
          });
          continue;
        }
        if (isGeneralServicesMenu(currentText)) {
          await this.client.sendMessage("Segunda via de Fatura");
        } else {
          await this.client.sendOption(
            ["Segunda via Fatura", "Segunda via de Fatura"],
            "Segunda via de Fatura"
          );
        }
        invoiceServiceSelected = true;
        currentText = await this.waitForNextActionableState("WAITING_STATE_AFTER_INVOICE_SERVICE", [
          ...invoiceListPatterns,
          ...documentDigitsRequestPatterns,
          ...documentDigitsInvalidPatterns,
          ...noOpenDebtsPatterns,
          ...moreSubjectQuestionPatterns,
          ...ratingQuestionPatterns,
          ...donePatterns,
          ...finalGoodbyePatterns,
          ...invalidDataPatterns
        ], {
          visibleTextSelector: latestInvoiceSelectionBlock,
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "document_digits_request" || intent === "document_digits_invalid") {
        return this.sendLastDigitsAndWaitForInvoices(job, targetReferences);
      }

      if (intent === "invoice_list") {
        return this.waitForInvoiceListMatchingReferences(job, currentText, targetReferences);
      }

      if (
        invoiceServiceSelected &&
        (intent === "more_subject_question" || intent === "rating_question" || intent === "done")
      ) {
        await this.finishUnavailableInvoiceConversation(job, currentText);
      }

      if (intent === "more_subject_question") {
        logger.info(
          { identificador: job.identificador },
          "pergunta de outro assunto encontrada antes da lista; respondendo nao antes de reiniciar"
        );
        await this.answerNoAtConversationEnd("pergunta sobre outro assunto antes de reiniciar atendimento");
        await this.finishConversationWithFollowUp({ answeredMoreSubject: true });
        await this.client.sendMessage(env.DEFAULT_INITIAL_MESSAGE);
        currentText = await this.waitForAnyKnownState("WAITING_STATE_AFTER_RESTART_FROM_MORE_SUBJECT_ANSWERED_NO", {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (intent === "more_invoice_question" || intent === "rating_question" || intent === "done") {
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
      if (lastText.trim() && matchesAny(lastText, moreSubjectQuestionPatterns)) return lastText;
      if (matchesAny(lastText, unsupportedSubjectPatterns)) {
        return this.recoverFromUnsupportedSubject(state, lastText);
      }

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

  private async handleNoOpenDebts(job: InvoiceJob, text: string): Promise<never> {
    logger.info(
      {
        identificador: job.identificador,
        referenciaProcurada: job.mesReferencia,
        text: text.slice(-500)
      },
      "CEEE informou que nao ha debitos faturados em aberto"
    );
    return this.finishUnavailableInvoiceConversation(job, text);
  }

  private async finishUnavailableInvoiceConversation(job: InvoiceJob, text: string): Promise<never> {
    const askedMoreSubject = matchesAny(text, moreSubjectQuestionPatterns);
    if (askedMoreSubject) {
      await this.answerNoAtConversationEnd("pergunta sobre outro assunto sem fatura disponivel");
    }

    await this.finishConversationWithFollowUp();

    if (askedMoreSubject) {
      await this.client.sendMessage(env.DEFAULT_INITIAL_MESSAGE).catch(() => {});
    }
    // If we started a new conversation above, try to confirm consent so the next job won't time out
    if (askedMoreSubject) {
      try {
        const initial = await this.waitInitialResponseAfterHello();
        const intent = this.intentFromText(initial);
        if (intent === "consent_request") {
          await this.client.sendOption(["Sim, Clara!", "Sim"], "Sim, Clara!").catch(() => {});
        }
      } catch (error) {
        // ignore errors here, we'll still close current job
        logger.warn({ error, identificador: job.identificador }, "nao confirmou consentimento apos reiniciar conversa");
      }
    }

    throw new ConversationFailure("not_found", `Fatura ${job.mesReferencia} nao encontrada`);
  }

  private logHolderDivergence(job: InvoiceJob, text: string): void {
    if (!job.nomeTitular) return;
    const expected = normalizeText(job.nomeTitular);
    if (expected && !normalizeText(text).includes(expected)) {
      logger.warn({ identificador: job.identificador, nomeTitular: job.nomeTitular }, "possivel divergencia de titular");
    }
  }

  private async sendLastDigitsAndWaitForInvoices(job: InvoiceJob, targetReferences = [job.mesReferencia]): Promise<string> {
    // Analisa a mensagem do CEEE para determinar se está pedindo 4 primeiros ou 4 últimos
    const recentText = await this.client.getRecentIncomingText().catch(() => "");
    const digitsToSend = isPedindoUltimos(recentText) ? job.cpfUltimos4 : job.cpfPrimeiros4;
    
    logger.info(
      {
        identificador: job.identificador,
        pedindoUltimos: isPedindoUltimos(recentText),
        digitsToSend
      },
      "enviando dígitos do CPF"
    );
    
    await this.client.sendMessage(digitsToSend);
    const invoiceText = await this.wait("WAITING_OPEN_INVOICES_LIST", [
      ...invoiceListPatterns,
      ...invalidDataPatterns
    ], {
      includeVisibleTextFallback: true,
      visibleTextSelector: latestInvoiceSelectionBlock,
      requireVisibleTextChange: true
    });
    return this.waitForInvoiceListMatchingReferences(job, invoiceText, targetReferences);
  }

  private async navigateUntilPdfReady(job: InvoiceJob): Promise<void> {
    let currentText = await this.waitForPostInvoiceSelectionState("WAITING_STATE_AFTER_INVOICE_SELECTION");
    const startedAt = Date.now();

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS * 3) {
      this.throwIfInvalidData(currentText);
      const intent = this.intentFromText(currentText);
      logger.info({ identificador: job.identificador, intent }, "estado pos-selecao identificado");

      if (intent === "unsupported_subject") {
        currentText = await this.recoverFromUnsupportedSubject("UNSUPPORTED_SUBJECT_BEFORE_PDF", currentText);
        continue;
      }

      if (intent === "payment_method") {
        await this.answerPaymentMethod(currentText);
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

      if (intent === "invoice_list") {
        logger.info(
          { identificador: job.identificador, text: currentText.slice(-500) },
          "lista de faturas antiga ignorada apos selecao; aguardando forma de pagamento"
        );
      }

      currentText = await this.waitForPostInvoiceSelectionState("WAITING_RECOGNIZABLE_STATE_BEFORE_PDF");
    }

    throw new ConversationFailure("timeout", "Timeout ao navegar ate o PDF");
  }

  private async waitForPostInvoiceSelectionState(state: string): Promise<string> {
    return this.waitForNextActionableState(state, [
      ...paymentMethodPatterns,
      ...documentDigitsRequestPatterns,
      ...documentDigitsInvalidPatterns,
      ...pdfReadyPatterns,
      ...invalidDataPatterns
    ], {
      requireVisibleTextChange: true
    });
  }

  private async sendDocumentDigitsUntilAccepted(job: InvoiceJob): Promise<void> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Analisa a mensagem do CEEE para determinar se está pedindo 4 primeiros ou 4 últimos
      const recentText = await this.client.getRecentIncomingText().catch(() => "");
      
      // Verifica se está pedindo data de nascimento
      if (isPedindoDataDeNascimento(recentText)) {
        if (!job.dataDeNascimento || job.dataDeNascimento === "0") {
          logger.warn(
            {
              identificador: job.identificador,
              attempt,
              dataDeNascimento: job.dataDeNascimento
            },
            "data de nascimento indisponivel; encerrando tentativa"
          );
          await this.client.sendMessage("Sair");
          throw new ConversationFailure(
            "invalid_data",
            "data_de_nascimento indisponivel"
          );
        }

        logger.info(
          {
            identificador: job.identificador,
            attempt,
            dataDeNascimento: job.dataDeNascimento
          },
          "enviando data de nascimento"
        );
        
        await this.client.sendMessage(job.dataDeNascimento);
        const response = await this.wait("WAITING_PDF_OR_DATE_RETRY", [
          ...documentDigitsInvalidPatterns,
          ...birthDateRequestPatterns,
          ...rgDigitsRequestPatterns,
          ...pdfReadyPatterns,
          ...moreInvoiceQuestionPatterns,
          ...invalidDataPatterns,
          ...unsupportedSubjectPatterns
        ], {
          includeVisibleTextFallback: true,
          requireVisibleTextChange: true,
          timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
        });

        // Se o CEEE pedir RG, envia "Sair" e encerra
        if (isPedindoRg(response)) {
          await this.finishRgRequiredConversation(job, attempt);
        }

        // Se data foi recusada, tenta novamente
        if (matchesAny(response, [...documentDigitsInvalidPatterns, ...birthDateRequestPatterns])) {
          logger.warn(
            {
              identificador: job.identificador,
              attempt,
              response: response.slice(-500)
            },
            "data de nascimento recusada"
          );
          continue;
        }

        // Se conseguiu prosseguir, retorna
        if (matchesAny(response, [...pdfReadyPatterns, ...moreInvoiceQuestionPatterns])) return;
        if (isPdfReferenceCaption(response, job.mesReferencia)) {
          logger.info(
            { identificador: job.identificador, reference: job.mesReferencia },
            "referencia da fatura recebida como legenda do PDF; seguindo para download"
          );
          return;
        }
        continue;
      }

      // Envio dos dígitos do CPF normalmente
      const digitsToSend = isPedindoUltimos(recentText) ? job.cpfUltimos4 : job.cpfPrimeiros4;
      
      logger.info(
        {
          identificador: job.identificador,
          attempt,
          pedindoUltimos: isPedindoUltimos(recentText),
          digitsToSend
        },
        "enviando digitos do documento"
      );
      
      await this.client.sendMessage(digitsToSend);
      const response = await this.wait("WAITING_PDF_OR_DIGITS_RETRY", [
        ...documentDigitsInvalidPatterns,
        ...birthDateRequestPatterns,
        ...pdfReadyPatterns,
        ...moreInvoiceQuestionPatterns,
        ...invalidDataPatterns,
        ...unsupportedSubjectPatterns
      ], {
        includeVisibleTextFallback: true,
        requireVisibleTextChange: true,
        timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
      });

      if (matchesAny(response, unsupportedSubjectPatterns)) {
        const recoveredText = await this.recoverFromUnsupportedSubject("UNSUPPORTED_SUBJECT_AFTER_DOCUMENT_DIGITS", response);
        if (matchesAny(recoveredText, [...pdfReadyPatterns, ...moreInvoiceQuestionPatterns])) return;
        throw new ConversationFailure(
          "conversation_error",
          `CEEE saiu do fluxo apos os digitos do documento. Estado recuperado: ${this.intentFromText(recoveredText)}`
        );
      }
      if (matchesAny(response, [...pdfReadyPatterns, ...moreInvoiceQuestionPatterns])) return;
      if (isPdfReferenceCaption(response, job.mesReferencia)) {
        logger.info(
          { identificador: job.identificador, reference: job.mesReferencia },
          "referencia da fatura recebida como legenda do PDF; seguindo para download"
        );
        return;
      }
      // Se está pedindo data de nascimento, tenta no próximo loop
      if (isPedindoDataDeNascimento(response)) {
        logger.info(
          { identificador: job.identificador, attempt },
          "CEEE pedindo data de nascimento; tentando próxima validação"
        );
        continue;
      }
      if (matchesAny(response, documentDigitsInvalidPatterns)) {
        logger.warn(
          {
            identificador: job.identificador,
            attempt,
            response: response.slice(-500)
          },
          "digitos do documento recusados"
        );
        continue;
      }

      throw new ConversationFailure(
        "timeout",
        `Nao foi possivel confirmar entrega do PDF apos os digitos. Ultima mensagem: ${response.slice(-500)}`
      );
    }

    await this.client.sendMessage("Sair");
    throw new ConversationFailure("invalid_data", "Digitos do CPF/CNPJ recusados apos 3 tentativas");
  }

  private async finishRgRequiredConversation(job: InvoiceJob, attempt: number): Promise<never> {
    logger.warn(
      {
        identificador: job.identificador,
        mesReferencia: job.mesReferencia,
        attempt,
        rgSolicitado: true
      },
      "CEEE solicitou RG indisponivel; enviando Sair e encerrando atendimento"
    );

    await this.client.sendMessage("Sair");
    await this.finishConversationWithFollowUp();
    throw new ConversationFailure(
      "invalid_data",
      "RG solicitado pela CEEE; informacao indisponivel, atendimento finalizado com Nao",
      true
    );
  }

  private async waitForInvoiceListMatchingReferences(job: InvoiceJob, initialText: string, targetReferences: string[]): Promise<string> {
    const startedAt = Date.now();
    let latestText = latestInvoiceSelectionBlock(initialText);
    let latestInvoices = parseInvoices(latestText);

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS) {
      if (targetReferences.some((reference) => findInvoiceOption(latestText, reference))) return latestText;
      if (latestInvoices.length > 0) {
        logger.warn(
          {
            identificador: job.identificador,
            referenciasProcuradas: targetReferences,
            faturasEncontradas: latestInvoices.map((item) => ({
              option: item.option,
              reference: item.reference,
              value: item.value,
              dueDate: item.dueDate
            }))
          },
          "referencia nao encontrada na lista atual; encerrando atendimento"
        );
        return latestText;
      }

      const visibleText = latestInvoiceSelectionBlock(await this.client.getVisibleText());
      const visibleInvoices = parseInvoices(visibleText);
      if (visibleInvoices.length > 0) {
        latestText = visibleText;
        latestInvoices = visibleInvoices;
        if (targetReferences.some((reference) => findInvoiceOption(latestText, reference))) return latestText;
        return latestText;
      }

      await delay(1000);
    }

    logger.warn(
      {
        identificador: job.identificador,
        referenciasProcuradas: targetReferences,
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

  private async finishConversationWithFollowUp(initialState: { answeredMoreSubject?: boolean } = {}): Promise<void> {
    const startedAt = Date.now();
    let answeredPix = false;
    let answeredMoreInvoice = false;
    let answeredMoreSubject = initialState.answeredMoreSubject ?? false;
    let answeredRating = false;

    while (Date.now() - startedAt < 90000) {
      const text = await this.client
        .waitForMessageMatching(
          [
            ...pixQuestionPatterns,
            ...moreInvoiceQuestionPatterns,
            ...moreSubjectQuestionPatterns,
            ...ratingQuestionPatterns,
            ...donePatterns,
            ...finalGoodbyePatterns
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

      if (answeredMoreSubject && matchesAny(text, moreSubjectQuestionPatterns)) {
        await delay(1000);
        continue;
      }

      if (matchesAny(text, [...donePatterns, ...finalGoodbyePatterns])) return;
      if (matchesAny(text, unsupportedSubjectPatterns)) {
        logger.info({ text: text.slice(-500) }, "assunto nao suportado no fim da conversa; encerrando fluxo final");
        return;
      }
      if (answeredRating) return;
    }
  }

  private async finishConversationWithGroupedFollowUp(
    group: InvoiceJobGroup,
    pendingReferences: string[]
  ): Promise<string | undefined> {
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
            ...donePatterns,
            ...finalGoodbyePatterns
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
        if (pendingReferences.length > 0) {
          logger.info(
            {
              codigoVenda: group.codigoVenda,
              uc: group.uc,
              mesesPendentes: pendingReferences,
              resposta: "Sim"
            },
            "respondendo pergunta sobre outra conta"
          );
          await this.answerYesAtConversationEnd("ainda existem meses desejados pendentes");
          return this.waitForNextActionableState("WAITING_INVOICE_LIST_AFTER_MORE_INVOICE_YES", [
            ...invoiceListPatterns,
            ...noOpenDebtsPatterns,
            ...moreSubjectQuestionPatterns,
            ...ratingQuestionPatterns,
            ...donePatterns,
            ...finalGoodbyePatterns,
            ...invalidDataPatterns
          ], {
            visibleTextSelector: latestInvoiceSelectionBlock,
            requireVisibleTextChange: true,
            timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
          });
        }

        logger.info(
          {
            codigoVenda: group.codigoVenda,
            uc: group.uc,
            mesesPendentes: pendingReferences,
            resposta: "Nao"
          },
          "respondendo pergunta sobre outra conta"
        );
        await this.answerNoAtConversationEnd("sem meses desejados pendentes");
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

      if (matchesAny(text, [...donePatterns, ...finalGoodbyePatterns])) return undefined;
      if (matchesAny(text, unsupportedSubjectPatterns)) {
        logger.info({ text: text.slice(-500) }, "assunto nao suportado no fim da conversa agrupada");
        return undefined;
      }
      if (answeredRating) return undefined;
    }

    return undefined;
  }

  private handleGroupedFollowUpText(
    group: InvoiceJobGroup,
    text: string,
    pendingReferences: Set<string>,
    results: Map<string, ConversationResult>
  ): string {
    if (matchesAny(text, noOpenDebtsPatterns)) {
      this.markPendingReferencesAsNotFound(group, pendingReferences, results, "CEEE informou que nao ha debitos em aberto");
      pendingReferences.clear();
      return text;
    }

    if (matchesAny(text, invoiceListPatterns)) return text;

    this.markPendingReferencesAsNotFound(group, pendingReferences, results, "CEEE nao apresentou nova lista de faturas");
    pendingReferences.clear();
    return text;
  }

  private async recoverFromUnsupportedSubject(state: string, text: string, alreadyProbed = false): Promise<string> {
    if (matchesAny(text, moreSubjectQuestionPatterns)) {
      logger.info(
        { state, text: text.slice(-500) },
        "mensagem do site da Equatorial contem pergunta de outro assunto; seguindo para responder nao"
      );
      return text;
    }

    logger.warn(
      { state, text: text.slice(-500), alreadyProbed },
      "CEEE informou assunto fora do fluxo; tentando localizar etapa com ponto"
    );

    if (alreadyProbed) {
      await this.exitUnsupportedSubjectFlow(state, text);
    }

    await this.client.sendMessage(".");
    const response = await this.client
      .waitForMessageMatching(this.allConversationStatePatterns(), UNSUPPORTED_SUBJECT_PROBE_TIMEOUT_MS, {
        includeVisibleTextFallback: true,
        requireVisibleTextChange: true
      })
      .catch(async (error) => {
        if (!(error instanceof Error) || error.message !== "timeout") throw error;
        return this.client.getRecentIncomingText().catch(() => "");
      });

    const intent = this.intentFromText(response);
    if (intent === "unsupported_subject") {
      await this.exitUnsupportedSubjectFlow(state, response);
    }

    if (intent === "unknown") {
      throw new ConversationFailure(
        "timeout",
        `Nao foi possivel localizar etapa apos ponto em ${state}. Ultima mensagem: ${response.slice(-500)}`
      );
    }

    logger.info({ state, intent, text: response.slice(-1200) }, "estado reconhecido apos ponto de localizacao");
    return response;
  }

  private async exitUnsupportedSubjectFlow(state: string, text: string): Promise<never> {
    logger.warn(
      { state, text: text.slice(-500) },
      "CEEE repetiu mensagem de assunto fora do fluxo; encerrando para reiniciar a mesma linha"
    );
    await this.client.sendMessage("Sair");
    await this.waitForExitAcknowledgement().catch((error) => {
      logger.warn({ error, state }, "nao confirmou encerramento apos assunto fora do fluxo");
    });
    await delay(3000);
    throw new ConversationFailure("conversation_error", "CEEE saiu do fluxo; atendimento reiniciado para a mesma linha do CSV");
  }

  private async exitInvoiceSelectionWithoutDownload(group: InvoiceJobGroup, pendingReferences: string[]): Promise<void> {
    logger.info(
      {
        codigoVenda: group.codigoVenda,
        uc: group.uc,
        mesesPendentes: pendingReferences
      },
      "encerrando selecao de faturas sem baixar duplicadas"
    );
    await this.client.sendMessage("Sair");
    await this.waitForExitAcknowledgement().catch((error) => {
      logger.warn({ error, codigoVenda: group.codigoVenda, uc: group.uc }, "nao confirmou encerramento apos lista sem meses desejados");
    });
    await delay(3000);
  }

  private async answerYesAtConversationEnd(reason: string): Promise<void> {
    logger.info({ reason }, "respondendo sim no encerramento");
    await this.client.sendOption(["Sim"], "Sim").catch(async (error) => {
      logger.warn({ error, reason }, "opcao sim do encerramento nao encontrada; enviando fallback textual");
      await this.client.sendMessage("Sim");
    });
  }

  private async answerPaymentMethod(text: string): Promise<void> {
    if (isPaymentButtonMenu(text)) {
      logger.info({ resposta: "Pagar boleto" }, "respondendo forma de pagamento por boleto");
      await this.client.sendOption(["Pagar boleto", "Pagar com boleto"], "Pagar boleto").catch(async (error) => {
        logger.warn({ error }, "opcao pagar boleto nao encontrada; enviando fallback textual");
        await this.client.sendMessage("Pagar boleto");
      });
      return;
    }

    logger.info({ resposta: "2" }, "respondendo forma de pagamento por opcao numerica");
    await this.client.sendMessage("2");
  }

  private async answerOtherSubjectForSuspendedSupply(job: InvoiceJob): Promise<void> {
    logger.info(
      {
        identificador: job.identificador,
        resposta: "Outro assunto"
      },
      "fornecimento suspenso informado; selecionando outro assunto"
    );
    await this.client.sendOption(["Outro assunto"], "Outro assunto").catch(async (error) => {
      logger.warn({ error, identificador: job.identificador }, "opcao outro assunto nao encontrada; enviando fallback textual");
      await this.client.sendMessage("Outro assunto");
    });
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

function isPdfReferenceCaption(text: string, reference: string): boolean {
  const normalized = normalizeText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return normalized.some((line) => line === reference);
}

function isGeneralServicesMenu(text: string): boolean {
  const normalized = normalizeText(text);
  return /sobre o que voce gostaria de falar hoje/.test(normalized) && /segunda via de fatura/.test(normalized);
}

function isPaymentButtonMenu(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /posso te enviar essa conta por aqui/.test(normalized) ||
    (/como prefere/.test(normalized) && /pagar boleto/.test(normalized))
  );
}
