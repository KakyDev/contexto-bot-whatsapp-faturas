import { describe, expect, it } from "vitest";
import { invoicePdfFileName, invoicePdfFileNameForJob, referenceToYearMonth } from "../src/utils/file-name.js";

describe("file-name", () => {
  it("converte referencia MM/YYYY para YYYY-MM", () => {
    expect(referenceToYearMonth("04/2026")).toBe("2026-04");
  });

  it("gera nome padrao do PDF", () => {
    expect(invoicePdfFileName("67709915000", "04/2026")).toBe("67709915000_2026-04.pdf");
  });

  it("gera nome com codigo de venda e referencia da fatura", () => {
    expect(
      invoicePdfFileNameForJob({
        id: "03B2FF9",
        codigoVenda: "03B2FF9",
        identificador: "32218567",
        uc: "32218567",
        cpfCnpj: "56644663087",
        cpfPrimeiros4: "5664",
        cpfUltimos4: "3087",
        documentLastDigits: "3087",
        nomeTitular: "",
        mesReferencia: "05/2026",
        refOriginal: "01/05/2026",
        dataDeNascimento: "",
        empresa: "CEEE Equatorial",
        observacao: ""
      })
    ).toBe("03B2FF9_05-2026.pdf");
  });
});
