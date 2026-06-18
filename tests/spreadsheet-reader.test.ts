import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { groupInvoiceJobs } from "../src/domain/invoice-job.js";
import { readSpreadsheet } from "../src/services/spreadsheet-reader.js";

describe("spreadsheet-reader", () => {
  it("le csv separado por ponto e virgula no layout CEEE", () => {
    const file = path.join(os.tmpdir(), `ceee-${Date.now()}.csv`);
    fs.writeFileSync(
      file,
      "codigo_venda;concessionaria;uc;cpf;4 ultimos;ref\n03B2FF9;CEEE Equatorial;32218567;56644663087;3087;01/05/2026\n",
      "utf8"
    );

    const [job] = readSpreadsheet(file);

    expect(job).toMatchObject({
      id: "03B2FF9_01-05-2026",
      codigoVenda: "03B2FF9",
      identificador: "32218567",
      uc: "32218567",
      cpfCnpj: "56644663087",
      documentLastDigits: "5664",
      mesReferencia: "05/2026",
      refOriginal: "01/05/2026",
      empresa: "CEEE Equatorial"
    });

    fs.unlinkSync(file);
  });

  it("usa coluna 4 primeiros quando informada", () => {
    const file = path.join(os.tmpdir(), `ceee-primeiros-${Date.now()}.csv`);
    fs.writeFileSync(
      file,
      "codigo_venda;concessionaria;uc;cpf;4 primeiros;ref\n03B2FF9;CEEE Equatorial;32218567;56644663087;1234;06/2026\n",
      "utf8"
    );

    const [job] = readSpreadsheet(file);

    expect(job.documentLastDigits).toBe("1234");

    fs.unlinkSync(file);
  });

  it("le multiplas linhas e normaliza a ref de cada registro", () => {
    const file = path.join(os.tmpdir(), `ceee-multi-${Date.now()}.csv`);
    fs.writeFileSync(
      file,
      [
        "codigo_venda;concessionaria;uc;cpf;4 ultimos;ref",
        "03B2FF9;CEEE Equatorial;32218567;56644663087;3087;06/2026",
        "99X1AA2;CEEE Equatorial;99999999;12345678901;8901;01/05/2026"
      ].join("\n"),
      "utf8"
    );

    const jobs = readSpreadsheet(file);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: "03B2FF9_06-2026",
      mesReferencia: "06/2026",
      refOriginal: "06/2026"
    });
    expect(jobs[1]).toMatchObject({
      id: "99X1AA2_01-05-2026",
      mesReferencia: "05/2026",
      refOriginal: "01/05/2026"
    });

    fs.unlinkSync(file);
  });

  it("diferencia registros com mesmo codigo_venda e referencias diferentes", () => {
    const file = path.join(os.tmpdir(), `ceee-duplicado-${Date.now()}.csv`);
    fs.writeFileSync(
      file,
      [
        "codigo_venda;concessionaria;uc;cpf;4 ultimos;ref",
        "03B2FF9;CEEE Equatorial;32218567;56644663087;3087;05/2026",
        "03B2FF9;CEEE Equatorial;32218567;56644663087;3087;06/2026"
      ].join("\n"),
      "utf8"
    );

    const jobs = readSpreadsheet(file);

    expect(jobs.map((job) => job.id)).toEqual(["03B2FF9_05-2026", "03B2FF9_06-2026"]);
    expect(jobs.map((job) => job.mesReferencia)).toEqual(["05/2026", "06/2026"]);

    fs.unlinkSync(file);
  });

  it("agrupa registros da mesma UC e codigo_venda mantendo os meses desejados", () => {
    const file = path.join(os.tmpdir(), `ceee-grupo-${Date.now()}.csv`);
    fs.writeFileSync(
      file,
      [
        "codigo_venda;concessionaria;uc;cpf;4 ultimos;ref",
        "03B2FF9;CEEE Equatorial;32218567;56644663087;3087;05/2026",
        "03B2FF9;CEEE Equatorial;32218567;56644663087;3087;06/2026",
        "99X1AA2;CEEE Equatorial;99999999;12345678901;8901;06/2026"
      ].join("\n"),
      "utf8"
    );

    const groups = groupInvoiceJobs(readSpreadsheet(file));

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      codigoVenda: "03B2FF9",
      uc: "32218567",
      mesesDesejados: ["05/2026", "06/2026"],
      mesesBaixados: [],
      mesesPendentes: ["05/2026", "06/2026"]
    });
    expect(groups[0].jobs.map((job) => job.id)).toEqual(["03B2FF9_05-2026", "03B2FF9_06-2026"]);

    fs.unlinkSync(file);
  });
});
