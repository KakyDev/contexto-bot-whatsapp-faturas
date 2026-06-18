import { describe, expect, it } from "vitest";
import {
  accountConfirmationPatterns,
  consentRequestPatterns,
  conversationRecoveryPatterns,
  describeConversationIntent,
  documentDigitsInvalidPatterns,
  documentDigitsRequestPatterns,
  donePatterns,
  identifierRejectedPatterns,
  identifierRequestPatterns,
  invoiceListPatterns,
  matchesAny,
  moreInvoiceQuestionPatterns,
  noOpenDebtsPatterns,
  paymentMethodPatterns,
  pdfReadyPatterns,
  ratingQuestionPatterns,
  suspendedSupplyQuestionPatterns,
  unsupportedSubjectPatterns
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

  it("reconhece rejeicao da UC com nova solicitacao de CPF/CNPJ ou UC", () => {
    const text = `
Parece que essa informacao nao esta correta.
Vamos tentar novamente!
Por favor, digite o numero do CPF, CNPJ ou Unidade Consumidora
`;

    expect(matchesAny(text, identifierRejectedPatterns)).toBe(true);
    expect(matchesAny(text, identifierRequestPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("identifier_request");
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

  it("reconhece menu de pagamento com botao pagar boleto", () => {
    const text = `
Posso te enviar essa conta por aqui ou te mando um link do site pra pagar no cartao debito/credito.
Voce tambem pode optar pelo Pix copia e cola ou posso te enviar o codigo de barras e voce paga no seu banco. Como prefere?
Pagar boleto
Pagar com cartao
Pagar com codigo
`;

    expect(matchesAny(text, paymentMethodPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("payment_method");
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

  it("reconhece mensagem de assunto fora do fluxo", () => {
    const text = `
Poxa, eu ainda nao consigo te ajudar com esse assunto por aqui.

Pra isso, voce pode acessar o nosso site ou falar com alguem do nosso time pela Central de Atendimento:
0800 721 2333
`;

    expect(matchesAny(text, unsupportedSubjectPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("unsupported_subject");
  });

  it("reconhece menu geral de servicos como opcoes de segunda via", () => {
    const text = `
Sobre o que voce gostaria de falar hoje? Lembrando que no momento ofereco os servicos de:
Falta de Energia,
Codigo de Barra para Pagamento,
Consulta de Debitos,
Segunda via de Fatura.
`;

    expect(describeConversationIntent(text)).toBe("invoice_service_options");
  });

  it("reconhece pergunta de fornecimento suspenso para escolher outro assunto", () => {
    const text = `
O seu fornecimento de energia esta suspenso e por isso nao consigo abrir uma Falta de Energia pra voce.
Mas, nesses casos, o recomendado e pedir uma Religacao.
E sobre este assunto que voce deseja falar?
Religacao
Outro assunto
`;

    expect(matchesAny(text, suspendedSupplyQuestionPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("suspended_supply_question");
  });

  it("reconhece ausencia de debitos faturados em aberto", () => {
    const text = `
Voce nao possui debitos faturados em aberto.
Lembrando que eu nao mostro valores ainda nao faturados por aqui.

Voce quer falar sobre mais alguma coisa?
`;

    expect(matchesAny(text, noOpenDebtsPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("more_subject_question");
  });

  it("nao trata aviso de valores nao faturados como ausencia de debitos", () => {
    const text = `
Opa, essa unidade consumidora possui 1 debito(s) a vencer.
Lembrando que eu nao mostro valores ainda nao faturados por aqui.
Segunda via Fatura
`;

    expect(matchesAny(text, noOpenDebtsPatterns)).toBe(false);
    expect(describeConversationIntent(text)).toBe("invoice_service_options");
  });

  it("reconhece mensagem do site da Equatorial como recuperacao por ponto", () => {
    const text = "Conheca tambem o site da Equatorial CEEE:";

    expect(matchesAny(text, unsupportedSubjectPatterns)).toBe(true);
    expect(describeConversationIntent(text)).toBe("unsupported_subject");
  });

  it("prioriza pergunta de mais assunto quando mensagem do site tambem aparece", () => {
    const text = `
Conheca tambem o site da Equatorial CEEE:
https://ceee.equatorialenergia.com.br
Voce quer falar sobre mais alguma coisa?
`;

    expect(describeConversationIntent(text)).toBe("more_subject_question");
  });
});
