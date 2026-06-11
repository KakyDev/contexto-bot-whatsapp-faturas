import fs from "node:fs";
import path from "node:path";
import whatsappWeb from "whatsapp-web.js";
import type { Chat, Message } from "whatsapp-web.js";
import { chromium } from "playwright";
import qrcode from "qrcode-terminal";
import { env, resolveProjectPath } from "../config/env.js";
import { delay } from "../utils/delay.js";
import { normalizeText } from "../utils/normalize.js";
import { logger } from "./logger.js";
import type { ConversationClient } from "./conversation-client.js";

const { Client, LocalAuth } = whatsappWeb;

type HeadlessPage = {
  evaluate<R>(pageFunction: (arg: string[]) => R | Promise<R>, arg: string[]): Promise<R>;
};

type ClientPageAccess = {
  pupPage?: {
    evaluate: HeadlessPage["evaluate"];
  };
};

export class WhatsAppTerminalClient implements ConversationClient {
  private client?: InstanceType<typeof Client>;
  private chat?: Chat;
  private chatId = "";
  private observedMessageCount = 0;
  private messages: Message[] = [];

  constructor(private readonly actionDelayMs: number) {}

  async open(): Promise<void> {
    this.cleanupStaleBrowserLocks();
    const client = new Client({
      authStrategy: new LocalAuth({
        dataPath: resolveProjectPath(env.TERMINAL_AUTH_DIR)
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

  async openConversationByPhone(contactPhone: string): Promise<void> {
    await this.assertAuthenticated();
    const phone = contactPhone.replace(/\D/g, "");
    this.chatId = `${phone}@c.us`;
    this.chat = await this.client!.getChatById(this.chatId);
    this.chatId = this.chat.id._serialized;
    this.messages = [];
    this.observedMessageCount = 0;
  }

  async sendMessage(text: string): Promise<void> {
    await delay(this.actionDelayMs);
    this.markCurrentConversationPoint();
    await this.client!.sendMessage(this.chatId, text);
  }

  async sendOption(labels: string[], fallback: string): Promise<void> {
    await delay(this.actionDelayMs);
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

        const tempDir = resolveProjectPath(env.OUTPUT_INVOICES_DIR);
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
    const sessionDir = path.join(resolveProjectPath(env.TERMINAL_AUTH_DIR), "session");
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
