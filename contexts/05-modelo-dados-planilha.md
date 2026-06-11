# 05 — Modelo de dados da planilha

## Entrada mínima

Arquivo: `data/entrada.xlsx`

Colunas obrigatórias:

```txt
identificador
cpf_cnpj
mes_referencia
```

## Entrada recomendada

```txt
id
identificador
uc
cpf_cnpj
nome_titular
mes_referencia
empresa
observacao
```

## Exemplo

```csv
id,identificador,uc,cpf_cnpj,nome_titular,mes_referencia,empresa,observacao
1,67709915000,67709915000,1234567895000,ALEXANDRE,04/2026,CEEE,Teste manual dos prints
```

## Regras de validação

### identificador
- Obrigatório.
- Pode conter somente números.
- Remover pontuação antes de enviar.

### cpf_cnpj
- Obrigatório para enviar os últimos 4 dígitos.
- Remover `.`, `/`, `-` e espaços.
- Extrair últimos 4 dígitos.

### mes_referencia
- Obrigatório.
- Formato aceito: `MM/YYYY`.
- Exemplo: `04/2026`.

## Saída

Arquivo: `output/resultados.csv`

Colunas:

```txt
id
identificador
uc
cpf_cnpj_mascarado
nome_titular
mes_referencia
status
arquivo_pdf
erro
tentativas
started_at
finished_at
```

## Status possíveis

```txt
pending
processing
success
not_found
invalid_data
authentication_required
conversation_error
download_error
timeout
skipped
```

