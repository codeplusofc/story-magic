# Storyverse na VPS — Plano de hospedagem

**Documento de negócios e técnico.**
Público: Guilherme Pinheiro (dono do produto) e quem opera a infraestrutura.
Última atualização: 14/10/2026.

> **Como ler este documento.** As seções 1 a 5 explicam a situação **sem pressupor
> conhecimento de infraestrutura**. As seções 6 em diante entram no plano técnico,
> que é a base para a execução. Fato não confirmado aparece como **`(a confirmar)`**.

---

## 1. Resumo executivo

O Storyverse (internamente `story-magic`) é hoje um aplicativo que **não tem servidor
próprio**. Ele é montado como site (na **Vercel**) e usa um "backend de terceiros" no
modelo **Supabase** para contas, banco de dados, arquivos e presença online. As chaves de
inteligência artificial ficam no navegador.

O objetivo deste plano é **trazer o Storyverse para o nosso próprio servidor (VPS)** que já
existe e hoje roda o **Foodie**, deixando de depender de Vercel e Supabase. Fazemos isso
**sem parar de atender quem já usa** o app e **sem perder dados** de quem já criou conta,
marca páginas ou importou livros.

Isso será feito **em etapas**, com o app atual no ar o tempo todo. Só no final, com o
ambiente novo testado e os dados migrados, apontamos o domínio definitivo e aposentamos os
serviços antigos.

**Em uma frase:** vamos construir a "casa nova" (no nosso servidor) ao lado da "casa
atual" (Vercel + Supabase), mudar a mobília com cuidado (dados e contas) e só então
entregar a chave.

---

## 2. O que é o Storyverse

Um app de **leitura interativa**: enquanto a pessoa lê um livro, os personagens conversam
com ela num chat ao lado do texto. O acervo vem do Project Gutenberg (obras em domínio
público), e o app também permite **importar livros** (.epub, .pdf, .txt) e **sugerir livros
para um acervo comunitário** (com moderação).

Além da leitura: contas e login, sincronização entre aparelhos, ranking semanal, carteira
de "diamantes", presença (quantas pessoas online), PWA instalável e offline.

---

## 3. Onde ele funciona hoje (a "casa atual")

Sem servidor próprio, o app se apoia em dois serviços na nuvem:

| Peça | Nome | O que faz, em linguagem simples |
|---|---|---|
| **Site** | **Vercel** | Publica a parte visual (o site) e cria "atalhos" (proxies) para o Project Gutenberg e a Open Library |
| **Contas** | **Supabase Auth** | Cadastro, login e sessão (o "quem é você") |
| **Banco de dados** | **Supabase (Postgres)** | Guarda envios da comunidade, progresso de leitura, ranking, diamantes |
| **Arquivos** | **Supabase Storage** | Guarda textos enviados, fotos de perfil e livros importados |
| **Tempo real** | **Supabase Realtime** | Mostra quantas pessoas estão online |
| **Regras de negócio** | **Supabase (SQL + RLS)** | As "traves" que decidem quem pode ver e mudar o quê (RLS) e as funções (diamantes, ranking, moderação) |
| **Inteligência artificial** | **Groq / Gemini / OpenRouter** | O chat com os personagens; hoje as chaves ficam **no navegador** |

Um ponto central: no Storyverse, **"o servidor" é o Supabase**. O navegador conversa
**direto** com ele (contas, banco, arquivos, tempo real). Não há um programa de backend
"nosso" no meio.

> **Importante:** existe no repositório um projeto de backend em Java (`story-magic-api/`),
> mas ele é apenas um **esqueleto** — hoje só serve catálogo de livros, texto do Gutenberg e
> busca na Open Library. Ele **não** faz login, banco ou arquivos, e **não está conectado**
> ao site. Ou seja, "reescrever o backend" significa **construir o que o Supabase faz hoje**.

---

## 4. O que queremos e por quê

**Objetivo:** hospedar o Storyverse inteiro na **nossa VPS**, sem depender de Vercel e
Supabase.

Motivos (negócio):

- **Controle e independência** — o app deixa de depender de serviços de terceiros, das
  regras e dos limites deles.
- **Custo** — a VPS já está contratada para o Foodie; aproveitamos a mesma máquina.
- **Aprendizado** — o projeto vira uma plataforma completa (front, back, banco, deploy),
  útil como portfólio e para a disciplina.
- **Consistência** — o Storyverse passa a seguir o mesmo modelo do Foodie, que já é
  autohospedado.

**Não-objetivo (neste momento):** não vamos criar funcionalidades novas do produto; o foco é
**migrar** a mesma experiência para o nosso servidor.

---

## 5. Conceitos, em linguagem simples

Antes do plano técnico, um "dicionário vivo" que usaremos no documento.

| Termo | Em linguagem simples |
|---|---|
| **Servidor / VPS** | Um computador ligado 24h na internet, alugado, onde os programas ficam rodando. "VPS" = servidor privado virtual. |
| **Docker / contêiner** | Uma "caixinha" que empacota um programa com tudo o que ele precisa. Cada caixinha roda isolada das outras. |
| **Frontend** | A parte que aparece no navegador (a tela). No Storyverse, é o site em React/Vite. |
| **Backend** | O programa do servidor que guarda e serve os dados, checa quem pode o quê. |
| **Banco de dados** | Onde os dados ficam guardados de forma organizada. Aqui, o Postgres. |
| **Storage** | O "armário de arquivos" (textos, fotos, livros). |
| **Tempo real** | Informação que aparece na hora, sem recarregar (ex.: "3 pessoas online"). |
| **DNS / domínio** | O "endereço" na internet (ex.: `meusite.com`). O DNS é a "agenda" que traduz o endereço no número do servidor (IP). |
| **TLS / certificado** | O "cadeado" do navegador (HTTPS), que criptografa a conexão. |
| **Proxy** | Um "intermediário" que repassa pedidos para outro destino (usado para driblar bloqueios de origem). |
| **CI/CD** | "Automação de entrega": quando o código sobe para o GitHub, robôs testam e publicam sozinhos. |
| **Supabase** | Um serviço de terceiros que embrulha várias peças (contas, banco, arquivos, tempo real) num pacote só. |
| **Vercel** | Um serviço de terceiros que publica sites e funções. |

---

## 6. A "casa nova": como fica na VPS

A VPS que já existe (Hetzner, `production-01`, Ubuntu 24.04) roda hoje o **Foodie**. O
Storyverse vai morar na **mesma máquina**, mas **isolado** do Foodie — como dois
apartamentos no mesmo prédio: dividem a estrutura, mas cada um tem suas chaves, seus móveis
e sua porta.

```
                        Internet
                            │
                 ┌──────────┴───────────┐
                 │   Caddy (porta 80/443)│   ← a "portaria" do prédio
                 │   (proxy de borda)    │      recebe os acessos e entrega
                 └──────────┬───────────┘      a cada apartamento pelo endereço
             ┌──────────────┴──────────────┐
             │                             │
      ┌──────┴──────┐               ┌──────┴───────┐
      │  Foodie     │               │  Storyverse  │
      │ (no ar hoje)│               │  (novo)      │
      │             │               │              │
      │ • site      │               │ • site       │
      │ • api Java  │               │ • api Java   │
      │ • banco     │               │ • Postgres   │
      └─────────────┘               └──────────────┘
```

- **Caddy** é a "portaria": é o único programa que ocupa as portas públicas (80/443) e
  entrega cada acesso ao apartamento certo, pelo nome (endereço).
- Cada projeto (Foodie, Storyverse) tem seu **conjunto de contêineres**, sua **rede** e seus
  **volumes de dados**, separados.
- O **único recurso compartilhado** é a própria máquina (processador, memória, disco).
- O **firewall** atual (que deixa passar só SSH, HTTP e HTTPS) continua valendo — nada a
  mudar.

### Endereços (temporários, para desenvolvimento)

Enquanto desenvolvemos, usamos endereços gratuitos do tipo `sslip.io`, que apontam sozinhos
para o IP `2.29.42.104`:

- Site: `storyverse.2.29.42.104.sslip.io`
- API (backend): `api.storyverse.2.29.42.104.sslip.io`

Quando estiver tudo pronto, podemos registrar um domínio próprio e apontar para a VPS.

---

## 7. Onde o trabalho vive (repositório e automação)

**Repositório (o "caderno do projeto").** O código do Storyverse está no GitHub, na
organização do professor (`codeplusofc/story-magic`). O plano:

- O repositório **original permanece no ar** para os usuários, **congelado** (sem
  desenvolvimento novo durante a migração).
- O desenvolvimento novo acontece **na mesma organização**, num **ramo/banco de código
  dedicado** (ex.: um ramo `vps` ou um repositório novo em `codeplusofc`), para manter o
  professor no circuito e permitir revisão.
- Existe também um repositório vazio (`codeplusofc/story-magic-api`) criado para o backend.
  A decisão é **concentrar tudo em `story-magic`** (onde o esqueleto do backend já vive) e
  **excluir o repositório vazio**, evitando confusão.

**Automação (o "robô de entrega").** O processo será o mesmo modelo já usado no Foodie:
quando o código é enviado ao GitHub, um **robô do GitHub Actions** testa e publica na VPS.

```
  Você escreve           GitHub               Robô (Actions)            VPS
  ───────────           ───────              ──────────────           ─────
  git push     ──────►   guarda o código  ──►  testa e monta o  ──────►  coloca no ar
                                              site / a imagem          (site + api)
```

Para o Storyverse há uma vantagem: o **site é estático** (é só uma pasta de arquivos
prontos). Então o robô pode **montar o site no GitHub** e enviar só o resultado para a VPS,
**sem gastar o processador dela** — importante porque ela também roda o Foodie.

---

## 8. O plano em marcos

### Marco 1 — O site atual no ar pela VPS (mantendo o Supabase)

**O que é:** colocamos na VPS **o site do Storyverse exatamente como está hoje**, apontando
para o Supabase atual. É o primeiro teste de que a VPS, o endereço e a automação funcionam.

**O que muda no produto:** nada. Mesma tela, mesmas contas.

**O que é preciso:**
- Uma cópia do repositório na VPS (clone) que o robô mantém atualizada.
- No montador do site, as variáveis do Supabase (endereço + chave pública) e as chaves de IA.
- No Caddy, as "regras" que hoje o Vercel faz: servir o site, tratar as telas internas e
  repassar os pedidos ao Project Gutenberg / Open Library.
- No painel do Supabase, autorizar o novo endereço (`storyverse.…`) como endereço válido
  para login e recuperação de senha.

**Resultado:** o Storyverse abre em `storyverse.2.29.42.104.sslip.io`, com login e leitura
funcionando, **sem tocar no backend**. É a "mudança de casa" do site, ainda usando os
serviços antigos por trás.

### Marco 2 — O backend próprio (substituindo o Supabase)

**O que é:** construímos o "servidor" que o Supabase fazia, item por item. Cada parte é
ligada ao site à medida que fica pronta.

| Ordem | Parte | O que substitui |
|---|---|---|
| 1 | **Contas** | Supabase Auth (login, cadastro, senha) |
| 2 | **Dados** | Progresso, envios da comunidade |
| 3 | **Regras** | Diamantes, ranking, moderação |
| 4 | **Arquivos** | Os três "armários" (textos, fotos, livros importados) |
| 5 | **Tempo real** | Contagem de pessoas online |
| 6 | **IA** | Chamadas de chat, agora feitas pelo **servidor** (chaves fora do navegador) |

**Decisão técnica importante (que economiza muito trabalho):** as regras que já existem no
banco (diamantes, ranking, moderação — cerca de **790 linhas de SQL**, 20 funções) **serão
reaproveitadas**, não reescritas. Elas continuam no banco e o backend apenas as chama. A
única adaptação é um pequeno "tradutor" que informa ao banco **qual usuário** está pedindo —
necessário porque, antes, quem informava isso era o Supabase.

### Marco 3 — O corte (virar a chave)

**O que é:** com o ambiente novo **testado e igual**, migramos os dados e apontamos o
endereço definitivo. Só então aposentamos Vercel e Supabase.

**Sem pressa:** o app atual fica no ar **até o fim**. Nada de "desligar um para ligar o
outro".

---

## 9. O que acontece com quem já usa o app

Esta é a preocupação mais justa: **as pessoas que já testaram não podem perder a
experiência.**

**Durante todo o desenvolvimento (Marcos 1 e 2): impacto ZERO.** O app atual continua no ar,
no mesmo endereço, funcionando normalmente.

**No momento do corte (Marco 3),** o que acontece:

| Item | O que acontece | Garantia |
|---|---|---|
| Conta, progresso, marcações, livros importados **na nuvem** | **Migrados** para o banco novo | `pg_dump` do banco + cópia dos arquivos **antes** de virar |
| **Sessão** (login atual) | Precisa **entrar de novo** no endereço novo | Login normal; nada é perdido |
| Dados **só do aparelho** (cache de tradução, capas, posição ainda não sincronizada) | Não atravessam a troca de endereço | A maioria volta pela conta; o resto é cache descartável |
| Endereço antigo (Vercel) | Só é desligado depois de tudo validado | Rede de segurança mantida |

**Resumo:** com os dados migrados, o usuário entra no endereço novo e encontra tudo. A única
inconveniência real é **fazer login novamente**.

---

## 10. O que precisamos e quem faz o quê

**Do professor (dono do projeto):**
- Acesso ao projeto **Supabase** (para copiar os dados e as contas) — o mais importante.
- As **chaves de IA** (Groq/Gemini/OpenRouter) para configurar no servidor.
- O serviço de **e-mail** usado no cadastro (SMTP), para confirmação e recuperação de senha.
- Concordância em **congelar o desenvolvimento** no repositório original durante a migração.
- Permissão para criar o ramo/repositório de desenvolvimento na organização `codeplusofc`.

**Do lado técnico (com apoio de IA):**
- Todo o trabalho de infraestrutura, automação e construção do backend.
- A documentação de operação (como subir, atualizar e recuperar).

**Decisões conjuntas:** confirmar o objetivo de "independência total" (self-host) e o
cronograma dos marcos.

---

## 11. Custos e recursos

- **Sem custo novo de servidor:** usamos a VPS já contratada (Hetzner).
- **Recursos (estimativa):** o Storyverse deve consumir cerca de **0,5 a 0,9 GB de memória**
  em uso normal (backend + banco), cabendo na máquina atual junto do Foodie. Os **picos**
  são na hora de montar o código (build), por isso o site será montado **fora da VPS**.
- **Quando precisaria crescer:** só se o uso aumentar muito ou se outros projetos entrarem.
  Aí, a opção é **subir o tipo da máquina** na Hetzner (mais memória/núcleos/disco), o que é
  feito no painel, sem reinstalar nada.

---

## 12. Riscos e como tratamos

| Risco | Mitigação |
|---|---|
| Perder dados de quem usa | Migração com cópia do banco **e** dos arquivos, testada antes; original no ar até o fim |
| A migração quebrar o app atual | Desenvolvimento **isolado**; o ambiente atual não é tocado |
| Uma "portaria" (Caddy) derrubar o Foodie | A portaria será dedicada e revisada; o Foodie entra como um dos apartamentos, sem mudança de comportamento |
| Todo o tráfego de e-mail depender do provedor errado | SMTP próprio configurado e testado antes do corte |
| Chaves de IA expostas no navegador | No Marco 2 elas passam para o **servidor** |
| Confusão de endereços/projetos | Um apartamento por projeto, com nome e rede próprios; registrado na documentação |

---

## 13. Perguntas frequentes

**O app vai ficar fora do ar em algum momento?**
Não. O plano é feito para o app atual continuar no ar até o ambiente novo estar pronto.

**Vou precisar pagar mais?**
Não. Usamos a mesma VPS. Só haveria custo se precisássemos de uma máquina maior.

**O que o professor precisa fazer?**
Passar os acessos (Supabase, IA, e-mail) e concordar em congelar o repositório original.

**Por que não "só migrar o banco"?**
Porque o app não fala com o banco diretamente — ele usa os serviços do Supabase (contas,
arquivos, tempo real). Migrar "só o banco" não bastaria; seria preciso o backend ou o
Supabase inteiro.

**E se der errado no meio?**
O ambiente atual permanece intacto até o corte. Reverter é possível a qualquer momento antes
de apontar o endereço definitivo.

---

## 14. Glossário rápido

- **VPS:** servidor ligado 24h (Hetzner, aqui).
- **Docker/contêiner:** caixinha que empacota um programa.
- **Caddy:** "portaria" que recebe os acessos e distribui; cuida do cadeado (HTTPS).
- **Frontend / Backend:** tela / servidor.
- **Postgres:** banco de dados.
- **Supabase / Vercel:** serviços de terceiros usados hoje.
- **CI/CD:** robô que testa e publica automaticamente.
- **Migração:** copiar os dados da "casa antiga" para a nova.

---

## 15. Próximos passos

1. Revisar e aprovar este documento (professor + responsável técnico).
2. Reunir os acessos do Supabase, das chaves de IA e do e-mail.
3. Executar o **Marco 1** (site atual na VPS, mantendo Supabase e sem tocar no backend).
4. Construir o **backend** (Marco 2), parte por parte.
5. Planejar e executar o **corte** (Marco 3), sem pressa.

> Documentos complementares a produzir durante a execução:
> `docs/DEPLOY_VPS.md` (passo a passo de publicação) e `docs/RUNBOOK_VPS.md`
> (operação do dia a dia: subir, atualizar, diagnosticar, recuperar).
