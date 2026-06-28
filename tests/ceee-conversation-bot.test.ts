import { describe, expect, it } from "vitest";
import { CeeeConversationBot } from "../src/services/ceee-conversation-bot.js";
import type { ConversationClient } from "../src/services/conversation-client.js";
import {
  documentDigitsRequestPatterns,
  identifierRequestPatterns,
  paymentMethodPatterns
} from "../src/utils/conversation-matchers.js";

class TestableCeeeConversationBot extends CeeeConversationBot {
  waitForState(patterns: RegExp[], timeoutMs: number) {
    return this.waitForNextActionableState("TEST_STATE", patterns, { timeoutMs });
  }

  clickInitialConsent(timeoutMs: number) {
    return this.clickConsentIfVisibleAndWaitNext(timeoutMs);
  }
}

function makeClient(recentIncomingText: string): ConversationClient {
  return {
    open: async () => {},
    close: async () => {},
    assertAuthenticated: async () => {},
    openConversationByPhone: async () => {},
    sendMessage: async () => {},
    sendOption: async () => {},
    waitForMessageMatching: async () => {
      throw new Error("timeout");
    },
    getVisibleText: async () => recentIncomingText,
    getRecentIncomingText: async () => recentIncomingText,
    downloadLatestPdf: async () => {
      throw new Error("not implemented");
    },
    screenshot: async (targetPath: string) => targetPath
  };
}

describe("CeeeConversationBot", () => {
  it("responde Sim, Clara quando o menu de servicos tambem aparece nas mensagens iniciais", async () => {
    const sentOptions: string[][] = [];
    const client = makeClient(`
Ola, eu sou a Clara, a assistente virtual da CEEE Grupo Equatorial.
Segunda via de Fatura.
Entao, voce concorda em ser atendido por mim aqui?
Sim, Clara!
Nao
`);
    client.sendOption = async (labels) => {
      sentOptions.push(labels);
    };
    const bot = new TestableCeeeConversationBot(client);

    await bot.clickInitialConsent(10);

    expect(sentOptions).toEqual([["Sim, Clara!", "Sim"]]);
  });

  it("nao aceita pergunta de encerramento quando a etapa espera outro estado", async () => {
    const bot = new TestableCeeeConversationBot(
      makeClient("Posso te ajudar com mais alguma coisa?\nSim\nNao")
    );

    await expect(bot.waitForState(paymentMethodPatterns, 10)).rejects.toMatchObject({
      status: "timeout"
    });
  });

  it("nao aciona recuperacao por ponto quando a resposta esperada esta no texto misturado", async () => {
    const text = `
Poxa, eu ainda nao consigo te ajudar com esse assunto por aqui.
Ok. Pra te enviar a conta, preciso fazer uma validacao de seguranca.
Digite os 4 primeiros digitos do CPF ou CNPJ de quem e titular da conta.
`;
    const bot = new TestableCeeeConversationBot(makeClient(text));

    await expect(bot.waitForState(documentDigitsRequestPatterns, 10)).resolves.toContain("Digite os 4 primeiros");
  });

  it("trata pedido de identificador da Clara como estado acionavel", async () => {
    const text = `
Tudo bem, mas para continuar preciso te identificar.
Por favor, digite o numero do CPF, o CNPJ do titular ou a unidade consumidora para o qual voce deseja atendimento.
`;
    const bot = new TestableCeeeConversationBot(makeClient(text));

    await expect(bot.waitForState(identifierRequestPatterns, 10)).resolves.toContain("unidade consumidora");
  });
});
