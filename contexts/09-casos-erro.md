# 09 — Casos de erro e tratamento

## WhatsApp Web não autenticado
Sintoma:
- Tela mostra QR Code.

Ação:
- Pausar execução.
- Informar `authentication_required`.
- Não processar a fila.

## Contato não encontrado
Sintoma:
- Não consegue localizar `CEEE Grupo Equatorial`.

Ação:
- Marcar erro geral antes da fila.
- Orientar usuário a iniciar conversa manualmente com o contato.

## Identificador não encontrado
Sintoma:
- Bot da CEEE não encontra conta contrato/CPF/CNPJ.

Possíveis textos:

```txt
não encontrei
não localizei
não consegui encontrar
```

Ação:
- Marcar linha como `invalid_data`.

## Titular divergente
Sintoma:
- Nome retornado não bate com `nome_titular` da planilha.

MVP:
- Apenas logar divergência se `nome_titular` existir.
- Não bloquear automaticamente, a menos que `STRICT_HOLDER_NAME=true` seja implementado futuramente.

## Segunda via indisponível
Sintoma:
- Opção “Segunda via Fatura” aparece desabilitada ou não aparece.

Ação:
- Tentar opção “Código de Pagamento” somente se isso fizer sentido no fluxo futuro.
- No MVP, marcar como `conversation_error`.

## Fatura do mês não encontrada
Sintoma:
- Lista de faturas não contém `mes_referencia`.

Ação:
- Marcar como `not_found`.
- Salvar texto das faturas encontradas.

## PDF não enviado
Sintoma:
- Após selecionar referência, nenhum PDF aparece.

Ação:
- Aguardar timeout.
- Marcar como `download_error`.
- Salvar screenshot.

## Pergunta inesperada do bot
Sintoma:
- O bot da CEEE muda o fluxo.

Ação:
- Salvar screenshot.
- Salvar últimas mensagens.
- Marcar como `conversation_error`.

## Sessão travada entre uma UC e outra
Ação sugerida:
- Ao finalizar uma linha, encerrar fluxo respondendo `Não` nas perguntas finais.
- Aguardar delay.
- Só então iniciar próxima linha.

