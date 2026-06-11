# 02 — Fluxo de conversa esperado

Este arquivo descreve o fluxo observado nos prints da conversa com o bot da CEEE Grupo Equatorial.

## Fluxo base

### 1. Início da conversa
O bot deve abrir a conversa com a CEEE Grupo Equatorial no WhatsApp Web e enviar uma mensagem inicial simples, como:

```txt
Olá
```

ou apenas qualquer texto necessário para acionar o atendimento.

### 2. Aceite do atendimento
O bot da CEEE responde com uma mensagem parecida com:

```txt
Olá, eu sou a Clara, a assistente virtual da CEEE Grupo Equatorial 😊
...
Então, você concorda em ser atendido por mim aqui?
```

Opções exibidas:

```txt
Sim, Clara! 👍
Não 👎
```

A automação deve clicar/responder:

```txt
Sim, Clara! 👍
```

Fallback textual caso o botão não seja clicável:

```txt
Sim, Clara!
```

### 3. Envio da UC/CPF/CNPJ
O bot da CEEE solicita:

```txt
Por favor, digite o número do CPF, o CNPJ do titular ou a conta contrato para o qual você deseja atendimento.
```

A automação deve enviar o identificador da linha atual da planilha.

Exemplo:

```txt
67709915000
```

Esse campo pode ser UC, CPF ou CNPJ, conforme planilha.

### 4. Confirmação do titular
O bot responde algo como:

```txt
Achei!
Só pra confirmar: o seu atendimento será para a conta contrato que está em nome de ALEXANDRE.
Você confirma?
```

Opções:

```txt
Confirmo
Não confirmo
```

A automação deve responder/clicar:

```txt
Confirmo
```

### 5. Escolha de segunda via de fatura
O bot gera protocolo inicial e pergunta:

```txt
Opa, essa conta contrato possui 1 débito(s) a vencer no valor de R$605,96. Você gostaria de emitir a fatura de energia agora?
```

Opções possíveis:

```txt
Código de Pagamento
Segunda via Fatura
Agora não
```

A automação deve selecionar:

```txt
Segunda via Fatura
```

Observação: em alguns casos a opção pode vir desabilitada ou com outro texto. O bot deve tentar reconhecer variações:

- `Segunda via Fatura`
- `Segunda via de Fatura`
- `Emitir Fatura`
- `Fatura`

### 6. Confirmação dos últimos dígitos do documento
O bot solicita:

```txt
Para sua segurança e para garantir a sua privacidade, você pode me falar os quatro últimos números do seu CPF se for pessoa física ou CNPJ se for pessoa jurídica?
Por exemplo: 2346
```

A automação deve enviar os últimos 4 dígitos do CPF/CNPJ da planilha.

Exemplo:

```txt
5000
```

### 7. Leitura das faturas em aberto
O bot responde:

```txt
Estas são as suas faturas em aberto:

1 - Referência: 04/2026 - Valor: R$ 605,96 - Vencimento: 05/05/2026
```

Depois pergunta:

```txt
Por favor, me diga o número ou a referência (mês/ano) da fatura que você deseja pagar.
```

A automação deve localizar a fatura que bate com o campo `mes_referencia` da planilha.

Exemplo:

```txt
04/2026
```

Se existir, pode responder pelo número da opção ou pela referência. Preferência do MVP:

```txt
1
```

Se houver múltiplas faturas, selecionar a opção cujo texto contenha exatamente o mês/ano desejado.

### 8. Emissão e download do PDF
O bot responde:

```txt
Referência selecionada: 04/2026
Aguarde enquanto emito sua fatura ⏳
```

Depois envia um arquivo PDF com nome parecido com:

```txt
04/2026.pdf
```

A automação deve baixar o PDF e salvar em pasta local.

Nome sugerido:

```txt
{uc_ou_documento}_{referencia_yyyy_mm}.pdf
```

Exemplo:

```txt
67709915000_2026-04.pdf
```

### 9. Pergunta sobre código Pix
Após o PDF, o bot pergunta:

```txt
Essa fatura possui o Código do Pix (copia e cola). deseja visualizar?
```

Opções:

```txt
Sim
Não
```

A automação deve responder:

```txt
Não
```

### 10. Encerrar ou buscar mais faturas
O bot pergunta:

```txt
Você deseja mais alguma fatura?
Se não precisar mais de nenhum serviço, pode digitar sair.
```

Opções:

```txt
Emitir Fatura
Não
```

A automação deve responder:

```txt
Não
```

Depois:

```txt
Você quer falar sobre mais alguma coisa?
```

Responder:

```txt
Não
```

### 11. Pesquisa de satisfação
O bot pode enviar:

```txt
Antes de encerrar, você pode me contar o que achou da nossa conversa? É só digitar o número da sua opção.

5. Muito bom
4. Bom
3. Neutro
2. Ruim
1. Muito ruim
```

A automação pode responder:

```txt
5
```

## Delay obrigatório
Entre cada ação do nosso bot, aguardar pelo menos:

```txt
5000 ms
```

Esse delay deve ser configurável por `.env`.

