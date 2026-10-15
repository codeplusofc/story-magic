# Storyverse na VPS — Guia de publicação (deploy)

**Documento técnico de operação.**
Complementa `docs/HOSPEDAGEM_VPS.md` (o plano). Aqui é o **como fazer**.
Última atualização: 14/10/2026.

> Escopo deste guia: **Marco 1** — publicar o **site atual** na VPS, mantendo o Supabase,
> **sem tocar no backend**. O Marco 2 (backend próprio) acrescenta a API ao mesmo fluxo e
> será documentado depois.
>
> O que não foi confirmado aparece como **`(a confirmar)`**.

---

## 1. Visão geral do fluxo

O site do Storyverse é **estático** (o `npm run build` gera a pasta `dist/`). Por isso o
caminho mais econômico é **montar no GitHub** e enviar só o resultado para a VPS:

```
 git push (branch vps)                GitHub Actions                     VPS
 ────────────────────►  testa → builda dist/  ──►  rsync  ──►  /home/deploy/storyverse/web/current
                                                                          │
                                                             Caddy (borda) serve a pasta
                                                             e repassa /gutenberg*, /openlibrary*
```

Vantagens: a VPS **não gasta processador** montando o site (importante porque ela também
roda o Foodie) e o rollback é só trocar a pasta.

---

## 2. Pré-requisitos

| Item | Situação |
| --- | --- |
| VPS Hetzner `production-01` | já existe (`2.29.42.104`, Ubuntu 24.04, Docker + Compose) |
| Acesso SSH | usuário `deploy` (com `sudo`), a mesma mecânica do Foodie |
| Firewall | `ufw` libera **22, 80, 443** — nada a mudar |
| Repositório canônico | ramo/repo na organização `codeplusofc` com o Storyverse (**a definir**) |
| Supabase | **URL + chave anon** (públicas) para o Marco 1 |
| Node | 22 (mesma versão da CI do projeto) |

> Credenciais `service_role`/banco do Supabase e chaves de IA **não** são necessárias no
> Marco 1 — elas entram no Marco 2.

---

## 3. Estratégia de branch e repositório

- **Original `codeplusofc/story-magic` (main):** congela e **permanece no ar** para os
  usuários. **Nunca** publicar a VPS a partir dele.
- **Ramo/repo de trabalho (ex.: `vps`):** onde entra o desenvolvimento e de onde a VPS é
  publicada. Manter na organização do professor para revisão conjunta.
- O robô de publicação (seção 5) será disparado **apenas** por esse ramo, nunca por `main`.

---

## 4. Segredos

### No GitHub (Settings → Secrets and variables → Actions)

| Segredo | Para que serve | Observação |
| --- | --- | --- |
| `VPS_HOST` | IP/host da VPS | `2.29.42.104` |
| `VPS_USER` | usuário de deploy | `deploy` |
| `VPS_SSH_KEY` | chave privada de deploy | chave **nova**, só para este robô; a pública entra no `authorized_keys` do `deploy` |
| `VITE_SUPABASE_URL` | endereço do Supabase | entra no build |
| `VITE_SUPABASE_ANON_KEY` | chave pública do Supabase | **é pública** (vai no site), mas fica como secret por organização |
| `VITE_GROQ_API_KEY` | chat (1ª opção) | **até o Marco 2** fica no site; depois vai para o servidor |
| `VITE_GEMINI_API_KEY` | chat (2ª opção) | idem |
| `VITE_OPENROUTER_API_KEY` | chat (3ª opção) | idem |

> Todo valor com prefixo `VITE_` acaba **visível no navegador** — não são segredos de
> verdade. Ficam como secrets do GitHub só para não espalhar em texto no repositório.

### Na VPS (`/home/deploy/storyverse/deploy/.env`)

Só o necessário para o Caddy de borda (nomes de domínio) e, depois, o backend. **Nunca**
versionado.

---

## 5. O robô de publicação (GitHub Actions)

Arquivo: `.github/workflows/deploy-storyverse.yml`.

```yaml
name: Deploy Storyverse (VPS)

on:
  workflow_dispatch: {}          # botão manual no GitHub
  push:
    branches: [vps]              # só publica a partir do ramo de trabalho

permissions:
  contents: read

concurrency:
  group: deploy-storyverse
  cancel-in-progress: false      # nunca dois deploys ao mesmo tempo

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Instalar dependências
        run: npm ci

      - name: Testar
        run: npm test

      - name: Montar o site (build)
        env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
          VITE_GROQ_API_KEY: ${{ secrets.VITE_GROQ_API_KEY }}
          VITE_GEMINI_API_KEY: ${{ secrets.VITE_GEMINI_API_KEY }}
          VITE_OPENROUTER_API_KEY: ${{ secrets.VITE_OPENROUTER_API_KEY }}
        run: npm run build

      - name: Configurar chave SSH
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_deploy
          chmod 600 ~/.ssh/id_deploy
          ssh-keyscan -H "${{ secrets.VPS_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null

      - name: Enviar o build para a VPS
        run: |
          rsync -az --delete \
            -e "ssh -i ~/.ssh/id_deploy" \
            dist/ \
            "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}:/home/deploy/storyverse/_incoming/"

      - name: Publicar (troca a versão e confere)
        run: |
          ssh -i ~/.ssh/id_deploy \
            "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            'bash /home/deploy/storyverse/deploy/publish.sh'
```

### Script de publicação na VPS

Arquivo: `/home/deploy/storyverse/deploy/publish.sh` (fica fora do git se contiver
caminhos locais; pode ser versionado se não tiver segredo):

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE=/home/deploy/storyverse/web
IN=/home/deploy/storyverse/_incoming
URL=https://storyverse.2.29.42.104.sslip.io

# 1. guarda a versão atual (rollback) e promove a nova
rm -rf "$BASE/previous"
if [ -d "$BASE/current" ]; then mv "$BASE/current" "$BASE/previous"; fi
mv "$IN" "$BASE/current"
mkdir -p "$BASE/current"

# 2. confere que o site responde
code=$(curl -fsS -o /dev/null -w '%{http_code}' "$URL" || echo 000)
if [ "$code" != "200" ]; then
  echo "FALHOU: $URL respondeu $code. Revertendo."
  rm -rf "$BASE/current"
  mv "$BASE/previous" "$BASE/current"
  exit 1
fi
echo "OK: $URL respondeu 200"
```

> **Detalhe do rsync:** ele envia para `_incoming/`; o `publish.sh` move para `current/`.
> Assim, a troca é quase instantânea e o `previous/` guarda a versão anterior.

---

## 6. Caddy de borda (fase única, feita uma vez)

Hoje o **Caddy do Foodie** ocupa as portas 80/443. A decisão é ter **um Caddy de borda
dedicado** que atende **os dois** projetos — assim um deploy do Foodie não apaga a rota do
Storyverse. Isto substitui o perfil `public` do Foodie.

> ⚠️ **Isto mexe no Foodie.** Fazer com o Foodie já em estado saudável e ter o rollback à
> mão (seção 10). É a única etapa com risco cruzado.

### 6.1 Estrutura

```
/home/deploy/edge/
├── docker-compose.yml     (name: edge)
└── Caddyfile
```

### 6.2 `docker-compose.yml`

```yaml
name: edge

services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      FOODIE_DOMAIN: staging.2.29.42.104.sslip.io
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - /home/deploy/storyverse/web:/srv/storyverse:ro
      - edge_data:/data
      - edge_config:/config
    networks:
      - foodie
      - storyverse

networks:
  foodie:
    external: true
    name: foodie-staging_default
  storyverse:
    external: true
    name: storyverse_default

volumes:
  edge_data:
  edge_config:
```

### 6.3 `Caddyfile`

```caddyfile
# ── Foodie (staging) — mesmas rotas do Caddyfile atual ──────────────
staging.2.29.42.104.sslip.io,
cliente.2.29.42.104.sslip.io,
restaurante.2.29.42.104.sslip.io,
entregador.2.29.42.104.sslip.io,
admin.2.29.42.104.sslip.io {
    encode zstd gzip
    reverse_proxy foodie-staging-web-1:3001
}

api.staging.2.29.42.104.sslip.io {
    encode zstd gzip
    reverse_proxy foodie-staging-api-1:4001
}

# ── Storyverse (novo) ───────────────────────────────────────────────
storyverse.2.29.42.104.sslip.io {
    encode zstd gzip

    # proxies públicos que hoje o Vercel faz (mesmos destinos do vercel.json/vite.config.ts)
    handle /gutenberg-search* {
        rewrite * /ebooks/search.opds/
        reverse_proxy https://www.gutenberg.org
    }
    handle_path /gutenberg/* {
        reverse_proxy https://www.gutenberg.org
    }
    handle_path /gutenberg-mirror/* {
        reverse_proxy https://aleph.pglaf.org
    }
    handle_path /openlibrary/* {
        reverse_proxy https://openlibrary.org
    }
    handle_path /ol-covers/* {
        reverse_proxy https://covers.openlibrary.org
    }

    # site (arquivos estáticos) com fallback das telas internas (SPA)
    # O Caddy monta o diretório-pai `web/` e serve `web/current`.
    # Montar `current` diretamente quebra a troca atômica: o `mv` do publish.sh
    # substitui o diretório por outro inode e o contêiner continua servindo o antigo.
    handle {
        root * /srv/storyverse/current
        try_files {path} /index.html
        file_server
    }
}
```

> **Não usar `/gutenberg` sem barra** no matcher: ele capturaria `/gutenberg-mirror` e
> `/gutenberg-search` (o `vite.config.ts` já alerta sobre isso).

### 6.4 Ativar a borda (uma vez)

```bash
# 1. deixar o Foodie sem o Caddy próprio
cd /home/deploy/foodie-platform/deploy
docker compose --profile public down

# 2. subir a borda
cd /home/deploy/edge
docker compose up -d
docker compose logs --tail=50 caddy

# 3. conferir os dois projetos
curl -fsS -o /dev/null -w 'foodie=%{http_code}\n' https://staging.2.29.42.104.sslip.io
curl -fsS -o /dev/null -w 'storyverse=%{http_code}\n' https://storyverse.2.29.42.104.sslip.io
```

> **Caddyfile é bind de arquivo:** ao mudar o conteúdo, recriar o contêiner
> (`docker compose up -d --force-recreate caddy`); o `up -d` sozinho não recria.

---

## 7. Primeira publicação (passo a passo)

1. **VPS — criar a estrutura:**
   ```bash
   mkdir -p /home/deploy/storyverse/web/current \
            /home/deploy/storyverse/_incoming \
            /home/deploy/storyverse/deploy
   ```
2. **VPS — rede do Storyverse** (para o Caddy de borda encontrar o projeto):
   ```bash
   docker network create storyverse_default    # (a confirmar) nome final
   ```
3. **VPS — chave de deploy:** adicionar a **chave pública** correspondente ao segredo
   `VPS_SSH_KEY` em `~deploy/.ssh/authorized_keys`.
4. **GitHub — cadastrar os segredos** (seção 4).
5. **Supabase — autorizar o endereço** (seção 11).
6. **GitHub — rodar o workflow** `Deploy Storyverse (VPS)` (push no ramo `vps` ou o botão).
   O `dist/` chega em `_incoming/` e o `publish.sh` promove para `current/`.
7. **Subir a borda** (seção 6.4). O Caddy passa a servir `/srv/storyverse`.

---

## 8. Verificação

```bash
# site responde
curl -fsS -o /dev/null -w '%{http_code}\n' https://storyverse.2.29.42.104.sslip.io

# proxies funcionam (devem responder 200, não 404/CORS)
curl -fsS -o /dev/null -w 'gutenberg=%{http_code}\n' \
  "https://storyverse.2.29.42.104.sslip.io/gutenberg/cache/epub/1342/pg1342.txt"
curl -fsS -o /dev/null -w 'openlibrary=%{http_code}\n' \
  "https://storyverse.2.29.42.104.sslip.io/openlibrary/search.json?q=iracema"
```

No navegador: abrir o site, **criar conta/entrar**, abrir um livro, ver o chat responder e a
contagem de pessoas online.

---

## 9. Atualizações do dia a dia

```bash
# no PC: publicar o commit atual no ramo vps
git push origin vps
```

O robô testa, monta e envia. Para republicar o mesmo commit: botão **Run workflow** no
GitHub. Nada disso toca no Foodie.

---

## 10. Rollback

| Cenário | Ação |
| --- | --- |
| Site novo com defeito | `mv web/current web/broken; mv web/previous web/current` na VPS |
| Borda com defeito | `cd /home/deploy/edge && docker compose down`; no Foodie: `docker compose --profile public up -d` |
| Deploy travado | Reexecutar o workflow; o `concurrency` impede execuções simultâneas |

---

## 11. Configuração do Supabase (Marco 1)

No painel do Supabase, em **Authentication → URL Configuration**:

- **Site URL:** `https://storyverse.2.29.42.104.sslip.io`
- **Redirect URLs:** incluir `https://storyverse.2.29.42.104.sslip.io/**`

Sem isso, o link de confirmação de e-mail e a recuperação de senha voltam para o endereço
errado.

---

## 12. Resolução de problemas

| Sintoma | Causa provável |
| --- | --- |
| Site abre em branco | `dist/` não chegou a `current/`, ou `root` do Caddy aponta para pasta errada |
| Imagens de capa não carregam | proxy `/ol-covers/*` faltando ou com caminho errado |
| Busca/abertura de livro falha | proxy `/gutenberg*` faltando (CORS) |
| Login redireciona errado | Site URL/Redirect URLs do Supabase |
| `Caddyfile` novo não aplica | bind de arquivo — recriar o contêiner |
| Foodie fora do ar após criar a borda | perfil `public` do Foodie ainda ativo (conflito na 80/443) |

---

## 13. Banco próprio (stack `storyverse`)

O banco do Storyverse é um Postgres no stack `storyverse`, **sem portas publicadas**
(só visível na rede `storyverse_default`, onde a borda também está). Arquivos no
repositório em `deploy/storyverse/`; na VPS:

```
/home/deploy/storyverse/
├── docker-compose.yml     (stack: serviço db, projeto `storyverse`)
├── schema.sql             (cópia de database/schema.sql)
├── .env                   (POSTGRES_*; nunca versionado)
├── deploy/publish.sh      (site)
└── web/{current,previous} (site)
```

O `schema.sql` é aplicado **automaticamente no primeiro boot** (volume vazio). Para
reaplicar depois de atualizá-lo (o script é idempotente):

```bash
cd /home/deploy/storyverse
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -f /schema.sql
```

Conferir:

```bash
docker compose ps
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\dt public.*'
```

## 14. O que vem depois (Marco 2)

- O backend (Spring) entra como serviço `api` no stack `storyverse` (bloco comentado no
  `docker-compose.yml`); conecta em `db:5432` e nunca publica o banco no host.
- O Caddy de borda ganha o bloco `api.storyverse.…` apontando para esse serviço.
- O build da API passa pelo GitHub Actions → imagem no GHCR → a VPS faz `pull`.
- As chaves de IA saem do site e passam para o servidor.
- A migração dos dados (contas, progresso, diamantes, envios) vem do Supabase
  (`pg_dump` + Storage) — **Marco 3**.
