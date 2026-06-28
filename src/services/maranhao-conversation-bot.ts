import type { InvoiceJob, InvoiceJobGroup } from "../domain/invoice-job.js";
import type { InvoiceStatus } from "../domain/invoice-status.js";
import { env, resolveProjectPath } from "../config/env.js";
import { logger } from "./logger.js";
import { saveDownload } from "./pdf-downloader.js";
import type { ConversationClient } from "./conversation-client.js";
import {
  CeeeConversationBot,
  ConversationFailure,
  type CeeeConversationBotConfig,
  type ConversationGroupResult,
  type ConversationJobResult,
  type ConversationResult
} from "./ceee-conversation-bot.js";
import { invoicePdfPathForJob, sanitizeFilePart } from "../utils/file-name.js";
import { latestInvoiceSelectionBlock, parseInvoices, type ParsedInvoice } from "../utils/parse-invoices.js";
import {
  accountConfirmationPatterns,
  describeConversationIntent,
  documentDigitsInvalidPatterns,
  documentDigitsRequestPatterns,
  donePatterns,
  finalGoodbyePatterns,
  identifierRejectedPatterns,
  invalidDataPatterns,
  invoiceListPatterns,
  invoiceServicePatterns,
  matchesAny,
  moreInvoiceQuestionPatterns,
  moreSubjectQuestionPatterns,
  noOpenDebtsPatterns,
  pdfReadyPatterns,
  ratingQuestionPatterns,
  resolutionQuestionPatterns,
  unsupportedSubjectPatterns
} from "../utils/conversation-matchers.js";

const maranhaoProtocolPatterns = [/numero de protocolo/, /protocolo desse atendimento/];
const maranhaoEmailRequestPatterns = [/email cadastrado/, /informe o email/, /validacao de seguranca/];
const maranhaoPaymentMethodPatterns = [
  /agora voce me diz como prefere pagar/,
  /pagar agora.*pagar com boleto.*codigo de barras.*pagar com pix/,
  /como voce prefere/
];
const maranhaoIdentifierRequestPatterns = [
  /agora,? informe o cpf ou cnpj da pessoa titular da conta,? ou a unidade consumidora do imovel,? usando so numeros,? sem pontos ou tracos/,
  /pra continuar,? preciso que voce informe o cpf ou cnpj da pessoa titular da conta,? ou a unidade consumidora do imovel,? usando so numeros,? sem pontos ou tracos/,
  /por favor,? digite o numero do cpf,? o cnpj do titular ou a unidade consumidora/,
  /preciso te identificar.*cpf.*cnpj.*unidade consumidora/
];
const maranhaoIdentifierRejectedPatterns = [
  ...identifierRejectedPatterns,
  /consigo te atender por aqui sem um .*cpf.*cnpj.*unidade consumidora/
];
const DEFAULT_MARANHAO_EMAIL = "faturasnordeste@alexandriaenergia.com";
const MAX_MARANHAO_IDENTIFIER_ATTEMPTS = 3;

export function pendingMaranhaoInvoicesFromList(invoiceText: string, collectedReferences: Iterable<string>): ParsedInvoice[] {
  const collected = new Set(collectedReferences);
  return parseInvoices(latestInvoiceSelectionBlock(invoiceText)).filter((invoice) => !collected.has(invoice.reference));
}

export function isMaranhaoIdentifierRequest(text: string): boolean {
  return matchesAny(text, maranhaoIdentifierRequestPatterns);
}

export function isMaranhaoIdentifierRejected(text: string): boolean {
  return matchesAny(text, maranhaoIdentifierRejectedPatterns);
}

export function isMaranhaoPaymentMethodRequest(text: string): boolean {
  return matchesAny(text, maranhaoPaymentMethodPatterns);
}

export function isMaranhaoEmailRequest(text: string): boolean {
  return matchesAny(text, maranhaoEmailRequestPatterns);
}

export function describeMaranhaoIntent(text: string): string {
  if (isMaranhaoIdentifierRequest(text)) return "identifier_request";

  const intent = describeConversationIntent(text);
  if (intent === "done" && matchesAny(text, accountConfirmationPatterns)) return "account_confirmation";

  return intent === "identifier_request" ? "unknown" : intent;
}

export class MaranhaoConversationBot extends CeeeConversationBot {
  constructor(client: ConversationClient, config: Partial<CeeeConversationBotConfig> = {}) {
    super(client, config);
  }

  async processGroup(group: InvoiceJobGroup): Promise<ConversationGroupResult> {
    const representativeJob = group.jobs[0];
    if (!representativeJob) return { results: [] };

    const results = new Map<string, ConversationResult>();
    let lastDownloadedJob = representativeJob;
    const collectedReferences = new Set<string>();

    try {
      logger.info(
        {
          identificador: representativeJob.identificador,
          codigoVenda: group.codigoVenda,
          uc: group.uc,
          state: "MARANHAO_INIT"
        },
        "iniciando conversa agrupada Maranhao"
      );

      await this.client.openConversationByPhone(this.config.whatsappContactPhone, this.config.expectedChatName);
      await this.client.sendMessage(this.config.defaultInitialMessage);

      const currentText = await this.waitInitialResponseAfterHello();
      let invoiceText = await this.navigateUntilMaranhaoInvoiceList(representativeJob, currentText);
      const invoices = this.extractInvoicesOrThrow(group, invoiceText);
      this.replaceGroupJobsWithInvoices(group, representativeJob, invoices);

      let pendingInvoices = [...invoices];
      while (pendingInvoices.length > 0) {
        this.throwIfInvalidData(invoiceText);
        const invoice = pendingMaranhaoInvoicesFromList(invoiceText, collectedReferences).find((item) =>
          pendingInvoices.some((pending) => pending.reference === item.reference)
        );

        if (!invoice) {
          await this.exitMaranhaoRepeatedInvoiceList(group, pendingInvoices, invoiceText);
          this.markPendingMaranhaoInvoicesAsNotFound(group, pendingInvoices, results, "lista apresentou somente referencias ja coletadas");
          pendingInvoices = [];
          break;
        }

        const job = group.jobs.find((item) => item.mesReferencia === invoice.reference);
        if (!job) throw new ConversationFailure("conversation_error", `Job dinamico nao criado para ${invoice.reference}`);
        lastDownloadedJob = job;

        logger.info(
          {
            identificador: job.identificador,
            codigoVenda: group.codigoVenda,
            uc: group.uc,
            option: invoice.option,
            reference: invoice.reference,
            mesesPendentes: pendingInvoices.filter((item) => item.reference !== invoice.reference).map((item) => item.reference)
          },
          "fatura Maranhao selecionada"
        );

        await this.client.sendMessage(invoice.option);
        await this.navigateUntilMaranhaoPdfReady(job);

        const targetPath = invoicePdfPathForJob(resolveProjectPath(this.config.outputInvoicesDir), job);
        logger.info({ identificador: job.identificador, mesReferencia: job.mesReferencia, arquivoPdf: targetPath }, "baixando pdf");
        const download = await this.client.downloadLatestPdf(env.PDF_DOWNLOAD_TIMEOUT_MS).catch((error) => {
          throw new ConversationFailure("download_error", error instanceof Error ? error.message : String(error));
        });
        const savedPath = typeof download === "string" ? this.moveDownloadedFile(download, targetPath) : await saveDownload(download, targetPath);
        logger.info({ identificador: job.identificador, mesReferencia: job.mesReferencia, arquivoPdf: savedPath }, "pdf salvo");

        results.set(job.id, { status: "success", arquivoPdf: savedPath });
        collectedReferences.add(invoice.reference);
        pendingInvoices = pendingInvoices.filter((item) => item.reference !== invoice.reference);
        group.mesesBaixados = [...group.mesesBaixados, invoice.reference];
        group.mesesPendentes = pendingInvoices.map((item) => item.reference);

        const nextInvoiceText = await this.finishMaranhaoFollowUp(group, pendingInvoices);
        if (nextInvoiceText) {
          invoiceText = nextInvoiceText;
          pendingInvoices = this.refreshPendingInvoicesFromList(pendingInvoices, nextInvoiceText, collectedReferences);
        }
      }

      return { results: this.maranhaoResultsForGroup(group, results) };
    } catch (error) {
      const status = this.statusFromError(error);
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof ConversationFailure && error.conversationClosed)) {
        await this.resetConversationAfterFailure(status).catch((resetError) => {
          logger.warn({ error: resetError, status }, "falha ao resetar conversa apos erro Maranhao");
        });
      }
      await this.saveErrorEvidence(lastDownloadedJob).catch((screenshotError) => {
        logger.warn({ error: screenshotError }, "falha ao salvar screenshot");
      });
      for (const job of group.jobs) {
        if (!results.has(job.id)) results.set(job.id, { status, erro: message });
      }
      return { results: this.maranhaoResultsForGroup(group, results) };
    }
  }

  private async navigateUntilMaranhaoInvoiceList(job: InvoiceJob, initialText: string): Promise<string> {
    let currentText = initialText;
    const startedAt = Date.now();
    let invoiceServiceSelected = false;
    let identifierAttempts = 0;
    let accountConfirmed = false;

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS * 4) {
      this.throwIfInvalidData(currentText);

      if (matchesAny(currentText, noOpenDebtsPatterns)) {
        throw new ConversationFailure("not_found", "Equatorial Maranhao informou que nao ha debitos em aberto");
      }

      if (matchesAny(currentText, maranhaoProtocolPatterns)) {
        logger.info({ identificador: job.identificador }, "protocolo Maranhao recebido");
        currentText = await this.waitForMaranhaoState("WAITING_MARANHAO_AFTER_PROTOCOL");
        continue;
      }

      const intent = this.maranhaoIntentFromText(currentText);
      logger.info({ identificador: job.identificador, intent }, "estado Maranhao identificado");

      if (isMaranhaoIdentifierRejected(currentText)) {
        throw new ConversationFailure("invalid_data", "UC nao identificada pela Equatorial Maranhao");
      }

      if (intent === "invoice_service_options") {
        if (!invoiceServiceSelected) {
          await this.client.sendMessage("6");
          invoiceServiceSelected = true;
        }
        currentText = await this.waitForMaranhaoIdentifierAfterService();
        continue;
      }

      if (intent === "identifier_request") {
        if (!isMaranhaoIdentifierRequest(currentText)) {
          logger.warn(
            { identificador: job.identificador, text: currentText.slice(-500) },
            "texto classificado como identificador, mas nao e pedido de UC do Maranhao; aguardando proxima etapa"
          );
          currentText = await this.waitForMaranhaoState("WAITING_MARANHAO_AFTER_FALSE_IDENTIFIER_REQUEST");
          continue;
        }

        identifierAttempts += 1;
        if (identifierAttempts > MAX_MARANHAO_IDENTIFIER_ATTEMPTS) {
          throw new ConversationFailure("invalid_data", "Equatorial Maranhao repetiu pedido de CPF/CNPJ/UC apos envio da UC");
        }

        const identifier = job.uc || job.identificador;
        logger.info(
          {
            identificador: job.identificador,
            uc: job.uc,
            attempt: identifierAttempts,
            resposta: identifier
          },
          "enviando UC para identificacao Maranhao"
        );
        await this.client.sendMessage(identifier);
        currentText = await this.waitForMaranhaoState("WAITING_MARANHAO_AFTER_UC");
        continue;
      }

      if (intent === "account_confirmation") {
        if (!accountConfirmed) {
          await this.answerMaranhaoYes("confirmacao do imovel");
          accountConfirmed = true;
        }
        currentText = await this.waitForMaranhaoState("WAITING_MARANHAO_AFTER_ACCOUNT_CONFIRMATION");
        continue;
      }

      if (intent === "invoice_list") {
        if (identifierAttempts === 0) {
          const identifierRequest = await this.findMaranhaoIdentifierRequestOnScreen();
          if (identifierRequest) {
            logger.info(
              { identificador: job.identificador },
              "pedido de UC Maranhao encontrado na tela antes da lista; priorizando envio da UC"
            );
            currentText = identifierRequest;
            continue;
          }
        }

        return this.waitForAnyMaranhaoInvoiceList(currentText);
      }

      if (intent === "unsupported_subject") {
        throw new ConversationFailure("conversation_error", "Equatorial Maranhao saiu do fluxo esperado");
      }

      currentText = await this.waitForMaranhaoState("WAITING_MARANHAO_ACTIONABLE_STATE");
    }

    throw new ConversationFailure("timeout", "Timeout ao navegar ate a lista de faturas Maranhao");
  }

  private maranhaoIntentFromText(text: string): string {
    return describeMaranhaoIntent(text);
  }

  private async navigateUntilMaranhaoPdfReady(job: InvoiceJob): Promise<void> {
    let currentText = await this.waitForNextActionableState("WAITING_MARANHAO_AFTER_INVOICE_SELECTION", [
      ...maranhaoPaymentMethodPatterns,
      ...documentDigitsRequestPatterns,
      ...documentDigitsInvalidPatterns,
      ...pdfReadyPatterns,
      ...moreInvoiceQuestionPatterns,
      ...invalidDataPatterns
    ], {
      requireVisibleTextChange: true
    });
    const startedAt = Date.now();

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS * 3) {
      this.throwIfInvalidData(currentText);

      if (isMaranhaoPaymentMethodRequest(currentText)) {
        logger.info({ identificador: job.identificador, resposta: "2" }, "respondendo forma de pagamento Maranhao");
        await this.client.sendMessage("2");
        currentText = await this.waitForNextActionableState("WAITING_MARANHAO_AFTER_PAYMENT_2", [
          ...maranhaoEmailRequestPatterns,
          ...documentDigitsRequestPatterns,
          ...pdfReadyPatterns,
          ...moreInvoiceQuestionPatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true
        });
        continue;
      }

      if (isMaranhaoEmailRequest(currentText)) {
        await this.sendConfiguredEmail(job);
        currentText = await this.waitForNextActionableState("WAITING_MARANHAO_AFTER_EMAIL", [
          ...pdfReadyPatterns,
          ...moreInvoiceQuestionPatterns,
          ...invalidDataPatterns
        ], {
          requireVisibleTextChange: true,
          timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
        });
        continue;
      }

      if (matchesAny(currentText, pdfReadyPatterns)) return;
      if (matchesAny(currentText, moreInvoiceQuestionPatterns)) return;

      currentText = await this.waitForNextActionableState("WAITING_MARANHAO_RECOGNIZABLE_BEFORE_PDF", [
        ...maranhaoPaymentMethodPatterns,
        ...maranhaoEmailRequestPatterns,
        ...documentDigitsRequestPatterns,
        ...pdfReadyPatterns,
        ...moreInvoiceQuestionPatterns,
        ...invalidDataPatterns
      ], {
        requireVisibleTextChange: true
      });
    }

    throw new ConversationFailure("timeout", "Timeout ao navegar ate o PDF Maranhao");
  }

  private async finishMaranhaoFollowUp(group: InvoiceJobGroup, pendingInvoices: ParsedInvoice[]): Promise<string | undefined> {
    const text = await this.waitForNextActionableState("WAITING_MARANHAO_AFTER_PDF", [
      ...moreInvoiceQuestionPatterns,
      ...moreSubjectQuestionPatterns,
      ...ratingQuestionPatterns,
      ...resolutionQuestionPatterns,
      ...donePatterns,
      ...finalGoodbyePatterns
    ], {
      includeVisibleTextFallback: true,
      requireVisibleTextChange: true,
      timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
    });

    if (matchesAny(text, moreInvoiceQuestionPatterns)) {
      if (pendingInvoices.length > 0) {
        logger.info(
          { codigoVenda: group.codigoVenda, uc: group.uc, mesesPendentes: pendingInvoices.map((item) => item.reference), resposta: "Sim" },
          "respondendo pergunta sobre outra conta Maranhao"
        );
        await this.answerMaranhaoYes("ainda existem referencias pendentes");
        return this.waitForAnyMaranhaoInvoiceList(
          await this.waitForNextActionableState("WAITING_MARANHAO_LIST_AFTER_MORE_YES", [
            ...invoiceListPatterns,
            ...noOpenDebtsPatterns,
            ...invalidDataPatterns
          ], {
            visibleTextSelector: latestInvoiceSelectionBlock,
            requireVisibleTextChange: true,
            timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
          })
        );
      }

      logger.info({ codigoVenda: group.codigoVenda, uc: group.uc, resposta: "Nao" }, "respondendo fim de contas Maranhao");
      await this.answerMaranhaoNo("sem referencias pendentes");
      await this.finishMaranhaoSurvey();
      return undefined;
    }

    await this.finishMaranhaoSurvey(text);
    return undefined;
  }

  private async finishMaranhaoSurvey(initialText = ""): Promise<void> {
    let currentText = initialText;
    let ratingAnswered = false;
    let resolutionAnswered = false;
    const startedAt = Date.now();

    while (Date.now() - startedAt < 90_000) {
      if (!currentText.trim()) {
        currentText = await this.waitForNextActionableState("WAITING_MARANHAO_SURVEY", [
          ...moreSubjectQuestionPatterns,
          ...ratingQuestionPatterns,
          ...resolutionQuestionPatterns,
          ...donePatterns,
          ...finalGoodbyePatterns
        ], {
          includeVisibleTextFallback: true,
          requireVisibleTextChange: true,
          timeoutMs: 15_000,
          recoverOnTimeout: false
        }).catch(async () => this.client.getRecentIncomingText().catch(() => ""));
      }

      if (matchesAny(currentText, finalGoodbyePatterns)) {
        logger.info("atendimento Maranhao FINALIZADO");
        return;
      }

      if (matchesAny(currentText, moreSubjectQuestionPatterns)) {
        logger.info({ resposta: "Nao" }, "respondendo pergunta sobre mais alguma coisa Maranhao");
        await this.answerMaranhaoNo("pergunta sobre mais alguma coisa");
        currentText = "";
        continue;
      }

      if (!ratingAnswered && matchesAny(currentText, ratingQuestionPatterns)) {
        ratingAnswered = true;
        logger.info({ rating: this.config.defaultRating }, "respondendo avaliacao Maranhao");
        await this.client.sendMessage(this.config.defaultRating);
        currentText = "";
        continue;
      }

      if (!resolutionAnswered && matchesAny(currentText, resolutionQuestionPatterns)) {
        resolutionAnswered = true;
        logger.info({ resposta: "3" }, "respondendo pesquisa final Maranhao");
        await this.client.sendMessage("3");
        currentText = "";
        continue;
      }

      if (matchesAny(currentText, donePatterns)) {
        logger.info("mensagem de resolucao Maranhao recebida; aguardando despedida final");
        currentText = "";
        continue;
      }

      currentText = "";
    }

    throw new ConversationFailure("timeout", "Equatorial Maranhao nao enviou mensagem final de encerramento");
  }

  private waitForMaranhaoState(state: string): Promise<string> {
    return this.waitForNextActionableState(state, [
      ...invoiceServicePatterns,
      ...maranhaoIdentifierRequestPatterns,
      ...maranhaoIdentifierRejectedPatterns,
      ...accountConfirmationPatterns,
      ...invoiceListPatterns,
      ...noOpenDebtsPatterns,
      ...invalidDataPatterns,
      ...unsupportedSubjectPatterns,
      ...maranhaoProtocolPatterns
    ], {
      includeVisibleTextFallback: true,
      requireVisibleTextChange: true
    });
  }

  private waitForMaranhaoIdentifierAfterService(): Promise<string> {
    return this.waitForNextActionableState("WAITING_MARANHAO_AFTER_SERVICE_6", [
      ...maranhaoIdentifierRequestPatterns,
      ...maranhaoIdentifierRejectedPatterns,
      ...accountConfirmationPatterns,
      ...noOpenDebtsPatterns,
      ...invalidDataPatterns,
      ...unsupportedSubjectPatterns,
      ...maranhaoProtocolPatterns
    ], {
      includeVisibleTextFallback: true,
      requireVisibleTextChange: true,
      timeoutMs: Math.max(env.BOT_STEP_TIMEOUT_MS, 90_000)
    });
  }

  private async findMaranhaoIdentifierRequestOnScreen(): Promise<string | undefined> {
    const recentText = await this.client.getRecentIncomingText().catch(() => "");
    if (isMaranhaoIdentifierRequest(recentText)) return recentText;

    const visibleText = await this.client.getVisibleText().catch(() => "");
    if (isMaranhaoIdentifierRequest(visibleText)) return visibleText;

    return undefined;
  }

  private async waitForAnyMaranhaoInvoiceList(initialText: string): Promise<string> {
    const startedAt = Date.now();
    let latestText = latestInvoiceSelectionBlock(initialText);

    while (Date.now() - startedAt < env.BOT_STEP_TIMEOUT_MS) {
      if (parseInvoices(latestText).length > 0) return latestText;

      const visibleText = latestInvoiceSelectionBlock(await this.client.getVisibleText().catch(() => ""));
      if (parseInvoices(visibleText).length > 0) return visibleText;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new ConversationFailure("not_found", "Equatorial Maranhao nao apresentou faturas na lista");
  }

  private extractInvoicesOrThrow(group: InvoiceJobGroup, invoiceText: string): ParsedInvoice[] {
    const invoices = parseInvoices(latestInvoiceSelectionBlock(invoiceText));
    if (invoices.length === 0) {
      throw new ConversationFailure("not_found", "Nenhuma fatura disponivel para a UC Maranhao");
    }

    logger.info(
      {
        codigoVenda: group.codigoVenda,
        uc: group.uc,
        faturasEncontradas: invoices.map((invoice) => ({
          option: invoice.option,
          reference: invoice.reference,
          value: invoice.value,
          dueDate: invoice.dueDate
        }))
      },
      "faturas Maranhao encontradas dinamicamente"
    );

    return invoices;
  }

  private replaceGroupJobsWithInvoices(group: InvoiceJobGroup, seedJob: InvoiceJob, invoices: ParsedInvoice[]): void {
    group.jobs = invoices.map((invoice) => this.jobForInvoice(seedJob, invoice.reference));
    group.mesesDesejados = invoices.map((invoice) => invoice.reference);
    group.mesesBaixados = [];
    group.mesesPendentes = invoices.map((invoice) => invoice.reference);
  }

  private refreshPendingInvoicesFromList(
    pendingInvoices: ParsedInvoice[],
    invoiceText: string,
    collectedReferences: Set<string>
  ): ParsedInvoice[] {
    const refreshedInvoices = pendingMaranhaoInvoicesFromList(invoiceText, collectedReferences);
    const refreshedByReference = new Map(refreshedInvoices.map((invoice) => [invoice.reference, invoice]));
    return pendingInvoices.map((invoice) => refreshedByReference.get(invoice.reference) ?? invoice);
  }

  private jobForInvoice(seedJob: InvoiceJob, reference: string): InvoiceJob {
    return {
      ...seedJob,
      id: `${sanitizeFilePart(seedJob.codigoVenda || seedJob.identificador)}_${sanitizeFilePart(reference)}`,
      mesReferencia: reference,
      refOriginal: reference
    };
  }

  private maranhaoResultsForGroup(group: InvoiceJobGroup, results: Map<string, ConversationResult>): ConversationJobResult[] {
    return group.jobs.map((job) => ({
      job,
      ...(results.get(job.id) ?? { status: "conversation_error" as InvoiceStatus, erro: "Resultado nao registrado" })
    }));
  }

  private async sendConfiguredEmail(job: InvoiceJob): Promise<void> {
    const email = env.MARANHAO_EMAIL ?? DEFAULT_MARANHAO_EMAIL;

    logger.info({ identificador: job.identificador, email }, "enviando email cadastrado Maranhao");
    await this.client.sendMessage(email);
  }

  private async answerMaranhaoYes(reason: string): Promise<void> {
    logger.info({ reason }, "respondendo Sim Maranhao");
    await this.client.sendOption(["Sim"], "Sim").catch(async () => this.client.sendMessage("Sim"));
  }

  private async exitMaranhaoRepeatedInvoiceList(
    group: InvoiceJobGroup,
    pendingInvoices: ParsedInvoice[],
    invoiceText: string
  ): Promise<void> {
    logger.info(
      {
        codigoVenda: group.codigoVenda,
        uc: group.uc,
        mesesBaixados: group.mesesBaixados,
        mesesPendentes: pendingInvoices.map((invoice) => invoice.reference),
        faturasEncontradas: parseInvoices(latestInvoiceSelectionBlock(invoiceText)).map((invoice) => invoice.reference),
        resposta: "Sair"
      },
      "lista Maranhao sem referencias pendentes; encerrando selecao"
    );
    await this.client.sendMessage("Sair");
    await this.finishMaranhaoSurvey();
  }

  private markPendingMaranhaoInvoicesAsNotFound(
    group: InvoiceJobGroup,
    pendingInvoices: ParsedInvoice[],
    results: Map<string, ConversationResult>,
    reason: string
  ): void {
    for (const invoice of pendingInvoices) {
      const job = group.jobs.find((item) => item.mesReferencia === invoice.reference);
      if (!job || results.has(job.id)) continue;
      results.set(job.id, {
        status: "not_found",
        erro: `Fatura ${invoice.reference} nao encontrada (${reason})`
      });
    }
    group.mesesPendentes = pendingInvoices.map((invoice) => invoice.reference);
  }

  private async answerMaranhaoNo(reason: string): Promise<void> {
    logger.info({ reason }, "respondendo Nao Maranhao");
    await this.client.sendOption(["Não", "Nao"], "Não").catch(async () => this.client.sendMessage("Não"));
  }
}
