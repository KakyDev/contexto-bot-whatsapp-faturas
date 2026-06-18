import path from "node:path";
import os from "node:os";
import { config } from "dotenv";
import { z } from "zod";

config();

const boolFromString = z
  .string()
  .optional()
  .default("false")
  .transform((value) => value.toLowerCase() === "true");

const defaultInvoicesDir = path.join(os.homedir(), "OneDrive", "Desktop", "Teste Bot CEEE");

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
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
  BOT_ACTION_DELAY_MS: z.coerce.number().min(2000).default(2000),
  BOT_STEP_TIMEOUT_MS: z.coerce.number().min(1000).default(60000),
  PDF_DOWNLOAD_TIMEOUT_MS: z.coerce.number().min(1000).default(120000),
  MAX_RETRIES: z.coerce.number().min(1).default(2),
  INPUT_FILE: z.string().default("./data/entrada.xlsx"),
  OUTPUT_RESULTS_FILE: z.string().default("./output/resultados.csv"),
  OUTPUT_ATTEMPTS_FILE: z.string().default("./output/attempts.csv"),
  OUTPUT_INVOICES_DIR: z.string().default(defaultInvoicesDir),
  OUTPUT_ERROR_SCREENSHOTS_DIR: z.string().default("./output/errors/screenshots"),
  DEFAULT_INITIAL_MESSAGE: z.string().default("Ola"),
  DEFAULT_RATING: z.string().default("5"),
  SAVE_SCREENSHOT_ON_SUCCESS: boolFromString,
  LOG_LEVEL: z.string().default("info")
});

export const env = envSchema.parse(process.env);

export function resolveProjectPath(value: string): string {
  return path.resolve(process.cwd(), value);
}
