# 07 — Estrutura sugerida do projeto

```txt
whatsapp-invoice-bot/
├─ data/
│  ├─ entrada.xlsx
│  └─ exemplo.csv
├─ output/
│  ├─ invoices/
│  ├─ errors/
│  │  └─ screenshots/
│  └─ resultados.csv
├─ src/
│  ├─ app.ts
│  ├─ config/
│  │  └─ env.ts
│  ├─ domain/
│  │  ├─ invoice-job.ts
│  │  └─ invoice-status.ts
│  ├─ services/
│  │  ├─ spreadsheet-reader.ts
│  │  ├─ result-writer.ts
│  │  ├─ whatsapp-client.ts
│  │  ├─ ceee-conversation-bot.ts
│  │  ├─ pdf-downloader.ts
│  │  └─ logger.ts
│  ├─ utils/
│  │  ├─ delay.ts
│  │  ├─ normalize.ts
│  │  ├─ mask-document.ts
│  │  ├─ parse-invoices.ts
│  │  └─ file-name.ts
│  └─ cli.ts
├─ tests/
│  ├─ parse-invoices.test.ts
│  ├─ normalize.test.ts
│  └─ file-name.test.ts
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
```

## Responsabilidades

### spreadsheet-reader.ts
Ler `.xlsx` ou `.csv` e transformar em lista de jobs.

### result-writer.ts
Criar/atualizar `output/resultados.csv`.

### whatsapp-client.ts
Camada baixa do Playwright:

- abrir WhatsApp Web;
- localizar conversa;
- enviar mensagem;
- clicar em botão/opção;
- capturar últimas mensagens;
- baixar anexo;
- salvar screenshot.

### ceee-conversation-bot.ts
Orquestra a máquina de estados da conversa com a CEEE.

### pdf-downloader.ts
Detecta e salva PDF.

### parse-invoices.ts
Extrai lista de faturas a partir do texto do WhatsApp.
