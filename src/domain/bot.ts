export const botIds = ["ceee", "maranhao"] as const;

export type BotId = (typeof botIds)[number];

export function isBotId(value: string | undefined): value is BotId {
  return botIds.includes(value as BotId);
}

export function parseBotId(value: string | undefined, fallback: BotId = "ceee"): BotId {
  return isBotId(value) ? value : fallback;
}
