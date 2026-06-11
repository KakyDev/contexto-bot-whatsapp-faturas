# WhatsApp Invoice Bot

MVP em Node.js/TypeScript para coletar faturas da CEEE Grupo Equatorial via WhatsApp Web, lendo uma planilha de entrada e salvando PDFs/resultados localmente.

## Instalação

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

No Windows PowerShell, se `cp` não estiver disponível:

```powershell
Copy-Item .env.example .env
```

## Entrada

Arquivo padrão: `data/entrada.xlsx`.

O CSV operacional esperado tambem pode ser usado, separado por ponto e virgula:

```csv
codigo_venda;concessionaria;uc;cpf;4 ultimos;ref
03B2FF9;CEEE Equatorial;32218567;56644663087;3087;01/05/2026
```

Mapeamento usado pelo bot:

```txt
codigo_venda -> id da linha e nome do PDF
uc -> identificador enviado ao bot da CEEE
cpf -> documento usado como fallback dos 4 ultimos digitos
4 ultimos -> digitos enviados na confirmacao de seguranca
ref -> referencia original do arquivo; DD/MM/YYYY vira MM/YYYY para selecionar a fatura
```

O formato antigo ainda e aceito com `identificador`, `cpf_cnpj` e `mes_referencia`.

Também é aceito `.csv`, por exemplo:

```bash
npm run dry-run -- --input ./data/exemplo.csv
```

## Execução

Validar a planilha sem abrir WhatsApp:

```bash
npm run dry-run -- --input ./data/entrada.xlsx
```

Executar o bot:

```bash
npm run dev -- --input ./data/entrada.xlsx
```

Por padrao, o bot usa o modo terminal com `whatsapp-web.js`, sem automacao visual por clique. Na primeira execucao, escaneie o QR Code exibido no terminal.

Para usar a Evolution API, configure no `.env`:

```env
EVOLUTION_API_URL="http://localhost:8080"
EVOLUTION_API_KEY="sua-chave"
EVOLUTION_INSTANCE="sua-instancia"
```

Depois execute:

```bash
npm run dev -- --transport evolution --input ./data/entrada.xlsx
```

Esse modo usa a API para enviar mensagens, consultar as respostas e baixar o PDF recebido, sem depender do DOM do WhatsApp Web.

```bash
npm run dev:terminal -- --input ./data/entrada.xlsx
```

Para usar o modo antigo com navegador/Playwright:

```bash
npm run dev:browser -- --input ./data/entrada.xlsx
```

Reprocessar somente linhas que já saíram com erro em `output/resultados.csv`:

```bash
npm run dev -- --input ./data/entrada.xlsx --retry-errors
```

## Login no WhatsApp Web

No modo terminal, o bot usa sessao persistente em `./.whatsapp-terminal-auth`. Na primeira execucao, escaneie o QR Code no terminal. Depois disso, a sessao tende a permanecer salva.

No modo navegador, o bot usa perfil persistente em `./.browser-profile`. Na primeira execução, faça login no WhatsApp Web com o QR Code no navegador aberto pelo Playwright. Depois disso, a sessão tende a permanecer salva.

Se a tela estiver em QR Code quando a fila começar, o processamento é interrompido com status `authentication_required`.

## Contato do atendimento

O bot abre a conversa pelo numero configurado em `.env`:

```env
WHATSAPP_CONTACT_PHONE="+55 51 3382-5500"
```

Internamente, esse valor e convertido para `555133825500` e usado na URL do WhatsApp Web.

## Saídas

PDFs:

```txt
C:\Users\lex-t\Downloads\Bot CEEE\{codigo_venda}_{ref}.pdf
```

Exemplo para `codigo_venda=03B2FF9` e `ref=01/05/2026`:

```txt
C:\Users\lex-t\Downloads\Bot CEEE\03B2FF9_01-05-2026.pdf
```

Resultados:

```txt
output/resultados.csv
```

Screenshots de erro:

```txt
output/errors/screenshots
```

## Scripts

```bash
npm run dev
npm run start
npm run dry-run
npm run test
npm run typecheck
npm run build
```

## Cuidados

Não use o WhatsApp manualmente enquanto o bot estiver rodando. Comece com uma UC real, depois 5, depois 20, e só aumente volume depois de estabilidade.
