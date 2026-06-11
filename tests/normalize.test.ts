import { describe, expect, it } from "vitest";
import { getLastDocumentDigits, normalizeDigits, normalizeText } from "../src/utils/normalize.js";
import { maskDocument } from "../src/utils/mask-document.js";

describe("normalize", () => {
  it("remove pontuacao de documentos", () => {
    expect(normalizeDigits("12.345.678/9500-0")).toBe("1234567895000");
  });

  it("extrai os ultimos 4 digitos", () => {
    expect(getLastDocumentDigits("123.456.789-50")).toBe("8950");
  });

  it("normaliza texto para matchers flexiveis", () => {
    expect(normalizeText("Você confirma?")).toBe("voce confirma?");
  });

  it("mascara documento nos logs/resultados", () => {
    expect(maskDocument("1234567895000")).toBe("***5000");
  });
});
