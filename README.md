# Storyverse

**Leia o livro. Converse com quem vive nele.**

Storyverse é uma plataforma de leitura interativa: enquanto a pessoa lê um livro, os personagens da história acompanham o ritmo dela e conversam num chat ao lado do texto. Cada personagem tem voz e personalidade próprias, sabe em que ponto da leitura o leitor está e não revela o que vem depois.

Desenvolvido por **Guilherme Pinheiro**.

---

## Contexto

A leitura de clássicos costuma ser solitária, e muita gente desiste no meio. O Storyverse aposta que conversar com os personagens (perguntar para a Isaura se ela tem medo do Leôncio, provocar o Sherlock Holmes, ouvir o Drácula) torna a leitura mais envolvente e dá motivo para seguir para o próximo capítulo.

O acervo vem do [Project Gutenberg](https://www.gutenberg.org): mais de 70 mil livros em domínio público, gratuitos e legais para distribuir. O foco do público é **romance, terror e vampiros**, com prioridade para livros **em português**.

## Funcionalidades

- **Estante em destaque**, dividida em seções: *Em português*, *Terror e vampiros* e *Mais clássicos*. Todos os livros têm personagens escritos à mão.
- **Busca no acervo inteiro do Gutenberg**, com filtro por idioma (português, inglês ou todos).
- **Leitura por capítulos**, com seletor de capítulo, barra de progresso, modo noturno ou sépia e quatro tamanhos de letra.
- **Chat com os personagens**, com troca de personagem, sugestões de perguntas para começar e animação de "digitando".
- **Personagens gerados por IA** para qualquer livro do acervo que não esteja nos destaques.
- **Importar meu livro** (.epub, .pdf ou .txt): o arquivo é lido e guardado só no navegador do leitor (IndexedDB), sem servidor e sem IA. Os personagens podem ser digitados na importação; em branco, a IA sugere o elenco ao abrir o livro. Livros com DRM e PDFs escaneados (sem texto) não abrem.
- **Layout responsivo**: no celular, o chat vira um painel deslizante aberto por um botão flutuante.

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Interface | React 18 + TypeScript |
| Build e servidor de desenvolvimento | Vite 5 |
| Hospedagem | Vercel (site estático + rewrites) |
| Catálogo de livros | Busca do próprio [gutenberg.org](https://www.gutenberg.org) (feed OPDS), pelo mesmo proxy dos textos |
| Texto dos livros | Project Gutenberg, via proxy (`/gutenberg` e `/gutenberg-mirror`) |
| IA principal | [Groq](https://console.groq.com) (`openai/gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b`) |
| IA de reserva | [Google Gemini](https://aistudio.google.com) (`gemini-3.5-flash-lite`, `gemini-flash-lite-latest`) |
| IA de reserva opcional | [OpenRouter](https://openrouter.ai) |
| Fontes | Literata (leitura) e Plus Jakarta Sans (interface), do Google Fonts |

Não há backend, nem banco de dados, nem bibliotecas de interface. Todo o estado fica no navegador.

### Estrutura

```
src/
├── App.tsx                 Telas (estante, busca, leitura e chat) e estado da sessão
├── App.css / index.css     Estilos e temas (noturno e sépia)
├── data/
│   ├── types.ts            Tipos: Ebook, StoryCharacter, HeroDemo
│   └── ebooks.ts           Curadoria: livros em destaque, personagens e sugestões do acervo
└── lib/
    ├── gutenberg.ts        Busca no catálogo do Gutenberg, download e limpeza do texto, capas
    ├── chapters.ts         Divisão do texto em capítulos
    ├── ai.ts               Chat, cadeia de provedores de IA e geração de personagens
    ├── cast.ts             Elenco do livro (escrito à mão, digitado pelo leitor, em cache ou gerado pela IA)
    ├── importBook.ts       Leitura de .epub (fflate), .pdf (pdf.js, carregado sob demanda) e .txt
    ├── localBooks.ts       Livros importados guardados no IndexedDB do navegador
    ├── readingContext.ts   Trecho do livro perto da posição de leitura
    └── readingAmbient.ts   Mensagens automáticas ao trocar e ao passar do meio do capítulo
```

## Regras de negócio

### Leitura
- O leitor **só lê e conversa**. A IA **nunca** escreve nem altera a história: o texto exibido é sempre o original, completo.
- Somente obras em **domínio público** entram no acervo. Livros com direitos autorais exigem autorização por escrito do autor ou da editora.
- O texto é baixado do Gutenberg quando o leitor abre o livro. Os livros não ficam guardados no repositório.
- O cabeçalho e o rodapé de licença do Gutenberg e as marcações de ilustração são removidos. O conteúdo em si nunca é cortado.
- As preferências de leitura (tema e tamanho da letra) ficam salvas no navegador.

### Divisão em capítulos
Como cada livro do Gutenberg marca os capítulos de um jeito, o app tenta três padrões, em ordem:
1. `CHAPTER I`, `Chapter 1.`, `CAPITULO I`, `Capítulo 3`
2. Numeral romano seguido de título: `I. A SCANDAL IN BOHEMIA`
3. Numeral romano sozinho na linha: `I`, `II.`, comum nos livros em português

Regras complementares:
- Títulos seguidos de menos de 1.000 caracteres são tratados como **sumário** e ignorados.
- Nos padrões 1 e 2, títulos que se repetem mais adiante também são descartados como sumário. No padrão 3 não, porque livros divididos em partes recomeçam a numeração.
- O texto antes do primeiro capítulo vira **"Abertura"** (se tiver mais de 300 caracteres). Se for menor, entra no primeiro capítulo.
- Capítulos com mais de 45 mil caracteres são divididos em partes, como "Capítulo X (1/2)", sempre entre parágrafos.
- Livros sem nenhuma marcação são divididos em "Parte 1, 2, 3…" de cerca de 25 mil caracteres.

### Personagens
- **Livros em destaque** têm personagens escritos à mão em `ebooks.ts`: nome, papel, cor, personalidade e saudação na voz do personagem.
- **Livros do acervo** têm os personagens sugeridos pela IA **uma única vez**, a partir do título, do autor e do início do texto. O resultado fica guardado no navegador, sem nova chamada.
- Se a IA estiver indisponível, entra um **Narrador** genérico, que não é salvo para que a IA tente de novo depois.
- Os personagens sempre respondem em **português do Brasil**, em primeira pessoa, com 2 a 4 frases, mesmo quando o livro está em inglês.
- **Sem spoilers:** o personagem não revela acontecimentos posteriores ao trecho em que o leitor está.
- O personagem manda mensagens automáticas ao trocar de capítulo e uma única vez ao passar do meio do capítulo (42% da rolagem).

### Consumo de IA
As mensagens são enxutas para render mais nas cotas gratuitas:

| Regra | Valor |
|---|---|
| Histórico enviado | últimas **10** mensagens, cada uma cortada em 600 caracteres |
| Trecho do livro enviado | **2.000** caracteres em volta da posição de leitura |
| Tamanho da resposta | **250** tokens (mais 200 de folga para modelos que raciocinam) |
| Mensagem do leitor | até **500** caracteres |
| Geração de personagens | **500** tokens, uma vez por livro |

**Cadeia de reservas:** o app tenta Groq → Gemini → OpenRouter, modelo por modelo. Cada modelo tem cota própria, então as cotas se somam. Se um modelo responde **429** (limite estourado), ele fica pausado por 60 segundos, ou pelo tempo que a API indicar, e o próximo é usado. Qualquer outra falha também passa para o próximo modelo.

**Modo demonstração:** sem nenhuma chave configurada, o chat funciona com respostas prontas, para testar a interface sem gastar tokens.

## Como rodar

Pré-requisito: Node.js 18 ou mais recente.

```bash
npm install
cp .env.example .env   # e preencha as chaves
npm run dev
```

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `VITE_GROQ_API_KEY` | uma das chaves | Chave do Groq (`gsk_...`) |
| `VITE_GROQ_MODELS` | não | Modelos do Groq em ordem de preferência, separados por vírgula |
| `VITE_GEMINI_API_KEY` | uma das chaves | Chave do Google AI Studio |
| `VITE_GEMINI_MODEL` | não | Modelos do Gemini em ordem de preferência |
| `VITE_OPENROUTER_API_KEY` | não | Chave do OpenRouter (reserva extra) |
| `VITE_OPENROUTER_MODELS` | não | Modelos do OpenRouter (os gratuitos terminam em `:free`) |

O Vite só lê o `.env` ao iniciar: depois de alterar o arquivo, reinicie o `npm run dev`.

### Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento, com o proxy do Gutenberg |
| `npm run build` | Checagem de tipos (`tsc`) e build de produção em `dist/` |
| `npm run preview` | Serve o build de produção localmente, também com o proxy |

## Deploy (Vercel)

1. Cadastre as variáveis de ambiente em **Settings → Environment Variables** (tipo **Config**, porque o prefixo `VITE_` torna o valor público).
2. Faça o push para a `main`: o Vercel gera o build automaticamente.
3. Se mudar alguma variável, faça **Redeploy**, porque os valores entram no site na hora do build.

O `vercel.json` redireciona `/gutenberg/*` para o gutenberg.org e `/gutenberg-mirror/*` para o espelho oficial `aleph.pglaf.org`, já que os arquivos de texto do Gutenberg não liberam acesso direto pelo navegador (CORS).

## Limitações conhecidas

- **As chaves de IA ficam visíveis no navegador.** O prefixo `VITE_` inclui os valores no JavaScript do site. Antes de abrir para o público, o ideal é mover as chamadas para uma função serverless no Vercel, com a chave privada e limite de mensagens por usuário.
- **Cotas gratuitas:** no Groq, cada modelo aceita cerca de 1.000 mensagens por dia e 8.000 tokens por minuto. Com três modelos, isso dá cerca de 3.000 mensagens por dia e uns 12 envios por minuto no total.
- **Busca do Gutenberg:** responde em cerca de 2 segundos, mas a relevância é a do próprio site ("poe" também encontra livros de poemas) e o total de resultados só aparece quando cabe numa página.
- **Pouco terror em português:** o Gutenberg não tem traduções de livros de vampiro ou terror em português (as traduções modernas têm direitos autorais). A seção de terror usa o texto em inglês, com o chat em português.
- **Tradução dos livros em inglês:** não usa IA nem chave. No Chrome e no Edge de desktop, usa o tradutor embutido do navegador. Nos outros navegadores e no celular, usa o Google Tradutor público (não oficial: pode limitar ou mudar sem aviso) e, se ele recusar, o MyMemory, que libera só ~5 mil caracteres por dia para cada leitor. A qualidade é de tradutor automático.
- **Só Project Gutenberg por enquanto:** histórias próprias ou de autores parceiros ainda não são suportadas.

## Próximos passos

- Função serverless no Vercel para esconder as chaves e limitar mensagens por usuário.
- Suporte a histórias próprias e de autores parceiros (arquivos `.txt` no projeto).
- Painel de administração para cadastrar livros e personagens sem novo deploy.
- Botão "Peça uma história" para medir o que o público quer ler.

---

Textos em domínio público do [Project Gutenberg](https://www.gutenberg.org). Desenvolvido por **Guilherme Pinheiro**.
