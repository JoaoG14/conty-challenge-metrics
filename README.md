## Nota para quem avalia

`src/metrics.ts` implementa a sincronização e a atualização dos snapshots. `test/sync.test.ts` verifica a idempotência, as janelas sobrepostas e os syncs simultâneos. `src/provider.ts` define o contrato e o provedor simulado; a regra de sincronização não depende dele ser falso. `test/retry.test.ts` e `test/api.test.ts` usam relógio controlado para verificar o instante do retry, os limites e o fluxo completo pela API.

Com mais tempo, implementaria:

- OAuth real
- Integração com as redes
- Paginação do provedor
- Autenticação da API
- Criptografia dos tokens
- Execução em fila

Defini o escopo e arquitetura e usei IA para implementar

Revisei as queries ao banco de dados em `src/metrics.ts` e `src/db.ts`

## Como rodar

Node 22 atualizado (22.13 ou superior).

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:3004`
O banco fica em `data/metrics.sqlite`

## Exemplo de Request e Response

Cadastre uma conexão já autorizada. As redes aceitas são `instagram`, `tiktok`, `youtube` e `x`. O token é fictício e não aparece nas respostas.

```bash
curl -s -X POST localhost:3004/connections \
  -H 'content-type: application/json' \
  -d '{"network":"instagram","account_id":"creator_01","token":"demo"}'
```

Resposta `201`:

```json
{
  "id": "<id retornado>",
  "network": "instagram",
  "account_id": "creator_01"
}
```

Copie o ID para `CONNECTION_ID`. A janela seleciona a data de publicação dos posts, com início inclusivo e fim exclusivo. As datas devem estar em UTC. Os exemplos usam as datas fixas do provedor simulado.

```bash
CONNECTION_ID="<id retornado>"

curl -s -X POST "localhost:3004/connections/$CONNECTION_ID/sync" \
  -H 'content-type: application/json' \
  -d '{"from":"2026-10-01T00:00:00.000Z","to":"2026-10-10T00:00:00.000Z"}'
```

Resposta `200` (ID e horário de busca são gerados pelo servidor):

```json
{
  "updated_posts": 2,
  "connection": {
    "id": "<id retornado>",
    "network": "instagram",
    "account_id": "creator_01",
    "last_sync_at": "2026-10-09T18:00:00.000Z"
  },
  "totals": { "posts": 2, "views": 1500, "likes": 150, "comments": 15 },
  "posts": [
    {
      "post_id": "post_01",
      "published_at": "2026-10-01T12:00:00.000Z",
      "captured_at": "2026-10-08T12:00:00.000Z",
      "fetched_at": "2026-10-09T18:00:00.000Z",
      "views": 1000,
      "likes": 100,
      "comments": 10
    },
    {
      "post_id": "post_02",
      "published_at": "2026-10-05T12:00:00.000Z",
      "captured_at": "2026-10-08T12:00:00.000Z",
      "fetched_at": "2026-10-09T18:00:00.000Z",
      "views": 500,
      "likes": 50,
      "comments": 5
    }
  ]
}
```

Repetir essa chamada retorna `updated_posts: 0` e os mesmos totais. Uma janela sobreposta também não soma o post de novo. Os comandos abaixo usam `jq` só para resumir a resposta:

```bash
curl -s -X POST "localhost:3004/connections/$CONNECTION_ID/sync" \
  -H 'content-type: application/json' \
  -d '{"from":"2026-10-05T00:00:00.000Z","to":"2026-10-12T00:00:00.000Z"}' \
  | jq '{updated_posts, totals}'
# {"updated_posts":0,"totals":{"posts":2,"views":1500,"likes":150,"comments":15}}

curl -s "localhost:3004/connections/$CONNECTION_ID/metrics" | jq
```

