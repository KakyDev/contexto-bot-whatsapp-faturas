import { parseBotId, type BotId } from "./domain/bot.js";

export interface CliOptions {
  bot?: BotId;
  input?: string;
  sendTest?: string;
  dryRun: boolean;
  retryErrors: boolean;
  transport: "browser" | "terminal" | "evolution";
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, retryErrors: false, transport: "terminal" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--retry-errors") options.retryErrors = true;
    else if (arg === "--bot") options.bot = parseBotId(argv[++index]);
    else if (arg.startsWith("--bot=")) options.bot = parseBotId(arg.slice("--bot=".length));
    else if (arg.startsWith("bot=")) options.bot = parseBotId(arg.slice("bot=".length));
    else if (arg === "--transport") options.transport = parseTransport(argv[++index]);
    else if (arg.startsWith("--transport=")) options.transport = parseTransport(arg.slice("--transport=".length));
    else if (arg === "--input") options.input = argv[++index];
    else if (arg.startsWith("--input=")) options.input = arg.slice("--input=".length);
    else if (arg === "--send-test") {
      const next = argv[index + 1];
      options.sendTest = next && !next.startsWith("--") ? next : "Ola";
      if (next && !next.startsWith("--")) index += 1;
    }
    else if (arg.startsWith("--send-test=")) options.sendTest = arg.slice("--send-test=".length);
  }
  return options;
}

function parseTransport(value: string | undefined): CliOptions["transport"] {
  if (value === "browser" || value === "terminal" || value === "evolution") return value;
  return "terminal";
}
