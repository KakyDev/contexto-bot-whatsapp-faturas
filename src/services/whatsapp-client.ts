import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Download, type Locator, type Page } from "playwright";
import { env, resolveProjectPath } from "../config/env.js";
import { delay } from "../utils/delay.js";
import { normalizeText } from "../utils/normalize.js";
import { logger } from "./logger.js";

const messageBoxSelector = [
  'footer [contenteditable="true"][role="textbox"]',
  '[data-testid="conversation-compose-box-input"]',
  '[contenteditable="true"][role="textbox"]'
].join(", ");

export function optionTextMatches(label: string, candidate: string): boolean {
  const expected = normalizeText(label);
  const actual = normalizeText(candidate);
  const candidateLines = actual
    .split(/\n+/)
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, "").trim())
    .filter(Boolean);
  return (
    actual === expected ||
    actual.startsWith(`${expected} `) ||
    actual.startsWith(`${expected}!`) ||
    actual.startsWith(`${expected}.`) ||
    actual.startsWith(`${expected},`) ||
    candidateLines.some(
      (line) =>
        line === expected ||
        line.startsWith(`${expected} `) ||
        line.startsWith(`${expected}!`) ||
        line.startsWith(`${expected}.`) ||
        line.startsWith(`${expected},`)
    )
  );
}

export class WhatsAppClient {
  private context?: BrowserContext;
  private page?: Page;
  private documentPreviewPage?: Page;
  private observedBodyText = "";
  private observedMessageCount = 0;
  private observedIncomingMessageCount = 0;
  private observedLatestIncomingText = "";

  constructor(private readonly actionDelayMs: number) {}

  async open(): Promise<void> {
    this.context = await chromium.launchPersistentContext(resolveProjectPath(env.BROWSER_PROFILE_DIR), {
      headless: env.HEADLESS,
      acceptDownloads: true
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(env.WHATSAPP_WEB_URL, { waitUntil: "domcontentloaded" });
  }

  async close(): Promise<void> {
    await this.context?.close();
  }

  getPage(): Page {
    if (!this.page) throw new Error("WhatsApp nao inicializado");
    return this.page;
  }

  async assertAuthenticated(): Promise<void> {
    const page = this.getPage();
    await page.waitForLoadState("domcontentloaded");
    const qr = page.locator('canvas[aria-label*="Scan"], canvas, [data-testid="qrcode"]');
    const composer = page.locator(messageBoxSelector);
    const authenticated = await composer.first().isVisible({ timeout: 5000 }).catch(() => false);
    const hasQr = await qr.first().isVisible({ timeout: 1000 }).catch(() => false);
    if (!authenticated && hasQr) throw new Error("authentication_required");
  }

  async openConversationByPhone(contactPhone: string): Promise<void> {
    const page = this.getPage();
    await this.assertAuthenticated();
    const phone = contactPhone.replace(/\D/g, "");
    await page.goto(`${env.WHATSAPP_WEB_URL}/send?phone=${phone}`, { waitUntil: "domcontentloaded" });
    await this.waitForComposer();
    await this.markCurrentConversationPoint();
  }

  async openConversation(contactName: string): Promise<void> {
    const page = this.getPage();
    await this.assertAuthenticated();
    const search = page
      .locator('[contenteditable="true"][role="textbox"], [data-testid="chat-list-search"]')
      .first();
    await search.click({ timeout: env.BOT_STEP_TIMEOUT_MS });
    await search.fill(contactName);
    await delay(1000);
    const contact = page.getByText(contactName, { exact: false }).first();
    await contact.click({ timeout: env.BOT_STEP_TIMEOUT_MS });
    await this.waitForComposer();
    await this.markCurrentConversationPoint();
  }

  async sendMessage(text: string): Promise<void> {
    await delay(this.actionDelayMs);
    const box = await this.waitForComposer();
    await this.markCurrentConversationPoint();
    await box.click();
    await box.fill(text);
    await this.getPage().keyboard.press("Enter");
  }

  async clickOption(labels: string[]): Promise<boolean> {
    await delay(this.actionDelayMs);
    const page = this.getPage();

    const clickedRecentIncomingOption = await this.clickOptionInRecentIncomingMessage(labels);
    if (clickedRecentIncomingOption) return true;

    for (const label of labels) {
      const optionText = page.locator("main").getByText(label, { exact: true }).last();
      if (!(await optionText.isVisible({ timeout: 500 }).catch(() => false))) continue;

      await this.markCurrentConversationPoint();
      await optionText.scrollIntoViewIfNeeded().catch(() => undefined);
      await optionText.click({ timeout: env.BOT_STEP_TIMEOUT_MS });
      logger.info({ label }, "opcao clicada por texto exato");
      return true;
    }

    const buttons = page.locator('[role="button"]');
    const count = await buttons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) continue;

      const text = await button.innerText({ timeout: 1000 }).catch(() => "");
      if (labels.some((label) => optionTextMatches(label, text))) {
        await this.markCurrentConversationPoint();
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click({ timeout: env.BOT_STEP_TIMEOUT_MS });
        return true;
      }
    }

    return false;
  }

  private async clickOptionInRecentIncomingMessage(labels: string[]): Promise<boolean> {
    const clicked = await this.getPage()
      .evaluate((candidateLabels) => {
        const normalize = (value: string) =>
          value
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

        const candidates = candidateLabels.map((label) => ({ raw: label, normalized: normalize(label) }));
        const allNodes = Array.from(document.querySelectorAll("main [data-id], main [data-pre-plain-text], main [class*='message-in']"));
        const seen = new Set<Element>();
        const incomingBubbles: HTMLElement[] = [];

        for (const node of allNodes) {
          const bubble =
            node.closest('[class*="message-in"], [class*="message-out"], [data-id]') ??
            node.closest("[data-pre-plain-text]") ??
            node;
          if (!bubble || seen.has(bubble)) continue;
          seen.add(bubble);

          const element = bubble as HTMLElement;
          const className = String(element.className ?? "");
          const dataId = element.getAttribute("data-id") ?? "";
          const isOutgoing = className.includes("message-out") || dataId.startsWith("true_");
          const isIncoming = className.includes("message-in") || dataId.startsWith("false_") || (!isOutgoing && dataId !== "");
          if (isIncoming && !isOutgoing) incomingBubbles.push(element);
        }

        for (const bubble of incomingBubbles.reverse().slice(0, 3)) {
          const elements = [bubble, ...Array.from(bubble.querySelectorAll("*"))] as HTMLElement[];

          for (const candidate of candidates) {
            const target = elements
              .filter((element) => {
                const text = normalize(element.innerText || element.textContent || "");
                return text === candidate.normalized;
              })
              .sort((a, b) => {
                const area = (element: HTMLElement) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width * rect.height;
                };
                return area(a) - area(b);
              })[0];

            if (!target) continue;

            const clickable = target.closest("button, [role='button'], div") as HTMLElement | null;
            const elementToClick = clickable && bubble.contains(clickable) ? clickable : target;
            elementToClick.scrollIntoView({ block: "center", inline: "center" });
            elementToClick.click();
            return true;
          }
        }

        return false;
      }, labels)
      .catch(() => false);

    if (clicked) {
      await this.markCurrentConversationPoint();
      logger.info({ labels }, "opcao clicada na mensagem recebida recente");
    }

    return clicked;
  }

  async sendOption(labels: string[], fallback: string): Promise<void> {
    const clicked = await this.clickOption(labels);
    if (!clicked) {
      await this.sendMessage(fallback);
    }
  }

  async waitForMessageMatching(
    patterns: RegExp[],
    timeoutMs: number,
    options: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
    } = {}
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const observedFallbackText = options.visibleTextSelector?.(this.observedBodyText) ?? this.observedBodyText;
    while (Date.now() < deadline) {
      const text = await this.getVisibleTextSinceMarker();
      if (patterns.some((pattern) => pattern.test(normalizeText(text)))) return text;
      const latestIncomingText = await this.getLatestIncomingMessageText().catch(() => "");
      if (
        latestIncomingText.trim() &&
        latestIncomingText !== this.observedLatestIncomingText &&
        patterns.some((pattern) => pattern.test(normalizeText(latestIncomingText)))
      ) {
        return latestIncomingText;
      }
      if (options.includeVisibleTextFallback) {
        const visibleText = await this.getVisibleText();
        const selectedVisibleText = options.visibleTextSelector?.(visibleText) ?? visibleText;
        const visibleTextDiff = this.diffVisibleTextFromMarker(visibleText);
        const selectedVisibleTextDiff = options.visibleTextSelector?.(visibleTextDiff) ?? visibleTextDiff;
        const changed = !options.requireVisibleTextChange || selectedVisibleText !== observedFallbackText;
        const candidateText = options.requireVisibleTextChange ? selectedVisibleTextDiff : selectedVisibleText;

        if (changed && candidateText.trim() && patterns.some((pattern) => pattern.test(normalizeText(candidateText)))) {
          return candidateText;
        }
      }
      await delay(1000);
    }
    throw new Error("timeout");
  }

  async getVisibleText(): Promise<string> {
    const page = this.getPage();
    const mainText = await page.locator("main").innerText({ timeout: 5000 }).catch(() => "");
    if (mainText.trim()) return mainText;
    return page.locator("body").innerText({ timeout: 5000 });
  }

  async getRecentIncomingText(): Promise<string> {
    const sinceMarker = await this.getVisibleTextSinceMarker().catch(() => "");
    if (sinceMarker.trim()) return sinceMarker;
    return this.getLatestIncomingMessageText().catch(() => "");
  }

  async getVisibleTextSinceMarker(): Promise<string> {
    const incomingAfterLastOutgoing = await this.getIncomingTextAfterLastOutgoing().catch(() => "");
    if (incomingAfterLastOutgoing.trim()) return incomingAfterLastOutgoing;

    const incomingTexts = await this.getIncomingMessageTexts();
    const incomingCount = incomingTexts.length;
    if (incomingCount > this.observedIncomingMessageCount) {
      const allTexts = incomingTexts.slice(this.observedIncomingMessageCount);
      const joined = allTexts.join("\n");
      if (joined.trim()) return joined;
    }

    const bodyText = await this.getVisibleText();
    if (this.observedBodyText && bodyText.startsWith(this.observedBodyText)) {
      const diff = bodyText.slice(this.observedBodyText.length);
      if (incomingCount === 0 && this.observedIncomingMessageCount === 0) return diff;
    }

    return "";
  }

  private diffVisibleTextFromMarker(visibleText: string): string {
    if (!this.observedBodyText) return visibleText;
    if (visibleText.startsWith(this.observedBodyText)) {
      return visibleText.slice(this.observedBodyText.length);
    }

    const markerTail = this.observedBodyText.slice(-2000);
    const markerIndex = markerTail ? visibleText.lastIndexOf(markerTail) : -1;
    if (markerIndex >= 0) {
      return visibleText.slice(markerIndex + markerTail.length);
    }

    return "";
  }

  async downloadLatestPdf(timeoutMs: number): Promise<Download | string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(1000, deadline - Date.now());
      const directDownload = await this.tryDownloadFromDownloadControls(Math.min(remaining, 7000), true);
      if (directDownload) {
        await this.closeDocumentPreview();
        return directDownload;
      }

      const openedFromDocumentControl = await this.openLatestPdfCardFromDocumentControl();
      if (openedFromDocumentControl) {
        const previewDownload = await this.tryDownloadFromOpenPreview(Math.min(remaining, 15000));
        if (previewDownload) {
          await this.closeDocumentPreview();
          return previewDownload;
        }

        const previewPdf = await this.saveOpenPdfPreviewToTempFile(Math.min(remaining, 15000));
        await this.closeDocumentPreview();
        if (previewPdf) return previewPdf;
      }

      const openedFromText = await this.openLatestPdfCardFromVisibleText();
      if (openedFromText) {
        const previewDownload = await this.tryDownloadFromOpenPreview(Math.min(remaining, 15000));
        if (previewDownload) {
          await this.closeDocumentPreview();
          return previewDownload;
        }

        const previewPdf = await this.saveOpenPdfPreviewToTempFile(Math.min(remaining, 15000));
        await this.closeDocumentPreview();
        if (previewPdf) return previewPdf;
      }

      const cardOpened = await this.openLatestPdfCard();
      if (cardOpened) {
        const previewDownload = await this.tryDownloadFromOpenPreview(Math.min(remaining, 15000));
        if (previewDownload) {
          await this.closeDocumentPreview();
          return previewDownload;
        }

        const previewPdf = await this.saveOpenPdfPreviewToTempFile(Math.min(remaining, 15000));
        await this.closeDocumentPreview();
        if (previewPdf) return previewPdf;
      }

      await delay(1000);
    }

    throw new Error("download_error");
  }

  private async tryDownloadFromDownloadControls(timeoutMs: number, mainOnly = false): Promise<Download | undefined> {
    const page = this.documentPreviewPage?.isClosed() === false ? this.documentPreviewPage : this.getPage();
    const scope = mainOnly ? "main " : "";
    const candidates = [
      page.locator(`${scope}a[href$=".pdf"]`).last(),
      page.locator(`${scope}[aria-label*="baixar" i], ${scope}[aria-label*="download" i]`).last(),
      page.locator(`${scope}[title*="baixar" i], ${scope}[title*="download" i]`).last(),
      page.locator(`${scope}#download, ${scope}[id*="download" i]`).last(),
      page.locator(`${scope}cr-icon-button#download, ${scope}viewer-toolbar #download, ${scope}pdf-viewer #download`).last(),
      page.locator(`${scope}[data-icon*="download" i], ${scope}span[data-icon*="download" i]`).last(),
      page.locator(`${scope}[data-testid*="download" i]`).last(),
      page.getByRole("button", { name: /baixar|download/i }).last()
    ];

    for (const candidate of candidates) {
      const download = await this.tryDownloadFromClick(candidate, timeoutMs, page);
      if (download) return download;
    }

    return undefined;
  }

  private async openLatestPdfCardFromDocumentControl(): Promise<boolean> {
    const page = this.getPage();
    const candidates = [
      page.locator('main [aria-label*=".pdf" i]').last(),
      page.locator('main [title*=".pdf" i]').last(),
      page.locator('main [aria-label*="mostrar" i]').last(),
      page.locator('main [title*="mostrar" i]').last()
    ];

    for (const candidate of candidates) {
      if (!(await candidate.isVisible({ timeout: 1000 }).catch(() => false))) continue;

      await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
      const popupPromise = this.waitForDocumentPopup();
      await candidate.click({ timeout: 3000, force: true }).catch(() => undefined);
      const popup = await popupPromise;
      if (popup) {
        await this.captureDocumentPreviewPage(popup, "controle do cartao PDF");
        return true;
      }

      await delay(1000);
      if (await this.isDocumentPreviewOpen()) {
        logger.info("preview do pdf aberto pelo controle do cartao");
        return true;
      }
    }

    return false;
  }

  private async saveOpenPdfPreviewToTempFile(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const page = this.documentPreviewPage?.isClosed() === false ? this.documentPreviewPage : this.getPage();
      const pdfBytes = await this.readPdfBytesFromPage(page).catch(() => undefined);
      if (pdfBytes && pdfBytes.length > 0) {
        const targetDir = resolveProjectPath(env.OUTPUT_INVOICES_DIR);
        fs.mkdirSync(targetDir, { recursive: true });
        const tempPath = path.join(targetDir, `download-${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, pdfBytes);
        logger.info({ arquivoPdfTemporario: tempPath, bytes: pdfBytes.length }, "pdf extraido do preview");
        return tempPath;
      }

      await delay(1000);
    }

    return undefined;
  }

  private async readPdfBytesFromPage(page: Page): Promise<Buffer | undefined> {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
    const result = await page
      .evaluate(async () => {
        const candidates = [
          window.location.href,
          ...Array.from(document.querySelectorAll("embed, iframe, object, a"))
            .map((element) => {
              const source = element.getAttribute("src") || element.getAttribute("data") || element.getAttribute("href") || "";
              return source ? new URL(source, window.location.href).href : "";
            })
            .filter(Boolean)
        ];

        for (const url of candidates) {
          try {
            const response = await fetch(url);
            const contentType = response.headers.get("content-type") ?? "";
            const buffer = await response.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buffer));
            const isPdf =
              contentType.toLowerCase().includes("pdf") ||
              (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

            if (isPdf) return bytes;
          } catch {
            // Try the next candidate.
          }
        }

        return undefined;
      })
      .catch(() => undefined);

    return Array.isArray(result) ? Buffer.from(result) : undefined;
  }

  private async tryDownloadFromOpenPreview(timeoutMs: number): Promise<Download | undefined> {
    const deadline = Date.now() + timeoutMs;
    await delay(1500);

    while (Date.now() < deadline) {
      const remaining = Math.max(1000, deadline - Date.now());
      const download = await this.tryDownloadFromDownloadControls(Math.min(remaining, 5000));
      if (download) return download;
      await delay(1000);
    }

    return undefined;
  }

  private async openLatestPdfCardFromVisibleText(): Promise<boolean> {
    const page = this.getPage();
    const pdfText = page.locator("main").getByText(/\bPDF\b/i).last();
    if (!(await pdfText.isVisible({ timeout: 1000 }).catch(() => false))) return false;

    await pdfText.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await pdfText.boundingBox().catch(() => null);
    if (!box) return false;

    logger.info({ box }, "cartao pdf localizado pelo texto");

    const directActions: Array<() => Promise<void>> = [
      async () => {
        await pdfText.click({ timeout: 3000, force: true });
      },
      async () => {
        await pdfText.dblclick({ timeout: 3000, force: true });
      },
      async () => {
        await pdfText.focus({ timeout: 3000 });
        await page.keyboard.press("Enter");
      }
    ];

    for (const action of directActions) {
      const popupPromise = this.waitForDocumentPopup();
      await action().catch(() => undefined);
      const popup = await popupPromise;
      if (popup) {
        await this.captureDocumentPreviewPage(popup, "texto PDF");
        return true;
      }
      await delay(1000);
      if (await this.isDocumentPreviewOpen()) return true;
    }

    const clickTargets = [
      { x: box.x - 34, y: box.y + box.height / 2 },
      { x: box.x - 58, y: box.y + box.height / 2 },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + box.width / 2, y: box.y - 22 },
      { x: box.x - 34, y: box.y - 22 },
      { x: box.x - 58, y: box.y - 22 }
    ];

    for (const target of clickTargets) {
      const popupPromise = this.waitForDocumentPopup();
      await this.dispatchDomClickAt(target.x, target.y).catch(() => undefined);
      const domPopup = await popupPromise;
      if (domPopup) {
        await this.captureDocumentPreviewPage(domPopup, "clique DOM no PDF");
        return true;
      }
      await delay(1000);
      if (await this.isDocumentPreviewOpen()) return true;

      const mousePopupPromise = this.waitForDocumentPopup();
      await page.mouse.move(target.x, target.y).catch(() => undefined);
      await page.mouse.click(target.x, target.y).catch(() => undefined);
      const popup = await mousePopupPromise;
      if (popup) {
        await this.captureDocumentPreviewPage(popup, "texto PDF");
        return true;
      }
      await delay(1000);
      if (await this.isDocumentPreviewOpen()) return true;
    }

    return false;
  }

  private async openLatestPdfCard(): Promise<boolean> {
    const page = this.getPage();
    const boxes = await page.evaluate(() => {
      const normalize = (value: string) =>
        value
          .normalize("NFD")
          .replace(/\p{Diacritic}/gu, "")
          .toLowerCase();

      const nodes = Array.from(document.querySelectorAll("main *")).filter((node) => {
        const text = normalize((node as HTMLElement).innerText || node.textContent || "");
        return /\bpdf\b/.test(text);
      });

      return nodes
        .flatMap((node) => {
          const cards: Array<{ x: number; y: number; width: number; height: number; text: string }> = [];
          let current: Element | null = node;

          for (let depth = 0; current && depth < 10; depth += 1) {
            const element = current as HTMLElement;
            const rect = element.getBoundingClientRect();
            const text = normalize(element.innerText || element.textContent || "");
            const looksLikeDocumentCard =
              /\bpdf\b/.test(text) &&
              rect.width >= 180 &&
              rect.width <= 520 &&
              rect.height >= 45 &&
              rect.height <= 150;

            if (looksLikeDocumentCard) {
              cards.push({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                text
              });
            }

            current = current.parentElement;
          }

          return cards;
        })
        .sort((a, b) => a.width * a.height - b.width * b.height)
        .slice(0, 8);
    }).catch(() => false);

    if (!Array.isArray(boxes) || boxes.length === 0) return false;

    for (const box of boxes.reverse()) {
      const clickTargets = [
        { x: box.x + 34, y: box.y + box.height / 2 },
        { x: box.x + Math.min(90, box.width / 3), y: box.y + box.height / 2 },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        { x: box.x + box.width - 34, y: box.y + box.height / 2 }
      ];

      for (const target of clickTargets) {
        const popupPromise = this.waitForDocumentPopup();
        await page.mouse.move(target.x, target.y).catch(() => undefined);
        await page.mouse.click(target.x, target.y).catch(() => undefined);
        const popup = await popupPromise;
        if (popup) {
          await this.captureDocumentPreviewPage(popup, "cartao PDF");
          return true;
        }
        if (await this.isDocumentPreviewOpen()) return true;
        await delay(700);
      }
    }

    return false;
  }

  private async isDocumentPreviewOpen(): Promise<boolean> {
    const page = this.documentPreviewPage?.isClosed() === false ? this.documentPreviewPage : this.getPage();
    const hasPdfViewer = await page
      .evaluate(() => {
        const selectors = [
          "embed[type='application/pdf']",
          "embed[src*='.pdf']",
          "iframe[src*='.pdf']",
          "object[type='application/pdf']",
          "pdf-viewer",
          "viewer-toolbar",
          "viewer-download-controls"
        ];

        return selectors.some((selector) => document.querySelector(selector));
      })
      .catch(() => false);
    if (hasPdfViewer) {
      logger.info({ url: page.url() }, "preview do pdf aberto na pagina atual");
      return true;
    }

    const downloadVisible = await page
      .locator('[aria-label*="baixar" i], [aria-label*="download" i], [title*="baixar" i], [title*="download" i], [data-icon*="download" i]')
      .last()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (downloadVisible) return true;

    return page
      .locator('text=/Editar PDF|Operado por Adobe Acrobat|Adobe Acrobat/i')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
  }

  private async closeDocumentPreview(): Promise<void> {
    if (this.documentPreviewPage && !this.documentPreviewPage.isClosed()) {
      await this.documentPreviewPage.close().catch(() => undefined);
      this.documentPreviewPage = undefined;
      await this.getPage().bringToFront().catch(() => undefined);
      await delay(500);
      return;
    }

    const page = this.getPage();
    const closeButtons = [
      page.locator('[aria-label*="fechar" i], [aria-label*="close" i]').last(),
      page.locator('[data-icon*="x" i], [data-icon*="close" i]').last(),
      page.getByRole("button", { name: /fechar|close/i }).last()
    ];

    for (const button of closeButtons) {
      if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await button.click({ timeout: 2000 }).catch(() => undefined);
      await delay(500);
      return;
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await delay(500);
  }

  private waitForDocumentPopup(): Promise<Page | undefined> {
    return this.context?.waitForEvent("page", { timeout: 3500 }).catch(() => undefined) ?? Promise.resolve(undefined);
  }

  private async captureDocumentPreviewPage(page: Page, source: string): Promise<void> {
    this.documentPreviewPage = page;
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
    logger.info({ url: page.url(), source }, "preview do pdf aberto");
  }

  private async dispatchDomClickAt(x: number, y: number): Promise<void> {
    await this.getPage().evaluate(
      ({ clickX, clickY }) => {
        const target = document.elementFromPoint(clickX, clickY);
        if (!target) return;

        const events: MouseEvent[] = [
          new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }),
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }),
          new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }),
          new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }),
          new MouseEvent("click", { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY })
        ];

        for (const event of events) target.dispatchEvent(event);
        if (target instanceof HTMLElement) target.click();
      },
      { clickX: x, clickY: y }
    );
  }

  private async tryDownloadFromClick(locator: Locator, timeoutMs: number, page = this.getPage()): Promise<Download | undefined> {
    if (!(await locator.isVisible({ timeout: 1000 }).catch(() => false))) return undefined;

    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => undefined);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 3000 }).catch(() => undefined);
    return downloadPromise;
  }

  async screenshot(targetPath: string): Promise<string> {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await this.getPage().screenshot({ path: targetPath, fullPage: true });
    return targetPath;
  }

  private async waitForComposer(): Promise<Locator> {
    const locator = this.getPage().locator(messageBoxSelector).last();
    await locator.waitFor({ state: "visible", timeout: env.BOT_STEP_TIMEOUT_MS });
    return locator;
  }

  private async markCurrentConversationPoint(): Promise<void> {
    const page = this.getPage();
    this.observedBodyText = await this.getVisibleText().catch(() => "");
    this.observedMessageCount = await page.locator("main [data-pre-plain-text]").count().catch(() => 0);
    this.observedIncomingMessageCount = (await this.getIncomingMessageTexts().catch(() => [])).length;
    this.observedLatestIncomingText = await this.getLatestIncomingMessageText().catch(() => "");
  }

  private async getIncomingMessageTexts(): Promise<string[]> {
    return this.getPage().evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("main [data-pre-plain-text], main [data-id]"));
      const seen = new Set<Element>();
      return nodes
        .map((node) => {
          const bubble =
            node.closest('[class*="message-in"], [class*="message-out"], [data-id]') ??
            node.closest("[data-pre-plain-text]") ??
            node;
          if (seen.has(bubble)) return "";
          seen.add(bubble);

          const element = bubble as HTMLElement;
          const className = String(element.className ?? "");
          const dataId = element.getAttribute("data-id") ?? "";
          const isOutgoing = className.includes("message-out") || dataId.startsWith("true_");
          const isIncoming = className.includes("message-in") || dataId.startsWith("false_") || (!isOutgoing && dataId !== "");
          if (!isIncoming || isOutgoing) return "";
          return element.innerText || "";
        })
        .filter((text) => text.trim().length > 0);
    });
  }

  private async getIncomingTextAfterLastOutgoing(): Promise<string> {
    return this.getPage().evaluate(() => {
      const allNodes = Array.from(document.querySelectorAll("main [data-id], main [data-pre-plain-text], main [class*='message-']"));
      const bubbles: Array<{ direction: "in" | "out"; text: string }> = [];
      const seen = new Set<Element>();

      for (const node of allNodes) {
        const bubble =
          node.closest('[class*="message-in"], [class*="message-out"], [data-id]') ??
          node.closest("[data-pre-plain-text]") ??
          node;
        if (!bubble || seen.has(bubble)) continue;
        seen.add(bubble);

        const element = bubble as HTMLElement;
        const text = element.innerText?.trim() ?? "";
        if (!text) continue;
        const className = String(element.className ?? "");
        const dataId = element.getAttribute("data-id") ?? "";
        const isOutgoing = className.includes("message-out") || dataId.startsWith("true_");
        const isIncoming = className.includes("message-in") || dataId.startsWith("false_") || (!isOutgoing && dataId !== "");
        if (!isOutgoing && !isIncoming) continue;

        bubbles.push({
          direction: isOutgoing ? "out" : "in",
          text
        });
      }

      const lastOutgoingIndex = bubbles.map((bubble) => bubble.direction).lastIndexOf("out");
      if (lastOutgoingIndex < 0) return "";

      return bubbles
        .slice(lastOutgoingIndex + 1)
        .filter((bubble) => bubble.direction === "in")
        .map((bubble) => bubble.text)
        .join("\n");
    });
  }

  private async getLatestIncomingMessageText(): Promise<string> {
    return this.getPage().evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("main [data-id], main [data-pre-plain-text], main [class*='message-in']"));
      const seen = new Set<Element>();
      const incomingTexts: string[] = [];

      for (const node of nodes) {
        const bubble =
          node.closest('[class*="message-in"], [class*="message-out"], [data-id]') ??
          node.closest("[data-pre-plain-text]") ??
          node;
        if (seen.has(bubble)) continue;
        seen.add(bubble);

        const element = bubble as HTMLElement;
        const className = String(element.className ?? "");
        const dataId = element.getAttribute("data-id") ?? "";
        const isOutgoing = className.includes("message-out") || dataId.startsWith("true_");
        const isIncoming = className.includes("message-in") || dataId.startsWith("false_") || (!isOutgoing && dataId !== "");
        if (!isIncoming || isOutgoing) continue;

        const text = element.innerText?.trim() ?? "";
        if (text) incomingTexts.push(text);
      }

      return incomingTexts.at(-1) ?? "";
    });
  }
}
