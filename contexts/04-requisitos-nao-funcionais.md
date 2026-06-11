# 04 — Requisitos não funcionais

## RNF001 — Delay entre ações
Toda ação enviada ao WhatsApp deve respeitar delay mínimo de 5 segundos.

Configuração:

```env
BOT_ACTION_DELAY_MS=5000
```

## RNF002 — Timeouts
Cada etapa deve ter timeout configurável.

Sugestão:

```env
BOT_STEP_TIMEOUT_MS=60000
PDF_DOWNLOAD_TIMEOUT_MS=120000
```

## RNF003 — Logs detalhados
Registrar logs com:

- UC/documento atual.
- Etapa atual.
- Mensagens recebidas relevantes.
- Ação enviada.
- Erros.
- Caminho do PDF salvo.

## RNF004 — Evidências de erro
Quando falhar, salvar screenshot da tela.

Pasta:

```txt
output/errors/screenshots
```

Nome sugerido:

```txt
{identificador}_{YYYY-MM}_{timestamp}.png
```

## RNF005 — Execução local
O MVP deve rodar em um computador dedicado com navegador persistente.

## RNF006 — Sessão persistente do WhatsApp Web
Usar perfil persistente do navegador para evitar login com QR Code a cada execução.

Exemplo Playwright:

```ts
chromium.launchPersistentContext('./.browser-profile', { headless: false })
```

## RNF007 — Segurança dos dados
Não expor CPF/CNPJ em logs completos. Preferir mascaramento:

```txt
***5000
```

No arquivo de resultado interno pode manter o identificador caso seja necessário operacionalmente.

## RNF008 — Robustez contra mudança de texto
O bot da CEEE pode mudar pequenos textos. Por isso, criar funções de matcher flexíveis.

## RNF009 — Não executar em paralelo
Não processar múltiplas conversas simultaneamente no mesmo WhatsApp.

## RNF010 — Observabilidade mínima
Ao final, exibir resumo:

```txt
Total: 100
Sucesso: 87
Não encontradas: 5
Erros: 8
```

