import { describe, expect, it } from "vitest";
import {
  accountConfirmationPatterns,
  consentRequestPatterns,
  conversationRecoveryPatterns,
  describeConversationIntent,
  documentDigitsInvalidPatterns,
  documentDigitsRequestPatterns,
  donePatterns,
  invoiceListPatterns,
  matchesAny,
  moreInvoiceQuestionPatterns,
  paymentMethodPatterns,
  pdfReadyPatterns,
  ratingQuestionPatterns
} from "../src/utils/conversation-matchers.js";

describe("conversation matchers", () => {
  it("reconhece consentimento por padrao de mensagem", () => {
    const text = "Entao, voce concorda em ser atendido por mim aqui?";

    expect(matchesAny(text, consentRequestPatterns)).toBe(true);
  });

  it("reconhece mensagens do fluxo real da Clara", () => {
    expect(matchesAny("Ola, eu sou a Clara, a assistente virtual da CEEE Grupo Equatorial", consentRequestPatterns)).toBe(true);
    expect(matchesAny("A sua Conta Contrato atual e 00032218567. Voce confirma?", accountConfirmationPatterns)).toBe(true);
    expect(describeConversationIntent("A sua Conta Contrato atual e 00032218567. Voce confirma?")).toBe("account_confirmation");
  });

  it("prioriza a etapa mais avancada quando o texto visivel contem mensagens antigas", () => {
    const text = `
Entao, voce concorda em ser atendido por mim aqui?
Sim, Clara!
Por favor, digite o numero do CPF, CNPJ do titular ou a unidade consumidora para o qual voce deseja atendimento.
`;

    expect(describeConversationIntent(text)).toBe("identifier_request");
  });

  it("usa a ocorrencia mais recente do historico visivel para decidir o estado", () => {
    const text = `
Agora voce me diz como prefere pagar, voce pode pagar com:
1. Pagar agora
2. Pagar com boleto
Ola
Entao, voce concorda em ser atendido por mim aqui?
Sim, Clara!
Por favor, digite o numero do CPF, CNPJ do titular ou a unidade consumidora para o qual voce deseja atendimento.
`;

    expect(describeConversationIntent(text)).toBe("identifier_request");
  });

  it("nao confunde validacao por cpf ou cnpj com pedido inicial de identificador", () => {
    const text = "Digite os 4 primeiros digitos do CPF ou CNPJ de quem e titular da conta.";

    expect(describeConversationIntent(text)).toBe("document_digits_request");
  });

  it("reconhece lista de faturas por opcao e referencia", () => {
    const text = `
Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.

1 - Referencia: 06/2026 - Valor: R$ 561,40 - Vencimento: 24/06/2026
`;

    expect(matchesAny(text, invoiceListPatterns)).toBe(true);
  });

  it("reconhece pagamento, validacao e erro dos digitos", () => {
    expect(matchesAny("Agora voce me diz como prefere pagar. 2. Pagar com boleto", paymentMethodPatterns)).toBe(true);
    expect(matchesAny("Digite os 4 primeiros digitos do CPF ou CNPJ", documentDigitsRequestPatterns)).toBe(true);
    expect(matchesAny("O numero digitado esta invalido. Vamos tentar de novo.", documentDigitsInvalidPatterns)).toBe(true);
  });

  it("reconhece pdf pronto e encerramento", () => {
    expect(matchesAny("Aqui esta a sua fatura. PDF - 164 KB", pdfReadyPatterns)).toBe(true);
    expect(matchesAny("Quer receber alguma outra conta?", moreInvoiceQuestionPatterns)).toBe(true);
    expect(matchesAny("Antes de encerrar, conte o que achou da nossa conversa. 5. Muito bom", ratingQuestionPatterns)).toBe(true);
    expect(matchesAny("Que bom! Fico muito feliz de te ajudar.", donePatterns)).toBe(true);
  });

  it("classifica respostas usadas na recuperacao do fluxo", () => {
    const text = "Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.";

    expect(matchesAny(text, conversationRecoveryPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("invoice_list");
  });
});
