import { describe, expect, it } from "vitest";
import {
  evolutionMessageMatchesExpectedChat,
  isSameEvolutionConversation
} from "../src/services/evolution-api-client.js";

describe("isSameEvolutionConversation", () => {
  it("rejeita mensagens recentes de qualquer outro chat", () => {
    expect(isSameEvolutionConversation("555198765432@s.whatsapp.net", "555198765432@s.whatsapp.net")).toBe(true);
    expect(isSameEvolutionConversation("555198765432@s.whatsapp.net", "559898765432@s.whatsapp.net")).toBe(false);
    expect(isSameEvolutionConversation("555198765432@s.whatsapp.net", undefined)).toBe(false);
  });
});

describe("evolutionMessageMatchesExpectedChat", () => {
  it("associa somente a apresentacao da CEEE ao bot CEEE", () => {
    expect(
      evolutionMessageMatchesExpectedChat(
        "CEEE Grupo Equatorial",
        "Ola, eu sou a Clara, a assistente virtual da CEEE Grupo Equatorial"
      )
    ).toBe(true);
    expect(
      evolutionMessageMatchesExpectedChat(
        "CEEE Grupo Equatorial",
        "Ola! Eu sou a Clara, a assistente virtual da Equatorial Maranhao"
      )
    ).toBe(false);
  });

  it("associa somente a apresentacao do Maranhao ao bot Maranhao", () => {
    expect(
      evolutionMessageMatchesExpectedChat(
        "Equatorial Energia Maranhao",
        "Ola! Eu sou a Clara, a assistente virtual da Equatorial Maranhao"
      )
    ).toBe(true);
    expect(
      evolutionMessageMatchesExpectedChat(
        "Equatorial Energia Maranhao",
        "Ola, eu sou a Clara, a assistente virtual da CEEE Grupo Equatorial"
      )
    ).toBe(false);
  });

  it("associa o alias do Maranhao quando a Evolution devolve texto com mojibake", () => {
    expect(
      evolutionMessageMatchesExpectedChat(
        "Equatorial Energia Maranhao",
        "OlÃ¡! Eu sou a Clara, a assistente virtual da Equatorial MaranhÃ£o"
      )
    ).toBe(true);
  });
});
