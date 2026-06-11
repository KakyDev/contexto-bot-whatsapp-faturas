# 10 — Prompt principal para o Codex

Use este prompt no Codex junto com os arquivos de contexto deste diretório.

---

Você é um desenvolvedor sênior Node.js/TypeScript. Crie um projeto completo chamado `whatsapp-invoice-bot` para automatizar via WhatsApp Web a coleta de faturas da CEEE Grupo Equatorial.

Leia todos os arquivos de contexto enviados antes de implementar.

## Objetivo
O bot deve:

1. Ler uma planilha `.xlsx` ou `.csv` com UCs/CPF/CNPJ e mês de referência.
2. Abrir o WhatsApp Web usando Playwright com perfil persistente.
3. Acessar a conversa `CEEE Grupo Equatorial`.
4. Seguir o fluxo do bot da CEEE para emitir segunda via de fatura.
5. Enviar UC/CPF/CNPJ.
6. Confirmar conta.
7. Escolher segunda via de fatura.
8. Enviar os 4 últimos dígitos do CPF/CNPJ.
9. Ler a lista de faturas em aberto.
10. Selecionar a fatura com referência igual ao mês/ano da planilha.
11. Baixar o PDF.
12. Renomear o PDF.
13. Registrar resultado em CSV.
14. Tratar erros com logs e screenshots.

## Requisitos técnicos
- Node.js + TypeScript.
- Playwright.
- XLSX para leitura da planilha.
- dotenv.
- zod para validação.
- pino para logs.
- vitest para testes unitários.

## Importante
- Delay mínimo de 5 segundos entre toda interação no WhatsApp.
- Não processar linhas em paralelo.
- Criar máquina de estados.
- Não depender de textos 100% exatos; usar matchers flexíveis.
- Salvar screenshots quando ocorrer erro.
- Criar `.env.example`.
- Criar README com instruções de instalação, login no WhatsApp Web e execução.

## Entregáveis esperados
- Projeto completo e executável.
- `package.json` com scripts:
  - `dev`
  - `start`
  - `dry-run`
  - `test`
  - `typecheck`
- Arquivos TypeScript organizados conforme `07-estrutura-projeto.md`.
- Testes para:
  - normalização de documento;
  - extração dos últimos 4 dígitos;
  - parser de faturas;
  - geração de nome do arquivo PDF.

## Comandos esperados

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run dev
```

## Critérios de aceite
- O projeto compila sem erro.
- O dry-run valida a planilha.
- O parser extrai corretamente faturas no formato:
  `1 - Referência: 04/2026 - Valor: R$ 605,96 - Vencimento: 05/05/2026`
- O bot usa delay configurável.
- O bot salva resultado por linha.
- O bot salva PDF em `output/invoices`.
- O bot salva screenshot em erro.

---

