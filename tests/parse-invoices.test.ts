import { describe, expect, it } from "vitest";
import { findInvoiceOption, latestInvoiceSelectionBlock, parseInvoices } from "../src/utils/parse-invoices.js";

describe("parseInvoices", () => {
  const text = `
Estas sao as suas faturas em aberto:
1 - Referencia: 04/2026 - Valor: R$ 605,96 - Vencimento: 05/05/2026
2 - Referencia: 05/2026 - Valor:R$ 700,10 - Vencimento: 05/06/2026
`;

  it("extrai faturas do texto do WhatsApp", () => {
    expect(parseInvoices(text)).toEqual([
      {
        option: "1",
        reference: "04/2026",
        value: "605,96",
        dueDate: "05/05/2026",
        raw: "1 - Referencia: 04/2026 - Valor: R$ 605,96 - Vencimento: 05/05/2026"
      },
      {
        option: "2",
        reference: "05/2026",
        value: "700,10",
        dueDate: "05/06/2026",
        raw: "2 - Referencia: 05/2026 - Valor:R$ 700,10 - Vencimento: 05/06/2026"
      }
    ]);
  });

  it("localiza a opcao por referencia", () => {
    expect(findInvoiceOption(text, "04/2026")?.option).toBe("1");
    expect(findInvoiceOption(text, "05/2026")?.option).toBe("2");
  });

  it("seleciona o numero correto quando existem varias referencias", () => {
    const ceeeText = `
Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.

1 - Referencia: 04/2026 - Valor: R$ 410,00 - Vencimento: 24/04/2026
2 - Referencia: 05/2026 - Valor: R$ 520,00 - Vencimento: 24/05/2026
3 - Referencia: 06/2026 - Valor: R$ 561,40 - Vencimento: 24/06/2026
`;

    expect(findInvoiceOption(ceeeText, "04/2026")?.option).toBe("1");
    expect(findInvoiceOption(ceeeText, "05/2026")?.option).toBe("2");
    expect(findInvoiceOption(ceeeText, "06/2026")?.option).toBe("3");
  });

  it("extrai a mensagem real da CEEE com pergunta antes da lista", () => {
    const ceeeText = `
Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.

1 - Referencia: 06/2026 - Valor:R$ 561,40 - Vencimento:
24/06/2026
`;

    expect(findInvoiceOption(ceeeText, "06/2026")).toMatchObject({
      option: "1",
      reference: "06/2026",
      value: "561,40",
      dueDate: "24/06/2026"
    });
  });

  it("aceita a palavra Referencia em negrito com o dois-pontos fora do markdown", () => {
    const ceeeText = `
Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.

1 - *Referencia*: 06/2026 - Valor: R$ 561,40 - Vencimento: 24/06/2026
`;

    expect(findInvoiceOption(ceeeText, "06/2026")?.option).toBe("1");
  });

  it("aceita listas da Evolution com numero e descricao em linhas separadas", () => {
    const ceeeText = `
Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.

1
*Referencia*: 06/2026 - *Valor:* R$ 561,40 - *Vencimento:* 24/06/2026
`;

    expect(findInvoiceOption(ceeeText, "06/2026")).toMatchObject({
      option: "1",
      reference: "06/2026",
      value: "561,40",
      dueDate: "24/06/2026"
    });
  });

  it("usa apenas o bloco mais recente quando ha listas antigas no historico", () => {
    const visibleHistory = `
Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.
1 - Referencia: 04/2026 - Valor: R$ 2602,40 - Vencimento: 10/06/2026
2 - Referencia: 02/2026 - Valor: R$ 2331,53 - Vencimento: 10/04/2026

Segunda via Fatura

Qual conta voce quer receber agora? E so digitar apenas o numero da opcao desejada.
1 - Referencia: 06/2026 - Valor: R$ 561,40 - Vencimento: 24/06/2026
`;

    const latestBlock = latestInvoiceSelectionBlock(visibleHistory);

    expect(parseInvoices(latestBlock)).toEqual([
      {
        option: "1",
        reference: "06/2026",
        value: "561,40",
        dueDate: "24/06/2026",
        raw: "1 - Referencia: 06/2026 - Valor: R$ 561,40 - Vencimento: 24/06/2026"
      }
    ]);
    expect(findInvoiceOption(latestBlock, "06/2026")?.option).toBe("1");
  });
});
