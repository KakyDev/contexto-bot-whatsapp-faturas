import { env } from "./env.js";
import type { BotId } from "../domain/bot.js";

export interface BotRuntimeConfig {
  id: BotId;
  name: string;
  inputFile: string;
  outputResultsFile: string;
  outputAttemptsFile: string;
  outputInvoicesDir: string;
  outputErrorScreenshotsDir: string;
  browserProfileDir: string;
  terminalAuthDir: string;
  whatsappContactPhone: string;
  expectedChatName: string;
  defaultInitialMessage: string;
  defaultRating: string;
}

function configValue(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

export function getBotRuntimeConfig(bot: BotId): BotRuntimeConfig {
  if (bot === "maranhao") {
    return {
      id: "maranhao",
      name: "Bot Maranhao",
      inputFile: configValue(env.MARANHAO_INPUT_FILE, "./data/maranhao/entrada.xlsx"),
      outputResultsFile: configValue(env.MARANHAO_OUTPUT_RESULTS_FILE, "./output/maranhao/resultados.csv"),
      outputAttemptsFile: configValue(env.MARANHAO_OUTPUT_ATTEMPTS_FILE, "./output/maranhao/attempts.csv"),
      outputInvoicesDir: configValue(env.MARANHAO_OUTPUT_INVOICES_DIR, "./output/maranhao/invoices"),
      outputErrorScreenshotsDir: configValue(env.MARANHAO_OUTPUT_ERROR_SCREENSHOTS_DIR, "./output/maranhao/errors/screenshots"),
      browserProfileDir: configValue(env.MARANHAO_BROWSER_PROFILE_DIR, "./.browser-profile-maranhao"),
      terminalAuthDir: configValue(env.MARANHAO_TERMINAL_AUTH_DIR, "./.whatsapp-terminal-auth-maranhao"),
      whatsappContactPhone: configValue(env.MARANHAO_WHATSAPP_CONTACT_PHONE, ""),
      expectedChatName: "Equatorial Energia Maranhão",
      defaultInitialMessage: configValue(env.MARANHAO_DEFAULT_INITIAL_MESSAGE, env.DEFAULT_INITIAL_MESSAGE),
      defaultRating: configValue(env.MARANHAO_DEFAULT_RATING, env.DEFAULT_RATING)
    };
  }

  return {
    id: "ceee",
    name: "Bot CEEE",
    inputFile: configValue(env.CEEE_INPUT_FILE, env.INPUT_FILE),
    outputResultsFile: configValue(env.CEEE_OUTPUT_RESULTS_FILE, env.OUTPUT_RESULTS_FILE),
    outputAttemptsFile: configValue(env.CEEE_OUTPUT_ATTEMPTS_FILE, env.OUTPUT_ATTEMPTS_FILE),
    outputInvoicesDir: configValue(env.CEEE_OUTPUT_INVOICES_DIR, env.OUTPUT_INVOICES_DIR),
    outputErrorScreenshotsDir: configValue(env.CEEE_OUTPUT_ERROR_SCREENSHOTS_DIR, env.OUTPUT_ERROR_SCREENSHOTS_DIR),
    browserProfileDir: configValue(env.CEEE_BROWSER_PROFILE_DIR, env.BROWSER_PROFILE_DIR),
    terminalAuthDir: configValue(env.CEEE_TERMINAL_AUTH_DIR, env.TERMINAL_AUTH_DIR),
    whatsappContactPhone: configValue(env.CEEE_WHATSAPP_CONTACT_PHONE, env.WHATSAPP_CONTACT_PHONE),
    expectedChatName: "CEEE Grupo Equatorial",
    defaultInitialMessage: configValue(env.CEEE_DEFAULT_INITIAL_MESSAGE, env.DEFAULT_INITIAL_MESSAGE),
    defaultRating: configValue(env.CEEE_DEFAULT_RATING, env.DEFAULT_RATING)
  };
}
