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
  fromMe: boolean;
  remoteJid?: string;
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

export class EvolutionApiClient implements ConversationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly instance: string;
  private readonly pollIntervalMs: number;
  private readonly messageSettleMs: number;
  private contactNumber = "";
  private remoteJid = "";
  private remoteJids = new Set<string>();
  private seenMessageIds = new Set<string>();
  private initialIncomingMessageIds = new Set<string>();
  private lastOutboundIncomingMessageIds = new Set<string>();
  private answeredInteractiveMessageIds = new Set<string>();
  private latestMessages: EvolutionMessage[] = [];
  private lastOutboundAt = 0;

  constructor(private readonly actionDelayMs: number) {
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

  async openConversationByPhone(contactPhone: string): Promise<void> {
    this.contactNumber = digitsOnly(contactPhone);
    this.remoteJid = `${this.contactNumber}@s.whatsapp.net`;
    this.remoteJids = new Set([this.remoteJid]);
    this.answeredInteractiveMessageIds.clear();
    this.lastOutboundAt = 0;
    const messages = await this.fetchMessages();
    const incomingIds = messages.filter((message) => !message.fromMe).map((message) => message.id);
    this.latestMessages = messages;
    this.seenMessageIds = new Set(messages.map((message) => message.id));
    this.initialIncomingMessageIds = new Set(incomingIds);
    this.lastOutboundIncomingMessageIds = new Set(incomingIds);
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.contactNumber) throw new Error("Conversa nao foi aberta antes do envio");
    await delay(this.actionDelayMs);
    this.markOutboundCheckpoint();
    await this.request("POST", `/message/sendText/${encodeURIComponent(this.instance)}`, {
      number: this.contactNumber,
      text,
      delay: this.actionDelayMs,
      linkPreview: false
    });
  }

  async sendOption(labels: string[], fallback: string): Promise<void> {
    const incoming = await this.fetchIncomingMessages();
    const candidateMessages = this.messagesAfterLastOutbound(incoming);
    const searchableMessages = candidateMessages;
    const menuMessage = [...searchableMessages]
      .reverse()
      .find((message) => message.interactiveOptions.length > 0 && !this.answeredInteractiveMessageIds.has(message.id));
    const selected = menuMessage ? findInteractiveOption(menuMessage.interactiveOptions, labels, fallback) : undefined;

    if (menuMessage && !selected) {
      throw new Error(
        `Menu interativo encontrado, mas nenhuma opcao bateu com: ${[...labels, fallback].join(", ")}. Opcoes: ${menuMessage.interactiveOptions
          .map((option) => option.text || option.id)
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
    this.markOutboundCheckpoint();
    await this.request("POST", `/message/sendText/${encodeURIComponent(this.instance)}`, {
      number: this.contactNumber,
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
    });
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
    return this.getVisibleText();
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

    const tempPath = path.join(process.cwd(), "output", "invoices", `.evolution-${message.mediaMessageId}.pdf`);
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
    const messages = extractMessages(response)
      .map(normalizeEvolutionMessage)
      .filter((message): message is EvolutionMessage => Boolean(message))
      .filter((message) => this.isMessageFromCurrentConversation(message));
    messages.sort((left, right) => left.timestamp - right.timestamp);
    for (const message of messages) {
      if (!message.fromMe && message.remoteJid) this.remoteJids.add(message.remoteJid);
    }
    this.latestMessages = messages;
    return messages;
  }

  private isMessageFromCurrentConversation(message: EvolutionMessage): boolean {
    if (!message.remoteJid) return false;
    if (this.remoteJids.has(message.remoteJid)) return true;
    if (message.remoteJid === this.remoteJid) return true;
    if (this.lastOutboundAt && message.timestamp >= this.lastOutboundAt - 30_000) return true;
    return false;
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
      return message.timestamp === 0 || message.timestamp >= this.lastOutboundAt - 1000;
    });
  }

  private markOutboundCheckpoint(): void {
    this.lastOutboundAt = Date.now();
    this.lastOutboundIncomingMessageIds = new Set(
      this.latestMessages.filter((message) => !message.fromMe).map((message) => message.id)
    );
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

function normalizeEvolutionMessage(raw: unknown): EvolutionMessage | undefined {
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
    fromMe: Boolean(key?.fromMe ?? raw.fromMe),
    remoteJid: readString(key?.remoteJid) ?? readString(raw.remoteJid),
    text,
    raw,
    message,
    interactiveOptions: extractInteractiveOptions(message),
    mediaMessageId: media ? id : undefined,
    mimetype: media?.mimetype,
    fileName: media?.fileName
  };
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
