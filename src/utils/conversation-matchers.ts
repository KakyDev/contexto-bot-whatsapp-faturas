import { normalizeText } from "./normalize.js";

export const consentRequestPatterns = [
  /concorda/,
  /atendido por mim/,
  /posso te atender/,
  /assistente virtual/,
  /sim,\s*clara/,
  /ola,\s*eu sou a clara/
];

export const identifierRequestPatterns = [
  /conta contrato/,
  /unidade consumidora/,
  /\buc\b/,
  /cpf.*cnpj.*unidade consumidora/,
  /digite.*numero/,
  /informe.*numero/
];

export const identifierRejectedPatterns = [
  /informacao nao esta correta/,
  /parece que essa informacao nao esta correta/,
  /vamos tentar novamente/
];

export const accountConfirmationPatterns = [
  /voce confirma/,
  /so pra confirmar/,
  /so para confirmar/,
  /atendimento sera para/,
  /em nome de/,
  /conta contrato atual/
];

export const invoiceServicePatterns = [
  /sobre o que voce gostaria de falar hoje/,
  /segunda via/,
  /emitir.*fatura/,
  /fatura de energia/,
  /debito.*vencer/,
  /gostaria de emitir/,
  /codigo de barras para pagamento/,
  /consulta de debitos/
];

export const documentDigitsPrimeirosPatterns = [
  /4 primeiros/,
  /quatro primeiros/,
  /primeiros digitos/,
  /primeiros numeros/
];

export const documentDigitsUltimosPatterns = [
  /4 ultimos/,
  /quatro ultimos/,
  /ultimos digitos/,
  /ultimos numeros/
];

export const birthDateRequestPatterns = [
  /data de nascimento/,
  /data de nascimento de quem e titular/,
  /digite.*data de nascimento/,
  /informe.*data de nascimento/,
  /formato dd\/mm\/aaaa/,
  /dd\/mm\/aaaa/
];

export const rgDigitsRequestPatterns = [
  /4 primeiros digitos do rg/,
  /quatro primeiros digitos do rg/,
  /digitos do rg/,
  /validacao de seguranca/
];

export const documentDigitsRequestPatterns = [
  ...documentDigitsPrimeirosPatterns,
  ...documentDigitsUltimosPatterns,
  ...birthDateRequestPatterns,
  ...rgDigitsRequestPatterns,
  /cpf ou cnpj/,
  /validacao de seguranca/
];

export const documentDigitsInvalidPatterns = [
  /numero digitado.*invalido/,
  /digitado esta invalido/,
  /vamos tentar de novo/
];

export const invoiceListPatterns = [
  /qual conta voce quer receber/,
  /opcao desejada/,
  /referencia:\s*\d{2}\/\d{4}/,
  /faturas em aberto/,
  /\d+\s*-\s*referencia/
];

export const paymentMethodPatterns = [
  /como prefere pagar/,
  /pagar agora/,
  /pagar boleto/,
  /pagar com boleto/,
  /codigo de barras/,
  /pagar com pix/,
  /como voce prefere/
];

export const pdfReadyPatterns = [
  /aqui esta a sua fatura/,
  /com o pagar com boleto/,
  /voce pode baixar a sua fatura/,
  /vamos la/,
  /\.pdf/,
  /\bpdf\b/
];

export const invalidDataPatterns = [
  /nao encontrei/,
  /nao localizei/,
  /nao consegui encontrar/,
  /tentar de novo.*erro de digitacao/,
  /pode ter sido um erro de digitacao/
];

export const noOpenDebtsPatterns = [
  /voce nao possui debitos faturados em aberto/,
  /nao possui debitos faturados em aberto/
];

export const suspendedSupplyQuestionPatterns = [
  /fornecimento de energia esta suspenso/,
  /fornecimento.*suspenso/,
  /falha de energia provocou/,
  /esse e sobre esse assunto que voce deseja falar/
];

export const unsupportedSubjectPatterns = [
  /poxa.*ainda nao consigo te ajudar.*assunto por aqui/,
  /nao consigo te ajudar com esse assunto por aqui/,
  /central de atendimento.*0800\s*721\s*2333/,
  /conheca tambem o site da equatorial ceee/
];

export const pixQuestionPatterns = [/codigo do pix/, /copia e cola/];
export const moreInvoiceQuestionPatterns = [/receber alguma outra conta/, /deseja mais alguma fatura/, /outra conta/];
export const moreSubjectQuestionPatterns = [/quer falar sobre mais alguma coisa/, /mais alguma coisa/];
export const ratingQuestionPatterns = [
  /muito bom/,
  /neutro/,
  /muito ruim/,
  /o que achou da nossa conversa/,
  /antes de encerrar/,
  /voce pode me contar/,
  /contar.*atendimento/,
  /pesquisa/
];
export const donePatterns = [/que bom.*feliz.*ajudar/, /fico muito feliz.*ajudar/];
export const finalGoodbyePatterns = [/tchau/, /ate a proxima/, /agradecemos seu contato/, /obrigada por compartilhar/];

export const conversationRecoveryPatterns = [
  ...invalidDataPatterns,
  ...noOpenDebtsPatterns,
  ...suspendedSupplyQuestionPatterns,
  ...unsupportedSubjectPatterns,
  ...consentRequestPatterns,
  ...identifierRequestPatterns,
  ...accountConfirmationPatterns,
  ...invoiceServicePatterns,
  ...documentDigitsRequestPatterns,
  ...documentDigitsInvalidPatterns,
  ...invoiceListPatterns,
  ...paymentMethodPatterns,
  ...pdfReadyPatterns,
  ...pixQuestionPatterns,
  ...moreInvoiceQuestionPatterns,
  ...moreSubjectQuestionPatterns,
  ...ratingQuestionPatterns,
  ...donePatterns,
  ...finalGoodbyePatterns
];

export function matchesAny(text: string, patterns: RegExp[]): boolean {
  const normalized = normalizeText(text);
  return patterns.some((pattern) => pattern.test(normalized));
}

export function isPedindoPrimeiros(text: string): boolean {
  return matchesAny(text, documentDigitsPrimeirosPatterns);
}

export function isPedindoUltimos(text: string): boolean {
  return matchesAny(text, documentDigitsUltimosPatterns);
}

export function isPedindoDataDeNascimento(text: string): boolean {
  return matchesAny(text, birthDateRequestPatterns);
}

export function isPedindoRg(text: string): boolean {
  return matchesAny(text, rgDigitsRequestPatterns);
}

export function describeConversationIntent(text: string): string {
  const normalized = normalizeText(text);
  const candidates: Array<{ intent: string; patterns: RegExp[]; priority: number }> = [
    { intent: "invalid_data", patterns: invalidDataPatterns, priority: 100 },
    { intent: "no_open_debts", patterns: noOpenDebtsPatterns, priority: 99 },
    { intent: "suspended_supply_question", patterns: suspendedSupplyQuestionPatterns, priority: 98 },
    { intent: "unsupported_subject", patterns: unsupportedSubjectPatterns, priority: 98 },
    { intent: "done", patterns: [...donePatterns, ...finalGoodbyePatterns], priority: 95 },
    { intent: "rating_question", patterns: ratingQuestionPatterns, priority: 90 },
    { intent: "more_subject_question", patterns: moreSubjectQuestionPatterns, priority: 85 },
    { intent: "more_invoice_question", patterns: moreInvoiceQuestionPatterns, priority: 80 },
    { intent: "pix_question", patterns: pixQuestionPatterns, priority: 75 },
    { intent: "pdf_ready", patterns: pdfReadyPatterns, priority: 70 },
    { intent: "payment_method", patterns: paymentMethodPatterns, priority: 65 },
    { intent: "invoice_list", patterns: invoiceListPatterns, priority: 60 },
    { intent: "document_digits_invalid", patterns: documentDigitsInvalidPatterns, priority: 55 },
    { intent: "document_digits_request", patterns: documentDigitsRequestPatterns, priority: 50 },
    { intent: "invoice_service_options", patterns: invoiceServicePatterns, priority: 45 },
    { intent: "account_confirmation", patterns: accountConfirmationPatterns, priority: 40 },
    { intent: "identifier_request", patterns: identifierRequestPatterns, priority: 35 },
    { intent: "consent_request", patterns: consentRequestPatterns, priority: 30 }
  ];
  let best: { intent: string; index: number; priority: number } | undefined;

  for (const candidate of candidates) {
    for (const pattern of candidate.patterns) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const globalPattern = new RegExp(pattern.source, flags);
      for (const match of normalized.matchAll(globalPattern)) {
        const index = match.index ?? -1;
        if (index < 0) continue;
        if (!best || index > best.index || (index === best.index && candidate.priority > best.priority)) {
          best = { intent: candidate.intent, index, priority: candidate.priority };
        }
      }
    }
  }

  return best?.intent ?? "unknown";
}
