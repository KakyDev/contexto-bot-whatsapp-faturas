import { describe, expect, it } from "vitest";
import { chatTitleMatches, optionTextMatches } from "../src/services/whatsapp-client.js";

describe("optionTextMatches", () => {
  it("nao confunde Confirmo com Nao confirmo", () => {
    expect(optionTextMatches("Confirmo", "Confirmo")).toBe(true);
    expect(optionTextMatches("Confirmo", "Nao confirmo")).toBe(false);
  });

  it("aceita complemento depois da opcao esperada", () => {
    expect(optionTextMatches("Sim, Clara!", "Sim, Clara! ok")).toBe(true);
  });

  it("aceita icone antes do texto da opcao", () => {
    expect(optionTextMatches("Confirmo", "< Confirmo")).toBe(true);
    expect(optionTextMatches("Confirmo", "< Nao confirmo")).toBe(false);
  });

  it("nao confunde codigo de pagamento com segunda via", () => {
    expect(optionTextMatches("Segunda via Fatura", "Codigo de Pagamento")).toBe(false);
    expect(optionTextMatches("Segunda via de Fatura", "Codigo de Pagamento")).toBe(false);
  });
});

describe("chatTitleMatches", () => {
  it("aceita apenas o chat designado, ignorando somente caixa e acentos", () => {
    expect(chatTitleMatches("Equatorial Energia Maranhão", "Equatorial Energia Maranhao")).toBe(true);
    expect(chatTitleMatches("Equatorial Energia Maranhão", "CEEE Grupo Equatorial")).toBe(false);
    expect(chatTitleMatches("CEEE Grupo Equatorial", "CEEE Grupo Equatorial - outro")).toBe(false);
  });
});
