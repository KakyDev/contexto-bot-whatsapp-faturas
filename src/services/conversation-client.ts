import type { Download } from "playwright";

export interface ConversationClient {
  open(): Promise<void>;
  close(): Promise<void>;
  assertAuthenticated(): Promise<void>;
  openConversationByPhone(contactPhone: string): Promise<void>;
  sendMessage(text: string): Promise<void>;
  sendOption(labels: string[], fallback: string): Promise<void>;
  waitForMessageMatching(
    patterns: RegExp[],
    timeoutMs: number,
    options?: {
      includeVisibleTextFallback?: boolean;
      visibleTextSelector?: (text: string) => string;
      requireVisibleTextChange?: boolean;
    }
  ): Promise<string>;
  getVisibleText(): Promise<string>;
  getRecentIncomingText(): Promise<string>;
  downloadLatestPdf(timeoutMs: number): Promise<Download | string>;
  screenshot(targetPath: string): Promise<string>;
}
