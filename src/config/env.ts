import path from "node:path";
import os from "node:os";
import { config } from "dotenv";
import { z } from "zod";
import { botIds } from "../domain/bot.js";

config();

const boolFromString = z
  .string()
  .optional()
  .default("false")
  .transform((value) => value.toLowerCase() === "true");

const defaultInvoicesDir = path.join(os.homedir(), "OneDrive", "Desktop", "Teste Bot CEEE");

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  BOT: z.enum(botIds).default("ceee"),
  WHATSAPP_CONTACT_PHONE: z.string().default("+55 51 3382-5500"),
  WHATSAPP_WEB_URL: z.string().url().default("https://web.whatsapp.com"),
  BROWSER_PROFILE_DIR: z.string().default("./.browser-profile"),
  TERMINAL_AUTH_DIR: z.string().default("./.whatsapp-terminal-auth"),
  HEADLESS: boolFromString,
  EVOLUTION_API_URL: z.string().url().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE: z.string().optional(),
  EVOLUTION_POLL_INTERVAL_MS: z.coerce.number().min(500).default(2000),
  EVOLUTION_MESSAGE_SETTLE_MS: z.coerce.number().min(0).default(5000),
  EVOLUTION_DELIVERY_CONFIRM_TIMEOUT_MS: z.coerce.number().min(0).default(0),
  BOT_ACTION_DELAY_MS: z.coerce.number().min(2000).default(2000),
  BOT_STEP_TIMEOUT_MS: z.coerce.number().min(1000).default(60000),
  TERMINAL_DELIVERY_ACK_TIMEOUT_MS: z.coerce.number().min(0).default(20000),
  PDF_DOWNLOAD_TIMEOUT_MS: z.coerce.number().min(1000).default(120000),
  MAX_RETRIES: z.coerce.number().min(1).default(2),
  INPUT_FILE: z.string().default("./data/entrada.xlsx"),
  OUTPUT_RESULTS_FILE: z.string().default("./output/resultados2.csv"),
  OUTPUT_ATTEMPTS_FILE: z.string().default("./output/attempts.csv"),
  OUTPUT_INVOICES_DIR: z.string().default(defaultInvoicesDir),
  OUTPUT_ERROR_SCREENSHOTS_DIR: z.string().default("./output/errors/screenshots"),
  DEFAULT_INITIAL_MESSAGE: z.string().default("Ola"),
  DEFAULT_RATING: z.string().default("5"),
  CEEE_WHATSAPP_CONTACT_PHONE: z.string().optional(),
  CEEE_INPUT_FILE: z.string().optional(),
  CEEE_OUTPUT_RESULTS_FILE: z.string().optional(),
  CEEE_OUTPUT_ATTEMPTS_FILE: z.string().optional(),
  CEEE_OUTPUT_INVOICES_DIR: z.string().optional(),
  CEEE_OUTPUT_ERROR_SCREENSHOTS_DIR: z.string().optional(),
  CEEE_BROWSER_PROFILE_DIR: z.string().optional(),
  CEEE_TERMINAL_AUTH_DIR: z.string().optional(),
  CEEE_DEFAULT_INITIAL_MESSAGE: z.string().optional(),
  CEEE_DEFAULT_RATING: z.string().optional(),
  MARANHAO_WHATSAPP_CONTACT_PHONE: z.string().optional(),
  MARANHAO_INPUT_FILE: z.string().optional(),
  MARANHAO_OUTPUT_RESULTS_FILE: z.string().optional(),
  MARANHAO_OUTPUT_ATTEMPTS_FILE: z.string().optional(),
  MARANHAO_OUTPUT_INVOICES_DIR: z.string().optional(),
  MARANHAO_OUTPUT_ERROR_SCREENSHOTS_DIR: z.string().optional(),
  MARANHAO_BROWSER_PROFILE_DIR: z.string().optional(),
  MARANHAO_TERMINAL_AUTH_DIR: z.string().optional(),
  MARANHAO_DEFAULT_INITIAL_MESSAGE: z.string().optional(),
  MARANHAO_DEFAULT_RATING: z.string().optional(),
  MARANHAO_EMAIL: z.string().email().optional(),
  SAVE_SCREENSHOT_ON_SUCCESS: boolFromString,
  LOG_LEVEL: z.string().default("info")
});

export const env = envSchema.parse(process.env);

export function resolveProjectPath(value: string): string {
  return path.resolve(process.cwd(), value);
}
