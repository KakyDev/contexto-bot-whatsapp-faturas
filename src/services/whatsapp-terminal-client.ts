import fs from "node:fs";
import path from "node:path";
import whatsappWeb from "whatsapp-web.js";
import type { Chat, Message, MessageAck } from "whatsapp-web.js";
import { chromium } from "playwright";
import qrcode from "qrcode-terminal";
import { env, resolveProjectPath } from "../config/env.js";
import { delay } from "../utils/delay.js";
import { normalizeText } from "../utils/normalize.js";
import { logger } from "./logger.js";
import type { ConversationClient } from "./conversation-client.js";

const { Client, LocalAuth } = whatsappWeb;
const DELIVERED_ACK = 2;
const FAILED_ACK = -1;

type HeadlessPage = {
  evaluate<R>(pageFunction: (arg: string[]) => R | Promise<R>, arg: string[]): Promise<R>;
};

type ClientPageAccess = {
  pupPage?: {
    evaluate: HeadlessPage["evaluate"];
  };
};

export interface WhatsAppTerminalClientOptions {
  terminalAuthDir?: string;
  outputInvoicesDir?: string;
}

export class WhatsAppTerminalClient implements ConversationClient {
  private client?: InstanceType<typeof Client>;
  private chat?: Chat;
  private chatId = "";
  private observedMessageCount = 0;
  private messages: Message[] = [];
  private expectedChatName = "";
  private messageAcks = new Map<string, number>();
  private pendingAckWaiters = new Map<string, (ack: number) => void>();

  constructor(
    private readonly actionDelayMs: number,
    private readonly options: WhatsAppTerminalClientOptions = {}
  ) {}

  async open(): Promise<void> {
    this.cleanupStaleBrowserLocks();
    const client = new Client({
      authStrategy: new LocalAuth({
        dataPath: resolveProjectPath(this.options.terminalAuthDir ?? env.TERMINAL_AUTH_DIR)
      }),
      puppeteer: {
        headless: true,
        executablePath: chromium.executablePath(),
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      }
    });
    this.client = client;

    client.on("qr", (qr: string) => {
      console.log("Escaneie o QR Code abaixo com o WhatsApp:");
      qrcode.generate(qr, { small: true });
    });
    client.on("authenticated", () => {
      logger.info({ transport: "whatsapp-web.js" }, "WhatsApp terminal autenticado");
    });
    client.on("loading_screen", (percent: string, message: string) => {
      logger.info({ transport: "whatsapp-web.js", percent, message }, "carregando WhatsApp terminal");
    });
    client.on("change_state", (state: string) => {
      logger.info({ transport: "whatsapp-web.js", state }, "estado WhatsApp terminal alterado");
    });
    client.on("disconnected", (reason: string) => {
      logger.warn({ transport: "whatsapp-web.js", reason }, "WhatsApp terminal desconectado");
    });

    client.on("message", (message: Message) => {
      void this.handleIncomingMessage(message);
    });
    client.on("message_ack", (message: Message, ack: MessageAck) => {
      this.handleMessageAck(message, ack);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timeout ao conectar WhatsApp terminal; QR pode ter autenticado, mas evento ready nao chegou")),
        env.BOT_STEP_TIMEOUT_MS * 2
      );
      client.once("ready", () => {
        clearTimeout(timeout);
        logger.info({ transport: "whatsapp-web.js" }, "WhatsApp terminal pronto");
        resolve();
      });
      client.once("auth_failure", (message: string) => {
        clearTimeout(timeout);
        reject(new Error(`authentication_required: ${message}`));
      });
      client.initialize().catch((error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    await this.client?.destroy();
  }

  async assertAuthenticated(): Promise<void> {
    if (!this.client) throw new Error("authentication_required");
  }

  async openConversationByPhone(contactPhone: string, expectedChatName: string): Promise<void> {
    await this.assertAuthenticated();
    const phone = contactPhone.replace(/\D/g, "");
    this.chatId = `${phone}@c.us`;
    this.chat = await this.client!.getChatById(this.chatId);
    this.chatId = this.chat.id._serialized;
    this.expectedChatName = expectedChatName;
    this.assertCurrentChatIdentity();
    logger.info(
      {
        transport: "whatsapp-web.js",
        chatId: this.chatId,
        chatName: this.chat.name,
        expectedChatName
      },
      "conversa terminal aberta"
    );
    this.messages = [];
    this.observedMessageCount = 0;
  }

  async sendMessage(text: string): Promise<void> {
    await delay(this.actionDelayMs);
    this.assertCurrentChatIdentity();
    this.markCurrentConversationPoint();
    const message = await this.client!.sendMessage(this.chatId, text);
    await this.waitForDeliveryAck(message, text);
  }

  async sendOption(labels: string[], fallback: string): Promise<void> {
    await delay(this.actionDelayMs);
    this.assertCurrentChatIdentity();
    const clicked = await this.clickMenuOption(labels).catch((error) => {
      logger.warn({ error, labels }, "falha ao clicar opcao de menu no terminal");
      return false;
    });

    if (clicked) {
      this.markCurrentConversationPoint();
      logger.info({ transport: "whatsapp-web.js", labels }, "opcao de menu clicada no terminal");
      return;
    }

    logger.warn({ transport: "whatsapp-web.js", labels, fallback }, "opcao de menu nao encontrada; enviando fallback textual");
    await this.sendMessage(fallback);
  }

  async waitForMessageMatching(patterns: RegExp[], timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await this.getVisibleTextSinceMarker();
      if (patterns.some((pattern) => pattern.test(normalizeText(text)))) return text;
      await delay(1000);
    }
    throw new Error("timeout");
  }

  async getVisibleText(): Promise<string> {
    return this.messages.map((message) => message.body).filter(Boolean).join("\n");
  }

  async getRecentIncomingText(): Promise<string> {
    return this.getVisibleTextSinceMarker();
  }

  async downloadLatestPdf(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        const message = this.messages[index];
        if (!message.hasMedia) continue;

        const media = await message.downloadMedia();
        if (!media) continue;
        const mimetype = media.mimetype.toLowerCase();
        const filename = (media.filename ?? "").toLowerCase();
        if (!mimetype.includes("pdf") && !filename.endsWith(".pdf")) continue;

        const tempDir = resolveProjectPath(this.options.outputInvoicesDir ?? env.OUTPUT_INVOICES_DIR);
        fs.mkdirSync(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `download-${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, Buffer.from(media.data, "base64"));
        return tempPath;
      }
      await delay(1000);
    }
    throw new Error("download_error");
  }

  async screenshot(targetPath: string): Promise<string> {
    const textPath = targetPath.replace(/\.png$/i, ".txt");
    fs.mkdirSync(path.dirname(textPath), { recursive: true });
    fs.writeFileSync(textPath, await this.getVisibleText(), "utf8");
    return textPath;
  }

  private trackMessage(message: Message): void {
    this.messages.push(message);
    logger.info(
      {
        transport: "whatsapp-web.js",
        from: message.from,
        hasMedia: message.hasMedia,
        type: message.type,
        text: message.body.slice(0, 500)
      },
      "mensagem recebida no terminal"
    );
  }

  private handleMessageAck(message: Message, ack: MessageAck): void {
    const messageId = message.id?._serialized;
    if (!messageId) return;

    this.messageAcks.set(messageId, ack);
    logger.info(
      {
        transport: "whatsapp-web.js",
        chatId: this.chatId,
        chatName: this.chat?.name,
        messageId,
        ack,
        fromMe: message.fromMe,
        text: message.body?.slice(0, 120) ?? ""
      },
      "ack de mensagem atualizado no terminal"
    );

    this.pendingAckWaiters.get(messageId)?.(ack);
  }

  private async waitForDeliveryAck(message: Message, text: string): Promise<void> {
    const messageId = message.id?._serialized;
    const initialAck = Number(message.ack ?? 0);
    if (!messageId || env.TERMINAL_DELIVERY_ACK_TIMEOUT_MS === 0 || initialAck >= DELIVERED_ACK) {
      logger.info(
        {
          transport: "whatsapp-web.js",
          chatId: this.chatId,
          chatName: this.chat?.name,
          messageId,
          ack: initialAck,
          text: text.slice(0, 120)
        },
        "mensagem enviada no terminal"
      );
      return;
    }

    const latestAck = this.messageAcks.get(messageId) ?? initialAck;
    if (latestAck >= DELIVERED_ACK) return;
    if (latestAck === FAILED_ACK) throw new Error(`delivery_not_confirmed: WhatsApp marcou falha no envio da mensagem ${messageId}`);

    logger.info(
      {
        transport: "whatsapp-web.js",
        chatId: this.chatId,
        chatName: this.chat?.name,
        messageId,
        ack: latestAck,
        timeoutMs: env.TERMINAL_DELIVERY_ACK_TIMEOUT_MS,
        text: text.slice(0, 120)
      },
      "aguardando confirmacao de entrega da mensagem no terminal"
    );

    const finalAck = await new Promise<number>((resolve) => {
      const timeout = setTimeout(() => resolve(this.messageAcks.get(messageId) ?? latestAck), env.TERMINAL_DELIVERY_ACK_TIMEOUT_MS);
      this.pendingAckWaiters.set(messageId, (ack) => {
        if (ack < DELIVERED_ACK && ack !== FAILED_ACK) return;
        clearTimeout(timeout);
        resolve(ack);
      });
    }).finally(() => {
      this.pendingAckWaiters.delete(messageId);
    });

    if (finalAck >= DELIVERED_ACK) {
      logger.info(
        {
          transport: "whatsapp-web.js",
          chatId: this.chatId,
          chatName: this.chat?.name,
          messageId,
          ack: finalAck
        },
        "entrega da mensagem confirmada no terminal"
      );
      return;
    }

    throw new Error(
      `delivery_not_confirmed: mensagem ${messageId} ficou com ack ${finalAck} apos ${env.TERMINAL_DELIVERY_ACK_TIMEOUT_MS}ms; ` +
        `confira sessao/dispositivo vinculado do WhatsApp terminal e o contato ${this.chatId}`
    );
  }

  private assertCurrentChatIdentity(): void {
    const actualChatName = this.chat?.name?.trim() ?? "";
    if (normalizeText(actualChatName) !== normalizeText(this.expectedChatName)) {
      throw new Error(
        `Chat incorreto: esperado "${this.expectedChatName}", encontrado "${actualChatName || "titulo indisponivel"}". Envio bloqueado.`
      );
    }
  }

  private async handleIncomingMessage(message: Message): Promise<void> {
    if (!this.chatId) return;
    if (message.from === this.chatId || message.to === this.chatId) {
      this.trackMessage(message);
      return;
    }

    const chat = await message.getChat().catch(() => undefined);
    if (chat?.id?._serialized === this.chatId) {
      this.trackMessage(message);
    }
  }

  private async clickMenuOption(labels: string[]): Promise<boolean> {
    const page = this.getHeadlessPage();
    if (!page) return false;

    return page.evaluate((candidateLabels) => {
      const normalize = (value: string) =>
        value
          .normalize("NFD")
          .replace(/\p{Diacritic}/gu, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const candidates = candidateLabels.map(normalize).filter(Boolean);
      const elements = Array.from(document.querySelectorAll("button, [role='button'], div[aria-label], span"));

      for (const element of elements.reverse()) {
        const text = normalize(`${element.textContent ?? ""} ${(element as HTMLElement).getAttribute("aria-label") ?? ""}`);
        if (!text) continue;

        const matched = candidates.some((label) => text === label || text.includes(label));
        if (!matched) continue;

        const clickable = element.closest("button, [role='button']") ?? element;
        if (!(clickable instanceof HTMLElement)) continue;

        clickable.click();
        return true;
      }

      return false;
    }, labels);
  }

  private getHeadlessPage(): HeadlessPage | undefined {
    return (this.client as unknown as ClientPageAccess | undefined)?.pupPage;
  }

  private cleanupStaleBrowserLocks(): void {
    const sessionDir = path.join(resolveProjectPath(this.options.terminalAuthDir ?? env.TERMINAL_AUTH_DIR), "session");
    const lockFiles = ["DevToolsActivePort", "SingletonLock", "SingletonCookie", "SingletonSocket"];

    for (const file of lockFiles) {
      const fullPath = path.join(sessionDir, file);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { force: true });
      }
    }
  }

  private markCurrentConversationPoint(): void {
    this.observedMessageCount = this.messages.length;
  }

  private async getVisibleTextSinceMarker(): Promise<string> {
    return this.messages.slice(this.observedMessageCount).map((message) => message.body).filter(Boolean).join("\n");
  }
}
