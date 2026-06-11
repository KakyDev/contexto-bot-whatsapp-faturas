# 03 — Requisitos funcionais

## RF001 — Ler planilha de entrada
O sistema deve ler uma planilha `.xlsx` ou `.csv` contendo as UCs/documentos que serão processados.

Campos mínimos:

```txt
identificador
cpf_cnpj
uc
nome_titular
mes_referencia
```

Campos recomendados:

```txt
id
identificador
cpf_cnpj
uc
nome_titular
mes_referencia
empresa
status
arquivo_pdf
erro
tentativas
processado_em
```

Regras:

- `identificador` pode ser UC, CPF ou CNPJ.
- `cpf_cnpj` deve ser usado para extrair os últimos 4 dígitos.
- `mes_referencia` deve estar no formato `MM/YYYY`.

## RF002 — Processar uma linha por vez
O bot deve processar uma linha de cada vez, nunca em paralelo.

## RF003 — Abrir conversa no WhatsApp
O bot deve abrir o WhatsApp Web e localizar a conversa da CEEE Grupo Equatorial.

Configuração via `.env`:

```env
WHATSAPP_CONTACT_NAME="CEEE Grupo Equatorial"
```

## RF004 — Seguir fluxo de atendimento
O bot deve seguir o fluxo descrito em `02-fluxo-conversa.md`.

## RF005 — Reconhecer mensagens por padrões flexíveis
Não depender de texto 100% idêntico. Usar regex/palavras-chave.

Exemplos:

```txt
concorda em ser atendido
CPF, o CNPJ do titular ou a conta contrato
Você confirma
Segunda via Fatura
quatro últimos números
faturas em aberto
Referência:
Aguarde enquanto emito sua fatura
Código do Pix
mais alguma fatura
```

## RF006 — Selecionar fatura por mês/ano
O bot deve identificar a fatura com referência igual a `mes_referencia`.

Exemplo:

```txt
mes_referencia = 04/2026
```

Deve encontrar texto contendo:

```txt
Referência: 04/2026
```

Caso encontre, responder com o número da opção correspondente.

## RF007 — Baixar PDF
O bot deve detectar quando um PDF foi enviado, clicar para baixar e aguardar o arquivo aparecer na pasta de downloads.

## RF008 — Renomear PDF
Após download, renomear o arquivo para padrão:

```txt
{identificador}_{YYYY-MM}.pdf
```

Exemplo:

```txt
67709915000_2026-04.pdf
```

## RF009 — Registrar status
Após cada linha, registrar status em arquivo de saída.

Arquivo sugerido:

```txt
output/resultados.csv
```

Campos:

```txt
id
identificador
cpf_cnpj
uc
mes_referencia
status
arquivo_pdf
erro
tentativas
started_at
finished_at
```

## RF010 — Reprocessar falhas
O bot deve permitir reprocessar somente linhas com status de erro.

Exemplo de comando:

```bash
npm run start -- --input ./data/entrada.xlsx --retry-errors
```

## RF011 — Modo dry-run
Criar modo de teste que lê a planilha e valida dados, mas não abre o WhatsApp.

```bash
npm run dry-run
```

