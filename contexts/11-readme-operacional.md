# 11 — README operacional para o MVP

## Como o time deve usar

1. Preencher a planilha `entrada.xlsx`.
2. Abrir o computador dedicado.
3. Rodar o bot.
4. Fazer login no WhatsApp Web se solicitado.
5. Acompanhar logs.
6. Conferir PDFs em `output/invoices`.
7. Conferir resultado em `output/resultados.csv`.

## Cuidados operacionais

- Não usar o WhatsApp manualmente enquanto o bot estiver rodando.
- Não processar grandes volumes no primeiro teste.
- Começar com 1 UC real.
- Depois testar 5 UCs.
- Depois testar 20 UCs.
- Somente após estabilidade, aumentar volume.

## Recomendações de teste

### Teste 1 — Login
Validar se o bot abre WhatsApp Web e encontra o contato.

### Teste 2 — Uma UC
Processar uma única UC que tenha fatura aberta no mês informado.

### Teste 3 — Fatura inexistente
Processar uma UC sem fatura do mês para validar status `not_found`.

### Teste 4 — Documento inválido
Processar identificador inválido para validar `invalid_data`.

### Teste 5 — Lote pequeno
Processar 5 linhas seguidas.

## Pontos de atenção

- WhatsApp Web pode mudar a interface.
- O bot da CEEE pode mudar textos ou opções.
- A sessão pode cair.
- Download de PDF pode demorar.
- O fluxo pode mudar caso a UC tenha mais de uma fatura ou nenhuma fatura.

