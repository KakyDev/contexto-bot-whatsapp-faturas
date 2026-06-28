import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type { ConversationClient } from "./conversation-client.js";
import { logger } from "./logger.js";
import { delay } from "../utils/delay.js";
import { normalizeText } from "../utils/normalize.js";
import { assertSavedPdf } from "./pdf-downloader.js";

interface EvolutionMessage {
  id: string;
  timestamp: number;
  sourceIndex: number;
  fromMe: boolean;
  remoteJid?: string;
  ack?: number;
  status?: string;
  text: string;
  raw: unknown;
  message?: Record<string, unknown>;
  interactiveOptions: EvolutionInteractiveOption[];
  mediaMessageId?: string;
  mimetype?: string;
  fileName?: string;
}

interface EvolutionInteractiveOption {
  type: "button" | "list";
  id: string;
  text: string;
}

interface EvolutionBase64Response {
  base64?: string;
  mimetype?: string;
  fileName?: string;
  data?: {
    base64?: string;
    mimetype?: string;
    fileName?: string;
  };
}

export function isSameEvolutionConversation(expectedRemoteJid: string, messageRemoteJid: string | undefined): boolean {
  return Boolean(messageRemoteJid) && messageRemoteJid === expectedRemoteJid;
}

export function evolutionMessageMatchesExpectedChat(expectedChatName: string, text: string): boolean {
  const expected = normalizeText(expectedChatName);
  const message = normalizeText(text);
  if (expected.includes("ceee")) return /\bceee\b/.test(message);
  // Evolution may return UTF-8 text decoded as Latin-1 (for example,
  // "MaranhÃ£o"). The stable stem still distinguishes this bot from CEEE.
  if (expected.includes("maranh")) return /\bmaranh[^\s]*o\b/.test(message);
  return Boolean(expected) && message.includes(expected);
}

export interface EvolutionApiClientOptions {
  outputInvoicesDir?: string;
}

export class EvolutionApiClient implements ConversationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly instance: string;
  private readonly pollIntervalMs: number;
  private readonly messageSettleMs: number;
  private contactNumber = "";
  private remoteJid = "";
  private expectedChatName = "";
  private conversationRemoteJids = new Set<string>();
  private seenMessageIds = new Set<string>();
  private initialIncomingMessageIds = new Set<string>();
  private lastOutboundIncomingMessageIds = new Set<string>();
  private answeredInteractiveMessageIds = new Set<string>();
  private latestMessages: EvolutionMessage[] = [];
  private lastOutboundAt = 0;

  constructor(
    private readonly actionDelayMs: number,
    private readonly options: EvolutionApiClientOptions = {}
  ) {
    if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) {
      throw new Error("Configure EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE para usar --transport evolution");
    }

    this.baseUrl = env.EVOLUTION_API_URL.replace(/\/+$/, "");
    this.apiKey = env.EVOLUTION_API_KEY;
    this.instance = env.EVOLUTION_INSTANCE;
    this.pollIntervalMs = env.EVOLUTION_POLL_INTERVAL_MS;
    this.messageSettleMs = env.EVOLUTION_MESSAGE_SETTLE_MS;
  }

  async open(): Promise<void> {
    await this.assertAuthenticated();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  async assertAuthenticated(): Promise<void> {
    const state = await this.request<{ instance?: { state?: string }; state?: string }>(
      "GET",
      `/instance/connectionState/${encodeURIComponent(this.instance)}`
    );
    const value = normalizeText(state.instance?.state ?? state.state ?? "");
    if (!value.includes("open") && !value.includes("connected")) {
      throw new Error("authentication_required");
    }
  }

  async openConversationByPhone(contactPhone: string, expectedChatName: string): Promise<void> {
    this.contactNumber = digitsOnly(contactPhone);
    this.remoteJid = `${this.contactNumber}@s.whatsapp.net`;
    this.expectedChatName = expectedChatName;
    this.conversationRemoteJids = new Set([this.remoteJid]);
    this.answeredInteractiveMessageIds.clear();
    this.lastOutboundAt = 0;
    const messages = await this.fetchMessages();
    const incomingIds = messages.filter((message) => !message.fromMe).map((message) => message.id);
    this.latestMessages = messages;
    this.seenMessageIds = new Set(messages.map((message) => message.id));
    this.initialIncomingMessageIds = new Set(incomingIds);
    this.lastOutboundIncomingMessageIds = new Set(incomingIds);
    logger.info(
      { expectedChatName, remoteJid: this.remoteJid, aliases: [...this.conversationRemoteJids] },
      "conversa Evolution fixada no destinatario designado"
    );
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.contactNumber) throw new Error("Conversa nao foi aberta antes do envio");
    await delay(this.actionDelayMs);
    await this.sendTextPayload(
      {
        number: this.resolveSendNumber(),
        text,
        delay: this.actionDelayMs,
        linkPreview: false
      },
      "mensagem textual"
    );
  }

  async sendOption(labels: string[], fallback: string): Promise<void> {
    const incoming = await this.fetchIncomingMessages();
    const candidateMessages = this.messagesAfterLastOutbound(incoming);
    const searchableMessages = candidateMessages;
    const unansweredMenus = [...searchableMessages]
      .reverse()
      .filter((message) => message.interactiveOptions.length > 0 && !this.answeredInteractiveMessageIds.has(message.id));
    const matchingMenu = unansweredMenus
      .map((message) => ({ message, option: findInteractiveOption(message.interactiveOptions, labels, fallback) }))
      .find(({ option }) => Boolean(option));
    const menuMessage = matchingMenu?.message;
    const selected = matchingMenu?.option;

    if (unansweredMenus.length > 0 && (!menuMessage || !selected)) {
      throw new Error(
        `Menu interativo encontrado, mas nenhuma opcao bateu com: ${[...labels, fallback].join(", ")}. Opcoes: ${unansweredMenus
          .flatMap((message) => message.interactiveOptions.map((option) => option.text || option.id))
          .join(", ")}`
      );
    }

    if (!menuMessage || !selected) {
      const alreadyAnswered = [...searchableMessages].reverse().find((message) => {
        return message.interactiveOptions.length > 0 && this.answeredInteractiveMessageIds.has(message.id);
      });
      if (alreadyAnswered) {
        logger.warn(
          {
            messageId: alreadyAnswered.id,
            labels,
            fallback
          },
          "menu interativo ja respondido; evitando resposta duplicada"
        );
        return;
      }
      await this.sendMessage(fallback);
      return;
    }

    this.answeredInteractiveMessageIds.add(menuMessage.id);
    await this.sendInteractiveTextReply(menuMessage, selected);
  }

  private async sendInteractiveTextReply(message: EvolutionMessage, option: EvolutionInteractiveOption): Promise<void> {
    if (!this.contactNumber) throw new Error("Conversa nao foi aberta antes do envio");
    if (!message.message || !message.remoteJid) {
      throw new Error("Mensagem interativa da Evolution nao possui dados suficientes para responder o menu");
    }

    await delay(this.actionDelayMs);
    await this.sendTextPayload(
      {
        number: this.resolveSendNumber(),
        text: option.text || option.id,
        delay: this.actionDelayMs,
        linkPreview: false,
        quoted: {
          key: {
            id: message.id,
            fromMe: false,
            remoteJid: message.remoteJid
          },
          message: message.message
        }
      },
      "resposta interativa"
    );
    logger.info(
      {
        optionType: option.type,
        optionId: option.id,
        optionText: option.text,
        quotedMessageId: message.id
      },
      "opcao interativa respondida via evolution"
    );
  }

  private async sendTextPayload(body: Record<string, unknown>, context: string): Promise<void> {
    const endpoint = `/message/sendText/${encodeURIComponent(this.instance)}`;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const checkpoint = this.captureOutboundCheckpoint();
      try {
        const response = await this.request<unknown>("POST", endpoint, body);
        this.applyOutboundCheckpoint(checkpoint);
        await this.logEvolutionSendResult(context, body, response, checkpoint);
        return;
      } catch (error) {
        if (!this.isTransientEvolutionSendError(error) || attempt === maxAttempts) throw error;
        logger.warn(
          {
            context,
            attempt,
            maxAttempts,
            erro: error instanceof Error ? error.message : String(error)
          },
          "Evolution retornou falha transitoria no envio; tentando novamente"
        );
        await delay(attempt * 10_000);
        await this.assertAuthenticated().catch((authError) => {
          logger.warn({ error: authError }, "Evolution ainda nao confirmou conexao aberta apos falha de envio");
        });
      }
    }
  }

  private isTransientEvolutionSendError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /connection closed|timeout|socket|econnreset|internal server error/i.test(message);
  }

  private captureOutboundCheckpoint(): { at: number; incomingMessageIds: Set<string> } {
    return {
      at: Date.now(),
      incomingMessageIds: new Set(this.latestMessages.filter((message) => !message.fromMe).map((message) => message.id))
    };
  }

  private applyOutboundCheckpoint(checkpoint: { at: number; incomingMessageIds: Set<string> }): void {
    this.lastOutboundAt = checkpoint.at;
    this.lastOutboundIncomingMessageIds = checkpoint.incomingMessageIds;
  }

  private resolveSendNumber(): string {
    return this.contactNumber;
  }

  private async logEvolutionSendResult(
    context: string,
    body: Record<string, unknown>,
    response: unknown,
    checkpoint: { at: number }
  ): Promise<void> {
    await delay(Math.min(this.pollIntervalMs, 3000));
    const sentText = readString(body.text) ?? "";
    const messages = await this.fetchMessages().catch((error) => {
      logger.warn(
        {
          context,
          error: error instanceof Error ? error.message : String(error)
        },
        "falha ao buscar eco da mensagem enviada pela Evolution"
      );
      return [];
    });
    const outboundAfterSend = messages
      .filter((message) => message.fromMe)
      .filter((message) => message.timestamp === 0 || message.timestamp >= checkpoint.at - 1000)
      .slice(-5);
    const matchingOutbound = [...messages]
      .reverse()
      .find((message) => message.fromMe && normalizeText(message.text) === normalizeText(sentText));

    logger.info(
      {
        context,
        requestNumber: body.number,
        resolvedSendNumber: this.resolveSendNumber(),
        requestText: previewText(sentText),
        sendResponse: summarizeUnknown(response),
        outboundAfterSend: outboundAfterSend.map(summarizeEvolutionMessage),
        matchingOutbound: matchingOutbound ? summarizeEvolutionMessage(matchingOutbound) : undefined,
        aliases: [...this.conversationRemoteJids]
      },
      "resultado do envio Evolution"
    );

    await this.assertEvolutionDeliveryConfirmed(context, body, response, checkpoint);
  }

  private async assertEvolutionDeliveryConfirmed(
    context: string,
    body: Record<string, unknown>,
    response: unknown,
    checkpoint: { at: number }
  ): Promise<void> {
    if (env.EVOLUTION_DELIVERY_CONFIRM_TIMEOUT_MS === 0) return;
    const responseStatus = normalizeSendStatus(extractSendStatus(response));
    if (isDeliveredEvolutionStatus(responseStatus)) return;
    const responseMessageId = extractSendMessageId(response);
    const sentText = readString(body.text) ?? "";
    const deadline = Date.now() + env.EVOLUTION_DELIVERY_CONFIRM_TIMEOUT_MS;
    let latestStatus = responseStatus || "unknown";
    let latestMessage: EvolutionMessage | undefined;

    while (Date.now() < deadline) {
      const messages = await this.fetchMessages().catch(() => []);
      latestMessage = messages
        .filter((message) => message.fromMe)
        .filter((message) => {
          if (responseMessageId && message.id === responseMessageId) return true;
          if (message.timestamp > 0 && message.timestamp < checkpoint.at - 1000) return false;
          return normalizeText(message.text) === normalizeText(sentText);
        })
        .at(-1);
      latestStatus = normalizeSendStatus(latestMessage?.status ?? latestMessage?.ack ?? latestStatus);
      if (isDeliveredEvolutionStatus(latestStatus)) return;
      await delay(this.pollIntervalMs);
    }

    logger.warn(
      {
        context,
        number: body.number,
        messageId: responseMessageId,
        status: latestStatus,
        timeoutMs: env.EVOLUTION_DELIVERY_CONFIRM_TIMEOUT_MS,
        remoteJid: latestMessage?.remoteJid
      },
      "Evolution manteve envio pendente; seguindo fluxo e aguardando resposta recebida"
    );
  }

  async waitForMessageMatching(
    patterns: RegExp[],
    timeoutMs: number,
    options?: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
    }
  ): Promise<string> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const incoming = await this.fetchIncomingMessages();
      const currentIncoming = this.messagesAfterLastOutbound(incoming);
      const newMessages = currentIncoming.filter((message) => !this.seenMessageIds.has(message.id));

      for (const message of [...newMessages].reverse()) {
        this.seenMessageIds.add(message.id);
        if (isPdfMessage(message) && patterns.some((pattern) => pattern.test("pdf"))) {
          const settledText = await this.waitForSettledDecision(message.id, options);
          return settledText.trim() ? `${settledText}\nPDF` : "PDF";
        }

        if (message.text.trim() && patterns.some((pattern) => pattern.test(normalizeText(message.text)))) {
          return this.waitForSettledDecision(message.id, options);
        }
      }

      if (!options?.requireVisibleTextChange) {
        const recentText = this.selectVisibleText(incoming, options);
        if (recentText.trim() && patterns.some((pattern) => pattern.test(normalizeText(recentText)))) {
          return recentText;
        }
      }

      await delay(this.pollIntervalMs);
    }

    throw new Error("timeout");
  }

  async getVisibleText(): Promise<string> {
    await this.waitForIncomingMessagesToSettle();
    const incoming = await this.fetchIncomingMessages();
    return this.selectVisibleText(incoming);
  }

  async getRecentIncomingText(): Promise<string> {
    await this.waitForIncomingMessagesToSettle();
    const incoming = await this.fetchIncomingMessages();
    const currentIncoming = this.messagesAfterLastOutbound(incoming);
    if (currentIncoming.length > 0) return this.joinRecentIncomingText(currentIncoming);
    return this.selectVisibleText(incoming);
  }

  async downloadLatestPdf(timeoutMs: number): Promise<string> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const incoming = await this.fetchIncomingMessages();
      const currentIncoming = this.messagesAfterLastOutbound(incoming);
      const media = [...currentIncoming].reverse().find((message) => isPdfMessage(message));
      if (media?.mediaMessageId) return this.downloadMediaMessage(media);
      await delay(this.pollIntervalMs);
    }

    throw new Error("PDF nao encontrado nas mensagens recentes da Evolution API");
  }

  async screenshot(targetPath: string): Promise<string> {
    const evidencePath = targetPath.replace(/\.[^.]+$/, ".txt");
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    const messages = await this.fetchMessages().catch(() => []);
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          remoteJid: this.remoteJid,
          capturedAt: new Date().toISOString(),
          messages: messages.slice(-20)
        },
        null,
        2
      )
    );
    return evidencePath;
  }

  private async downloadMediaMessage(message: EvolutionMessage): Promise<string> {
    const response = await this.request<EvolutionBase64Response>(
      "POST",
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(this.instance)}`,
      {
        message: {
          key: {
            id: message.mediaMessageId
          }
        },
        convertToMp4: false
      }
    );
    const base64 = response.base64 ?? response.data?.base64;
    if (!base64) throw new Error("Evolution API nao retornou base64 do PDF");

    const tempPath = path.join(path.resolve(process.cwd(), this.options.outputInvoicesDir ?? "output/invoices"), `.evolution-${message.mediaMessageId}.pdf`);
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    fs.writeFileSync(tempPath, Buffer.from(stripBase64Prefix(base64), "base64"));
    assertSavedPdf(tempPath);
    logger.info({ arquivoPdfTemporario: tempPath }, "pdf baixado via evolution api");
    return tempPath;
  }

  private async fetchIncomingMessages(): Promise<EvolutionMessage[]> {
    return (await this.fetchMessages()).filter((message) => !message.fromMe);
  }

  private async fetchMessages(): Promise<EvolutionMessage[]> {
    if (!this.remoteJid) return [];
    const response = await this.request<unknown>("POST", `/chat/findMessages/${encodeURIComponent(this.instance)}`, {
      page: 1,
      offset: 100
    });
    const allMessages = extractMessages(response)
      .map((message, index) => normalizeEvolutionMessage(message, index))
      .filter((message): message is EvolutionMessage => Boolean(message));
    this.learnConversationRemoteJids(allMessages);
    const messages = allMessages
      .filter((message) => this.isMessageFromCurrentConversation(message));
    messages.sort(compareEvolutionMessageOrder);
    this.latestMessages = messages;
    return messages;
  }

  private isMessageFromCurrentConversation(message: EvolutionMessage): boolean {
    const messageRemoteJid = message.remoteJid;
    return messageRemoteJid !== undefined && this.conversationRemoteJids.has(messageRemoteJid);
  }

  private learnConversationRemoteJids(messages: EvolutionMessage[]): void {
    for (const message of messages) {
      const messageRemoteJid = message.remoteJid;
      if (
        message.fromMe ||
        !messageRemoteJid?.endsWith("@lid") ||
        !evolutionMessageMatchesExpectedChat(this.expectedChatName, message.text)
      ) {
        continue;
      }

      if (!this.conversationRemoteJids.has(messageRemoteJid)) {
        this.conversationRemoteJids.add(messageRemoteJid);
        logger.info(
          { expectedChatName: this.expectedChatName, aliasRemoteJid: messageRemoteJid },
          "alias Evolution associado ao bot designado"
        );
      }
    }
  }

  private joinRecentIncomingText(messages: EvolutionMessage[], untilId?: string): string {
    const selected = untilId ? messages.slice(0, messages.findIndex((message) => message.id === untilId) + 1) : messages;
    return selected
      .slice(-12)
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n");
  }

  private textForDecision(messages: EvolutionMessage[], message: EvolutionMessage): string {
    const text = message.text.trim();
    if (!text) return this.joinRecentIncomingText(messages, message.id);
    if (isContextualMessage(text)) return this.joinRecentIncomingText(messages, message.id);
    return text;
  }

  private selectVisibleText(
    messages: EvolutionMessage[],
    options?: {
      visibleTextSelector?: (text: string) => string;
    }
  ): string {
    const currentMessages = this.messagesAfterLastOutbound(messages);
    const selectedMessages = currentMessages;
    const latest = selectedMessages.at(-1);
    const text = latest ? this.textForDecision(selectedMessages, latest) : "";
    return options?.visibleTextSelector?.(text) ?? text;
  }

  private messagesAfterLastOutbound(messages: EvolutionMessage[]): EvolutionMessage[] {
    if (!this.lastOutboundAt) {
      return messages.filter((message) => !this.initialIncomingMessageIds.has(message.id));
    }

    return messages.filter((message) => {
      if (this.lastOutboundIncomingMessageIds.has(message.id)) return false;
      if (message.timestamp === 0) return !this.seenMessageIds.has(message.id);
      return message.timestamp >= this.lastOutboundAt - 1000;
    });
  }

  private markOutboundCheckpoint(): void {
    this.applyOutboundCheckpoint(this.captureOutboundCheckpoint());
  }

  private async waitForSettledDecision(
    messageId: string,
    options?: {
      visibleTextSelector?: (text: string) => string;
    }
  ): Promise<string> {
    await this.waitForIncomingMessagesToSettle();
    const incoming = await this.fetchIncomingMessages();
    const originalIndex = incoming.findIndex((message) => message.id === messageId);
    const candidateMessages = originalIndex >= 0 ? incoming.slice(originalIndex) : incoming;
    const selectedText = this.selectVisibleText(candidateMessages.length > 0 ? candidateMessages : incoming, options);
    const latest = incoming.at(-1);
    if (!latest) return selectedText;
    return selectedText.trim() ? selectedText : this.textForDecision(incoming, latest);
  }

  private async waitForIncomingMessagesToSettle(): Promise<void> {
    if (this.messageSettleMs <= 0) return;
    await delay(this.messageSettleMs);
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        apikey: this.apiKey,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Evolution API ${method} ${endpoint} falhou: ${response.status} ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function extractMessages(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!isRecord(response)) return [];
  for (const key of ["messages", "records", "data", "rows", "items", "result"]) {
    const value = response[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      const nested = extractMessages(value);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function normalizeEvolutionMessage(raw: unknown, sourceIndex: number): EvolutionMessage | undefined {
  if (!isRecord(raw)) return undefined;
  const key = readRecord(raw, "key");
  const message = readRecord(raw, "message");
  const id = readString(key?.id) ?? readString(raw.id) ?? readString(raw.messageId);
  if (!id) return undefined;

  const timestamp = readTimestamp(raw.messageTimestamp ?? raw.timestamp ?? raw.createdAt);
  const text = extractText(message) ?? readString(raw.text) ?? readString(raw.body) ?? "";
  const media = extractMedia(message);

  return {
    id,
    timestamp,
    sourceIndex,
    fromMe: Boolean(key?.fromMe ?? raw.fromMe),
    remoteJid: readString(key?.remoteJid) ?? readString(raw.remoteJid),
    ack: readNumber(raw.ack ?? raw.status ?? raw.messageAck ?? raw.messageStatus),
    status: readString(raw.status ?? raw.messageStatus ?? raw.deliveryStatus),
    text,
    raw,
    message,
    interactiveOptions: extractInteractiveOptions(message),
    mediaMessageId: media ? id : undefined,
    mimetype: media?.mimetype,
    fileName: media?.fileName
  };
}

function compareEvolutionMessageOrder(left: EvolutionMessage, right: EvolutionMessage): number {
  if (left.timestamp > 0 && right.timestamp > 0 && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  // Evolution commonly returns findMessages newest-first. When timestamps are
  // missing or identical, keep the normalized list oldest-first for state picks.
  return right.sourceIndex - left.sourceIndex;
}

function extractInteractiveOptions(message: Record<string, unknown> | undefined): EvolutionInteractiveOption[] {
  if (!message) return [];
  return [
    ...extractButtonOptions(readRecord(message, "buttonsMessage")),
    ...extractListOptions(readRecord(message, "listMessage")),
    ...extractTemplateButtonOptions(readRecord(message, "templateMessage"))
  ];
}

function extractButtonOptions(message: Record<string, unknown> | undefined): EvolutionInteractiveOption[] {
  if (!message) return [];
  return readArray(message.buttons)
    .map((button) => ({
      type: "button" as const,
      id: readString(button.buttonId) ?? readString(readRecord(button, "buttonText")?.displayText) ?? "",
      text: readString(readRecord(button, "buttonText")?.displayText) ?? readString(button.buttonId) ?? ""
    }))
    .filter((button) => Boolean(button.id || button.text));
}

function extractListOptions(message: Record<string, unknown> | undefined): EvolutionInteractiveOption[] {
  if (!message) return [];
  const rows = readArray(message.sections).flatMap((section) => readArray(readRecord(section, "rows") ?? section));
  return rows
    .map((row) => ({
      type: "list" as const,
      id: readString(row.rowId) ?? readString(readRecord(row, "row")?.rowId) ?? readString(row.title) ?? "",
      text: readString(row.title) ?? readString(readRecord(row, "row")?.title) ?? readString(row.rowId) ?? ""
    }))
    .filter((row) => Boolean(row.id || row.text));
}

function extractTemplateButtonOptions(message: Record<string, unknown> | undefined): EvolutionInteractiveOption[] {
  const template = readRecord(message, "hydratedTemplate");
  if (!template) return [];
  return readArray(template.hydratedButtons)
    .map((button) => {
      const quickReply = readRecord(button, "quickReplyButton");
      return {
        type: "button" as const,
        id: readString(quickReply?.id) ?? readString(quickReply?.displayText) ?? "",
        text: readString(quickReply?.displayText) ?? readString(quickReply?.id) ?? ""
      };
    })
    .filter((button) => Boolean(button.id || button.text));
}

function findInteractiveOption(
  options: EvolutionInteractiveOption[],
  labels: string[],
  fallback: string
): EvolutionInteractiveOption | undefined {
  const targets = [...labels, fallback].map(normalizeOptionText).filter(Boolean);
  return options.find((option) => {
    const candidates = [option.text, option.id].map(normalizeOptionText);
    return targets.some((target) =>
      candidates.some((candidate) => candidate === target || candidate.includes(target) || target.includes(candidate))
    );
  });
}

function extractText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const documentMessage = findNestedRecord(message, "documentMessage");
  const parts = [
    readString(message.conversation),
    readString(readRecord(message, "extendedTextMessage")?.text),
    readString(documentMessage?.caption),
    readString(readRecord(message, "imageMessage")?.caption),
    extractButtonsMessageText(readRecord(message, "buttonsMessage")),
    extractListMessageText(readRecord(message, "listMessage")),
    extractTemplateMessageText(readRecord(message, "templateMessage")),
    readString(readRecord(message, "buttonsResponseMessage")?.selectedDisplayText),
    readString(readRecord(message, "buttonsResponseMessage")?.selectedButtonId),
    readString(readRecord(message, "listResponseMessage")?.title),
    readString(readRecord(message, "listResponseMessage")?.description),
    readString(readRecord(message, "templateButtonReplyMessage")?.selectedDisplayText)
  ].filter((part): part is string => Boolean(part?.trim()));

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractButtonsMessageText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const parts = [
    readString(message.contentText),
    readString(message.footerText),
    ...readArray(message.buttons)
      .map((button) => readRecord(button, "buttonText")?.displayText)
      .map(readString)
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractListMessageText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const sections = readArray(message.sections).flatMap((section) => readArray(readRecord(section, "rows") ?? section));
  const parts = [
    readString(message.title),
    readString(message.description),
    readString(message.buttonText),
    ...sections.flatMap((row) => [readString(readRecord(row, "row")?.title), readString(row.title), readString(row.description)])
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractTemplateMessageText(message: Record<string, unknown> | undefined): string | undefined {
  const template = readRecord(message, "hydratedTemplate");
  if (!template) return undefined;
  const parts = [
    readString(template.hydratedTitleText),
    readString(template.hydratedContentText),
    readString(template.hydratedFooterText),
    ...readArray(template.hydratedButtons)
      .map((button) => readRecord(button, "quickReplyButton")?.displayText)
      .map(readString)
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractMedia(message: Record<string, unknown> | undefined): { mimetype?: string; fileName?: string } | undefined {
  if (!message) return undefined;
  const documentMessage = findNestedRecord(message, "documentMessage");
  if (documentMessage) {
    return {
      mimetype: readString(documentMessage.mimetype),
      fileName: readString(documentMessage.fileName)
    };
  }
  return undefined;
}

function findNestedRecord(
  value: Record<string, unknown> | undefined,
  key: string,
  depth = 0,
  seen = new Set<unknown>()
): Record<string, unknown> | undefined {
  if (!value || depth > 8 || seen.has(value)) return undefined;
  seen.add(value);

  const direct = readRecord(value, key);
  if (direct) return direct;

  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const found = findNestedRecord(nested, key, depth + 1, seen);
      if (found) return found;
      continue;
    }

    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (!isRecord(item)) continue;
        const found = findNestedRecord(item, key, depth + 1, seen);
        if (found) return found;
      }
    }
  }

  return undefined;
}

function isPdfMessage(message: EvolutionMessage): boolean {
  return message.mimetype?.toLowerCase().includes("pdf") === true || message.fileName?.toLowerCase().endsWith(".pdf") === true;
}

function readTimestamp(value: unknown): number {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function readArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeOptionText(value: string): string {
  return normalizeText(value).replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function stripBase64Prefix(value: string): string {
  return value.replace(/^data:.*?;base64,/, "");
}

function isContextualMessage(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /qual conta voce quer receber/.test(normalized) ||
    /referencia:\s*\d{2}\/\d{4}/.test(normalized) ||
    /aqui esta a sua fatura/.test(normalized) ||
    /\bpdf\b/.test(normalized)
  );
}

function previewText(value: string): string {
  return value.slice(0, 120).replace(/\d(?=\d{2})/g, "#");
}

function summarizeEvolutionMessage(message: EvolutionMessage): Record<string, unknown> {
  return {
    id: message.id,
    timestamp: message.timestamp,
    fromMe: message.fromMe,
    remoteJid: message.remoteJid,
    ack: message.ack,
    status: message.status,
    text: previewText(message.text)
  };
}

function summarizeUnknown(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return previewText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => summarizeUnknown(item, depth + 1));
  if (!isRecord(value)) return typeof value;
  if (depth >= 2) return "[object]";

  const summary: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 20)) {
    if (/apikey|token|secret|password|base64|media/i.test(key)) {
      summary[key] = "[redacted]";
      continue;
    }
    summary[key] = summarizeUnknown(nested, depth + 1);
  }
  return summary;
}

function extractSendMessageId(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const key = readRecord(response, "key");
  return readString(key?.id) ?? readString(response.id) ?? readString(response.messageId);
}

function extractSendStatus(response: unknown): string | number | undefined {
  if (!isRecord(response)) return undefined;
  return readString(response.status ?? response.messageStatus ?? response.deliveryStatus) ?? readNumber(response.ack ?? response.messageAck);
}

function normalizeSendStatus(value: string | number | undefined): string {
  if (typeof value === "number") return String(value);
  return normalizeText(value ?? "");
}

function isDeliveredEvolutionStatus(status: string): boolean {
  if (!status) return false;
  if (/^(2|3|4)$/.test(status)) return true;
  return /delivery|delivered|read|played|device_ack|ack_device/i.test(status);
}
