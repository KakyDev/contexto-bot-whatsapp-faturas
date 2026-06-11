export interface CliOptions {
  input?: string;
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
    else if (arg === "--transport") options.transport = parseTransport(argv[++index]);
    else if (arg.startsWith("--transport=")) options.transport = parseTransport(arg.slice("--transport=".length));
    else if (arg === "--input") options.input = argv[++index];
    else if (arg.startsWith("--input=")) options.input = arg.slice("--input=".length);
  }
  return options;
}

function parseTransport(value: string | undefined): CliOptions["transport"] {
  if (value === "browser" || value === "terminal" || value === "evolution") return value;
  return "terminal";
}
