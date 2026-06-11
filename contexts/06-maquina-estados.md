# 06 — Máquina de estados da conversa

A implementação deve ser orientada por estados, não por sequência fixa cega.

## Estados principais

```txt
INIT
WAITING_CONSENT
SEND_CONSENT
WAITING_IDENTIFIER_REQUEST
SEND_IDENTIFIER
WAITING_ACCOUNT_CONFIRMATION
CONFIRM_ACCOUNT
WAITING_INVOICE_SERVICE_OPTIONS
SELECT_SECOND_COPY
WAITING_DOCUMENT_LAST_DIGITS_REQUEST
SEND_LAST_DIGITS
WAITING_OPEN_INVOICES_LIST
SELECT_REFERENCE
WAITING_PDF
DOWNLOAD_PDF
WAITING_PIX_QUESTION
DECLINE_PIX
WAITING_MORE_INVOICE_QUESTION
DECLINE_MORE_INVOICE
WAITING_MORE_SUBJECT_QUESTION
DECLINE_MORE_SUBJECT
WAITING_RATING
SEND_RATING
DONE
ERROR
```

## Transições esperadas

### INIT → WAITING_CONSENT
Abrir conversa e enviar mensagem inicial se necessário.

### WAITING_CONSENT → SEND_CONSENT
Quando detectar:

```txt
concorda em ser atendido
```

Enviar/clicar:

```txt
Sim, Clara!
```

### WAITING_IDENTIFIER_REQUEST → SEND_IDENTIFIER
Quando detectar:

```txt
CPF
CNPJ
conta contrato
```

Enviar `identificador`.

### WAITING_ACCOUNT_CONFIRMATION → CONFIRM_ACCOUNT
Quando detectar:

```txt
Você confirma
```

Enviar/clicar:

```txt
Confirmo
```

### WAITING_INVOICE_SERVICE_OPTIONS → SELECT_SECOND_COPY
Quando detectar opções de fatura, clicar em:

```txt
Segunda via Fatura
```

Fallbacks:

```txt
Emitir Fatura
Fatura
```

### WAITING_DOCUMENT_LAST_DIGITS_REQUEST → SEND_LAST_DIGITS
Quando detectar:

```txt
quatro últimos números
últimos números
```

Enviar últimos 4 dígitos do CPF/CNPJ.

### WAITING_OPEN_INVOICES_LIST → SELECT_REFERENCE
Quando detectar:

```txt
Estas são as suas faturas em aberto
Referência:
```

Extrair opções via regex.

Regex sugerida:

```regex
(\d+)\s*-\s*Refer[eê]ncia:\s*(\d{2}\/\d{4})\s*-\s*Valor:\s*R\$\s*([\d.,]+)\s*-\s*Vencimento:\s*(\d{2}\/\d{2}\/\d{4})
```

Selecionar opção cujo mês/ano seja igual ao parâmetro da planilha.

### WAITING_PDF → DOWNLOAD_PDF
Quando detectar anexo PDF ou card de documento, baixar arquivo.

### WAITING_PIX_QUESTION → DECLINE_PIX
Quando detectar:

```txt
Código do Pix
copia e cola
```

Responder:

```txt
Não
```

### WAITING_MORE_INVOICE_QUESTION → DECLINE_MORE_INVOICE
Quando detectar:

```txt
Você deseja mais alguma fatura
```

Responder:

```txt
Não
```

### WAITING_MORE_SUBJECT_QUESTION → DECLINE_MORE_SUBJECT
Quando detectar:

```txt
Você quer falar sobre mais alguma coisa
```

Responder:

```txt
Não
```

### WAITING_RATING → SEND_RATING
Quando detectar:

```txt
Muito bom
Bom
Neutro
Ruim
Muito ruim
```

Responder:

```txt
5
```

## Tratamento de erro por estado
Cada estado deve ter timeout. Ao exceder timeout:

- salvar screenshot;
- salvar últimas mensagens capturadas;
- marcar status `timeout` ou `conversation_error`;
- seguir para próxima linha da planilha.

