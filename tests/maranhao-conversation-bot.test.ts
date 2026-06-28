import { describe, expect, it } from "vitest";
import {
  describeMaranhaoIntent,
  isMaranhaoEmailRequest,
  isMaranhaoIdentifierRejected,
  isMaranhaoIdentifierRequest,
  isMaranhaoPaymentMethodRequest,
  pendingMaranhaoInvoicesFromList
} from "../src/services/maranhao-conversation-bot.js";

describe("MaranhaoConversationBot", () => {
  it("manda UC somente nos pedidos explicitos do Maranhao", () => {
    expect(
      isMaranhaoIdentifierRequest(
        "Agora, informe o CPF ou CNPJ da pessoa titular da conta, ou a Unidade Consumidora do imovel, usando so numeros, sem pontos ou tracos."
      )
    ).toBe(true);
    expect(
      isMaranhaoIdentifierRequest(
        "Pra continuar, preciso que voce informe o CPF ou CNPJ da pessoa titular da conta, ou a Unidade Consumidora do imovel, usando so numeros, sem pontos ou tracos."
      )
    ).toBe(true);
  });

  it("reconhece pedido de UC do Maranhao com negrito do WhatsApp", () => {
    expect(
      isMaranhaoIdentifierRequest(
        "Agora, informe o *CPF ou CNPJ* da pessoa titular da conta, ou a *Unidade Consumidora* do imóvel, usando *só números*, sem pontos ou traços."
      )
    ).toBe(true);
  });

  it("nao manda UC em confirmacao de imovel ou protocolo", () => {
    expect(
      isMaranhaoIdentifierRequest(
        "A sua Conta Contrato atual e 003024679100. A partir de agora, sera denominada Unidade Consumidora. E para esse imovel que voce deseja atendimento?"
      )
    ).toBe(false);
    expect(isMaranhaoIdentifierRequest("O numero de protocolo desse atendimento e 0058784588.")).toBe(false);
  });

  it("prioriza confirmacao de imovel mesmo quando a ultima mensagem tambem contem despedida", () => {
    const text = `
Encontrei um imovel nesse cadastro por aqui em nome de ASSOCIACAO.

A sua Conta Contrato atual e 003024713333. A partir de agora, sera denominada Unidade Consumidora, cuja numeracao sera 000103207001695.

E para esse imovel que voce deseja atendimento?
Sim
Nao
Se precisar, e so me chamar por aqui. Tchau!
`;

    expect(describeMaranhaoIntent(text)).toBe("account_confirmation");
  });

  it("reconhece pedido de identificacao repetido apos confirmacao de imovel", () => {
    const text = `
Tudo bem, mas para continuar preciso te identificar.
Por favor, digite o numero do *CPF, o CNPJ* do titular ou a *unidade consumidora* para o qual voce deseja atendimento.

Deixa comigo aqui os seus dados sao tratados com muita responsabilidade.
`;

    expect(isMaranhaoIdentifierRequest(text)).toBe(true);
  });

  it("reconhece quando a UC nao foi identificada pela Equatorial Maranhao", () => {
    const text = `
Nao consigo te atender por aqui sem um numero valido de CPF, CNPJ ou Unidade Consumidora.
Se quiser, voce pode tirar suas duvidas no nosso site, acessando https://ma.equatorialenergia.com.br/, ou entrar em contato com a Central de Atendimento:

116
24 horas
`;

    expect(isMaranhaoIdentifierRejected(text)).toBe(true);
  });

  it("reconhece menu de pagamento do Maranhao para responder opcao 2", () => {
    const text = `
Agora voce me diz como prefere pagar, voce pode pagar com:

1. Pagar agora
2. Pagar com boleto
3. Codigo de barras
4. Pagar com pix

Como voce prefere?
`;

    expect(isMaranhaoPaymentMethodRequest(text)).toBe(true);
  });

  it("nao confunde boas-vindas com forma de pagamento do Maranhao", () => {
    const text = `
Ola, eu sou a Clara, a assistente virtual da CEEE Grupo Equatorial.

Por enquanto posso te atender com os servicos de
Codigo de Barras para Pagamento,
Consulta de Debitos,
Segunda via de Fatura.

Entao, voce concorda em ser atendido por mim aqui?
Sim, Clara!
Nao
`;

    expect(isMaranhaoPaymentMethodRequest(text)).toBe(false);
  });

  it("reconhece pedido de email cadastrado do Maranhao", () => {
    const text = `
Ok.
Pra te enviar a conta, preciso fazer uma validacao de seguranca.

Informe o email cadastrado na Unidade Consumidora.
`;

    expect(isMaranhaoEmailRequest(text)).toBe(true);
    expect(isMaranhaoIdentifierRequest(text)).toBe(false);
  });

  it("ignora referencias ja coletadas quando a lista e repetida", () => {
    const text = `
Qual conta voce quer receber agora?

1 - Referencia: 05/2026 - Valor: R$ 904,54 - Vencimento: 05/06/2026
2 - Referencia: 06/2026 - Valor: R$ 904,54 - Vencimento: 05/07/2026
`;

    expect(pendingMaranhaoInvoicesFromList(text, ["05/2026"]).map((invoice) => invoice.reference)).toEqual(["06/2026"]);
  });

  it("nao seleciona fatura quando a nova lista so tem referencia ja baixada", () => {
    const text = `
Qual conta voce quer receber agora?

1 - Referencia: 05/2026 - Valor: R$ 904,54 - Vencimento: 05/06/2026
`;

    expect(pendingMaranhaoInvoicesFromList(text, ["05/2026"])).toEqual([]);
  });
});
