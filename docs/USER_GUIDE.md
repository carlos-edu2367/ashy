# Guia do Usuário — Ashy 1.0 (Marco M5 — Release 1.0)

Bem-vindo ao guia oficial de uso da **Ashy 1.0**. A Ashy é uma companheira virtual *local-first* projetada para construir, preservar e expressar uma **história compartilhada** com você ao longo do tempo — em texto, voz em tempo real, vídeo/visão autorizada e presença 2D no desktop — mantendo quem ela é mesmo quando você troca o modelo de inteligência artificial por trás dela.

---

## Sumário

1. [Primeiro Boot & Wizard de Onboarding (`Zero-to-First-Conversation`)](#1-primeiro-boot--wizard-de-onboarding-zero-to-first-conversation)
2. [O Estúdio (`Cozy Night Studio`), Conversa em Texto e Voz & `SeriousnessGate`](#2-o-estúdio-cozy-night-studio-conversa-em-texto-e-voz--seriousnessgate)
3. [Governança de Memórias FSRS-6 (`Memórias`)](#3-governança-de-memórias-fsrs-6-memórias)
4. [Nossa História, Piadas Internas (`CooldownLock`), Quarto da Ashy & *Dream & Reflection*](#4-nossa-história-piadas-internas-cooldownlock-quarto-da-ashy--dream--reflection)
5. [Palco Universal 2D, Modo Overlay Transparente, Bandeja do Sistema e os 6 Atalhos Globais](#5-palco-universal-2d-modo-overlay-transparente-bandeja-do-sistema-e-os-6-atalhos-globais)
6. [Portabilidade da Alma (`.ashy-soul`), Criptografia em Repouso (`AES-256-GCM`) & Apagar Tudo com 1 Clique (Factory Reset)](#6-portabilidade-da-alma-ashy-soul-criptografia-em-repouso-aes-256-gcm--apagar-tudo-com-1-clique-factory-reset)
7. [Modo ao vivo (chamada)](#7-modo-ao-vivo-chamada)

---

## 1. Primeiro Boot & Wizard de Onboarding (`Zero-to-First-Conversation`)

Ao iniciar a Ashy pela primeira vez em uma instalação limpa (ou logo após um *Factory Reset*), o banco local `ashy.db` parte de um estado **100% real e sem dados fictícios**. Como ainda não existe o marco autobiográfico `first_meeting`, o aplicativo abre automaticamente o **Wizard de Primeiro Encontro (`FirstMeetingWizard` — `Zero-to-First-Conversation`)**.

### Passo a passo no Wizard

1. **Como ela deve te chamar:**
   - Informe seu nome ou apelido preferido. Esse valor será usado pela Ashy nas conversas e registrado no seu perfil local.

2. **Escolha do Modo de Inteligência (Local Omni vs. Cloud / Modular):**
   - **Modo 1 — Local Omni Unificado (`LFM3-Omni-2B` Recomendado):** Configura com 1 clique o modelo multimodal local **`lfm3-omni:2b`** (`http://127.0.0.1:11434` via Ollama ou `http://127.0.0.1:8080/v1` via `llama-server`), capaz de ouvir sua voz diretamente em 16kHz, enxergar câmera/tela autorizada e responder com voz nativa em 24kHz (`LiquidCodec`) e texto simultaneamente, com `reasoningEffort: 'none'` (`think: false`) para latência instantânea.
     *Isso configura o modelo do **chat**. A conversa por voz contínua é o Modo ao vivo, que usa o seu próprio motor local gerenciado pela Ashy (llama.cpp); pelo Ollama a voz é ASR → texto → TTS no fim do turno, não fala→fala. Ver [§7](#7-modo-ao-vivo-chamada).*
   - **Modo 2 — Nuvem ou Modular (`OpenRouter`, `OpenAI`, `Anthropic`, `NVIDIA NIM`, `Ollama`):** Permite escolher o provedor, informar a chave de API (armazenada com criptografia nativa do sistema operacional via `safeStorage`), pesquisar dinamicamente o catálogo de modelos (`GET /v1/models` ou `/api/tags`) e escolher o nível de raciocínio (`reasoningEffort`: `none`, `minimal`, `low`, `medium` ou `high`).

3. **Permissões de Privacidade Explicadas Antes do Primeiro Turno:**
   - **Modo do Microfone (`Mic`):** `Mudo (Desligado)`, `Push-to-Talk` ou `Escuta Contínua (VAD)`.
   - **Modo de Visão (`Eyes`):** `Desligado (Privacidade Total)` (padrão), `Apenas Janela Ativa` ou `Tela Completa`.
   - **Política do Action Gatekeeper (Ferramentas MCP / Computador):**
     - `Sempre pedir confirmação (staged-confirm)` (padrão recomendado);
     - `Permitir leitura segura (read-safe) e confirmar escrita`;
     - `Apenas observar (observe-only)`.
   - **Horários de Silêncio (`Quiet Hours`):** Defina a janela em que a Ashy não deve tomar iniciativa espontânea (ex.: `23:00 – 08:00`, `22:00 – 07:00` ou `Desativado`).

4. **Teste de Conexão, Microfone e Voz:**
   - Use os botões **Testar conexão**, **Testar microfone** e **Testar voz (TTS)** diretamente no Wizard para confirmar que o modelo, a captura de áudio e a síntese vocal estão funcionando antes de começar.

5. **Despertar Ashy (`Despertar Ashy`):**
   - Ao clicar em **Despertar Ashy**, o aplicativo:
     1. Salva suas preferências de provedor, voz e privacidade no Host;
     2. Registra o primeiro marco autobiográfico real (`first_meeting`) na linha do tempo de **Nossa História**;
     3. Gera a saudação inicial da Ashy no **Estúdio**, pronta para o seu primeiro turno de conversa real.

---

## 2. O Estúdio (`Cozy Night Studio`), Conversa em Texto e Voz & `SeriousnessGate`

A aba **Estúdio** é o espaço principal de convivência diária com a Ashy, desenhado sob a estética *Cozy Night Studio* (tons noturnos aconchegantes em espaço de cor perceptual OKLCH/Oklab).

### Conversa em Texto e Streaming Sem Vazamento de Tags
- Digite sua mensagem na barra inferior e pressione `Enter` (ou clique em **Enviar**).
- Enquanto o LLM gera a resposta em streaming, o parser incremental (`createTailSafeMarkerParser`) intercepta marcadores de expressão `<|ACT:emotion=...|>`, pausas `<|DELAY:...ms|>` e referências a piadas internas `<|CALLBACK:id|>` **sem jamais exibi-los crus no texto ou pronunciá-los na voz**.
- Cada sinal `<|ACT|>` atualiza imediatamente a expressão facial, o olhar e o gesto corporal da Ashy no palco 2D, além de alimentar o vetor afetivo da sessão.

### Conversa por Voz em Tempo Real e Barge-In
- **Para conversar por voz, use o Modo ao vivo (chamada):** o botão **Ligar** no centro do dock ou `Ctrl+Alt+L`. Tudo sobre a chamada (backends, motor local, voz de referência, ferramentas, privacidade e solução de problemas) está na [§7](#7-modo-ao-vivo-chamada).
- **Turn-Taking Humano:** A Ashy não corta você na primeira pausa para respirar. Na chamada, o Silero VAD (com pré-rolagem de `360ms`) espera o fim do turno (`700ms` de silêncio por padrão, com *grace period*) antes de responder.
- **Interrupção Natural (*Barge-In*):** Se você começar a falar enquanto a Ashy fala, o volume dela abaixa na hora; se a fala se confirmar, ela para com um fade-out curto e o histórico guarda **só o que você ouviu**. No turno seguinte ela sabe em que ponto foi interrompida.
- *Nota:* o antigo "Omni Nativo" do Ollama não era fala→fala (o Ollama não gera áudio num turno de chat); ele continua só para o chat de texto e para falar respostas do chat em voz alta. Ver [ADR-0008](./adr/0008-live-call-engine-pluggable-voice-sessions.md).

### Webcam, Visão de Tela (`2 fps`) e Cartões de Ação (`ActionGatekeeper`)
- No Estúdio, você pode ativar a **Câmera / Vídeo Omni (`2 fps`)**, compartilhar a tela autorizada (`Eyes`) ou enviar um clipe `.mp4`/`.webm`. Um filtro perceptual **dHash de 64 bits** descarta quadros repetidos automaticamente para economizar largura de banda e contexto.
- Quando a Ashy precisa usar uma ferramenta MCP que modifica arquivos ou executa um comando (`staged-confirm`), um cartão interativo (`PendingActionCard`) aparece no Estúdio mostrando o caminho, os argumentos e o **diff exato**, permitindo **Aprovar 1x**, **Aprovar na Sessão** ou **Recusar**.

### O `SeriousnessGate` (Filtro de Seriedade e Acolhimento)
A Ashy tem personalidade energética e bem-humorada no dia a dia, mas sabe reconhecer quando você precisa de apoio sério:
- Sempre que você relata luto, crise pessoal, exaustão severa, urgência médica ou um problema grave, o **`SeriousnessGate` híbrido** (regras rápidas determinísticas + classificação contextual) entra em ação instantaneamente.
- O badge **`Por aqui, acolhendo você com calma.`** aparece no Estúdio (`seriousness-gate-badge`).
- Enquanto o `SeriousnessGate` está ativo:
  - **Zero piadas internas ou provocações** são injetadas no prompt;
  - A energia caótica e a brincadeira são suprimidas;
  - A postura vocal e corporal da Ashy muda para escuta calma, empática e direta.

---

## 3. Governança de Memórias FSRS-6 (`Memórias`)

Na aba **Memórias**, você tem transparência e controle total sobre tudo o que o **Ashy Cortex** aprendeu nas conversas.

### As 6 Camadas de Memória e Proveniência Obrigatória
A Ashy organiza o que viveu com você em 6 tipos de memória no SQLite local (`ashy.db`), divididos visualmente nas categorias **Momentos**, **Sobre você**, **Referências** e **Planos**:
1. **Memória Episódica (`EpisodicMemory`):** Resumos consolidados de conversas significativas (conversas triviais como *"oi, tudo bem?"* são filtradas e descartadas pelo gate `shouldSaveEpisode`).
2. **Memória Semântica (`SemanticFact`):** Fatos duradouros sobre você, seus projetos e preferências, atualizados via consolidação *Predict -> Calibrate* (fatos antigos contraditos ganham `invalid_at` e deixam de entrar no prompt).
3. **Memória Autobiográfica (`AutobiographicalMilestone`):** Marcos da relação entre vocês.
4. **Motivos Relacionais (`InsideJokeMotif`):** Piadas internas, apelidos e metáforas compartilhadas.
5. **Memória Prospectiva (`ProspectiveIntent`):** Planos futuros, prazos e lembretes contextuais que alimentam a iniciativa proativa da Ashy.
6. **Hábitos do Usuário (`UserHabit`):** Padrões de horário e ritmo percebidos ao longo da convivência.

> **Regra de Ouro (Proveniência):** Nenhuma memória existe sem apontar para os episódios reais que a originaram (`source_episode_ids`). No painel lateral de detalhes de qualquer memória, você pode inspecionar a origem exata daquele registro.

### Curva de Esquecimento FSRS-6 & *Flashbulb Memories*
- Cada memória possui parâmetros reais de **Estabilidade ($S$)**, **Dificuldade ($D$)** e **Recuperabilidade ($R$)** calculados pelo algoritmo **FSRS-6**.
- Após cada turno de conversa, o loop FSRS avalia quais memórias recuperadas foram efetivamente úteis na resposta (`good`/`easy`) ou ignoradas (`again`/`hard`), reforçando o que continua relevante e deixando memórias periféricas adormecerem naturalmente.
- **Memórias *Flashbulb*:** Momentos de alto impacto emocional recebem marcação *Flashbulb*, garantindo um **piso mínimo de retenção** para que nunca sejam esquecidos pela passagem do tempo.

### Aprovar, Editar, Criar e Excluir Memórias
- **Adicionar / Ensinar Fato (`O que aprendi sobre você`):** Você pode registrar ou complementar manualmente fatos escolhendo a categoria (`Sobre você`, `Planos`, `Referências`, `Momentos`) e o predicado correspondente.
- **Aprovar / Fixar / Editar:** Revise fatos recém-extraídos ou corrija qualquer resumo diretamente pela interface.
- **Exclusão Completa:** Ao apagar uma memória no inspetor, a Ashy remove o registro principal, seus vetores de embedding e sua entrada no índice textual `FTS5` — ela desaparece imediatamente de todas as buscas futuras.

---

## 4. Nossa História, Piadas Internas (`CooldownLock`), Quarto da Ashy & *Dream & Reflection*

### Nossa História (`Nossa História`)
A aba **Nossa História** apresenta a linha do tempo viva da sua convivência com a Ashy:
- Exibe o **Estágio do Relacionamento** atual (evoluindo organicamente conforme o tempo e os marcos reais vividos), o resumo da jornada, busca por marcos e o filtro por período.
- Todos os marcos (como o `first_meeting`, projetos concluídos juntos, madrugadas de debug ou descobertas importantes) podem ser consultados e editados.

### Piadas Internas e o `CooldownLock` Anti-Saturação
Uma boa piada interna perde a graça se for repetida a cada cinco minutos. Por isso, o motor de piadas internas (`InsideJokeEngine`) implementa:
- **Relevância Híbrida (Lexical + Semântica Vetorial):** A Ashy reconhece quando um contexto atual lembra uma situação antiga mesmo que você use palavras diferentes (ex.: falar sobre *"mexer numa biblioteca antiga e dar erro"* relembra o episódio original do *"fantasma no backend"* sem precisar repetir a palavra *"fantasma"*).
- **`CooldownLock` (Bloqueio de Cooldown):** Assim que a Ashy faz um `<|CALLBACK:id|>` para uma piada interna, ela entra automaticamente em **Cooldown** por uma janela configurada de turnos e horas. Na UI, você vê claramente o selo **`Em Cooldown`** vs. **`Pronta para uso`**, garantindo que as referências internas surjam como surpresas naturais e nunca como um tique mecânico.

### Quarto da Ashy (`Quarto da Ashy`)
Na aba **Quarto da Ashy**, o ambiente visual reflete a convivência real de vocês:
- A iluminação e a atmosfera acompanham o horário do dia.
- **Troféus e Lembranças Desbloqueados por Marcos Reais:** Cada objeto especial na estante do quarto está vinculado a um `autobiographical_milestone` real do banco `ashy.db` (zero troféus fictícios pré-populados). Ao clicar em um troféu desbloqueado, você vê a data e a memória real que deu origem àquela lembrança.

### *Dream & Reflection* (Evolução da Personalidade Reversível em 1 Clique)
Ao final de uma sessão ou após um período de inatividade (`DreamWorker`), a Ashy realiza o ciclo de **Sonho e Reflexão (*Dream & Reflection*)**:
1. Consolida episódios pendentes usando o método **`Predict -> Calibrate`**;
2. Escreve uma entrada legível no **Diário de Reflexão (`DreamJournalEntry`)** sintetizando o que aprendeu;
3. Propõe pequenos ajustes graduais (`deltas`) nos seus **5 traços de personalidade** (`warmth`, `playfulness`, `directness`, `curiosity`, `chaosEnergy`), sempre respeitando limites de deriva para nunca descaracterizar sua identidade-base e **sempre justificados por episódios reais**.
4. **Reversão em 1 Clique (`Reverter ajuste`):** No painel *Evolução & Sonhos*, cada mudança de traço exibe o motivo, o delta aplicado e o episódio de origem, acompanhado de um botão **Reverter**. Com **1 clique**, você desfaz qualquer ajuste de personalidade imediatamente e restaura o valor anterior do traço no `ashy.db`.

---

## 5. Palco Universal 2D, Modo Overlay Transparente, Bandeja do Sistema e os 6 Atalhos Globais

### Palco Universal 2D (Tachie em Camadas & Cubism 4 Live2D `.model3.json`)
A presença visual da Ashy funciona de maneira unificada em toda a aplicação (no Estúdio, na barra lateral, na pré-visualização de Ajustes e na janela flutuante):
- **Modo Live2D Cubism 4 (`.model3.json`):** Suporta presets integrados (`Hiyori`, `Haru`, `Mao`) e importação de modelos `.model3.json` customizados, inspecionando automaticamente parâmetros de física, expressões (`model.expression(...)`) e motions (`model.motion(...)`).
- **Modo Tachie em Camadas:** Renderização em alta taxa de quadros com camadas independentes para corpo, olhos (aberto/meio/fechado), sobrancelhas para os 13 estados emocionais e visemas de boca (`A, E, I, O, U`).
- **Vida Orgânica em Tempo Real:**
  - **Lip-Sync Acústico *Winner + Runner-Up*:** Analisa os formantes do áudio de voz em tempo real para articular vogais com suavidade, cedendo espaço quando uma nova vogal dominante surge.
  - **Auto-Blink Multiplicativo (`BLINK_THRESHOLD = 0.15`) e Saccades:** Piscadas naturais e micro-movimentos oculares que seguem o cursor do mouse ou repousam de forma realista.
  - **Mola Física a `120 Hz` & *Retinal Light Squint* em Oklab:** Em `Ajustes > Geral`, o controle de **Luminância Ambiente** permite ajustar (ou sincronizar) a luz do ambiente; sob luz intensa, as pupilas/olhos reagem com um leve *squint* retinal sem sofrer auto-realimentação pelo brilho do próprio palco.

### Modo Overlay Transparente (`alwaysOnTop` + Click-Through em CPU $O(1)$)
Você pode manter a Ashy flutuando sobre suas outras janelas enquanto trabalha ou joga:
- Ative **Mostrar avatar na área de trabalho** em `Ajustes > Geral` (ou pelo menu da Bandeja do Sistema / atalho `Ctrl+Shift+H`, ou abrindo `/?view=stage-overlay`).
- A janela **Stage Overlay** é transparente, sem bordas e `alwaysOnTop`.
- **Click-Through em CPU $O(1)$ (`64x64` Silhouette Bitmask):** O palco extrai continuamente uma máscara de bits compacta (`64x64`) da silhueta real do avatar:
  - Quando o cursor está sobre uma área transparente ao redor da Ashy, os cliques **atravessam a janela instantaneamente** para o aplicativo de baixo (`setIgnoreMouseEvents(true, { forward: true })`);
  - Quando o cursor toca a silhueta da Ashy ou sua barra de controles rápidos, a janela captura o clique normalmente para que você possa interagir com ela.

### Bandeja do Sistema (`System Tray`)
Quando executada no Electron Desktop, a Ashy permanece acessível no ícone da **Bandeja do Sistema (System Tray)** com menu rápido em português para:
- **Mostrar / Ocultar Hub Principal**;
- **Mostrar / Ocultar Palco Flutuante (Overlay)**;
- **Alternar Microfone (`Mic`)**, **Visão (`Eyes`)** e **Não Perturbe (`DND`)**;
- **Ativar Escudo de Privacidade Total (Kill Switch)**;
- **Encerrar completamente a Ashy**.

### Os 6 Atalhos Globais de Teclado
Mesmo quando a janela da Ashy está em segundo plano ou minimizada, você pode controlar sua privacidade e presença imediatamente com os **6 atalhos globais registrados no sistema operacional**:

| Atalho Global | Ação Imediata | O que faz |
| :--- | :--- | :--- |
| **`Ctrl+Shift+M`** | **Alternar Microfone (`Mic`)** | Liga ou silencia o microfone imediatamente. |
| **`Ctrl+Shift+E`** | **Alternar Visão (`Eyes`)** | Liga ou desliga a captura autorizada de tela/janela. |
| **`Ctrl+Shift+D`** | **Alternar Não Perturbe (`DND`)** | Bloqueia/libera qualquer iniciativa proativa ou notificação da Ashy. |
| **`Ctrl+Shift+H`** | **Ocultar / Mostrar Avatar (`Hide Stage`)** | Esconde ou reexibe instantaneamente o palco flutuante (Stage Overlay). |
| **`Ctrl+Shift+Space`** | **Push-to-Talk / Turno de Voz** | Inicia ou sela imediatamente um turno de fala por voz com a Ashy. |
| **`Ctrl+Shift+K`** | **Escudo de Privacidade (`Kill Switch`)** | **Corta em 1 comando** o microfone (`Mic = OFF`), a visão (`Eyes = OFF`), ativa `DND = ON`, interrompe qualquer fala/stream em andamento e cancela ações pendentes no Gatekeeper. |

*(No macOS, `CommandOrControl` corresponde a `Cmd+Shift+...`; no Windows e Linux, `Ctrl+Shift+...`.)*

Além desses, **`Ctrl+Alt+L`** liga e desliga a **chamada do Modo ao vivo** (ver [§7](#7-modo-ao-vivo-chamada)).

---

## 6. Portabilidade da Alma (`.ashy-soul`), Criptografia em Repouso (`AES-256-GCM`) & Apagar Tudo com 1 Clique (Factory Reset)

Todos os recursos de soberania sobre os seus dados ficam em **`Ajustes`** (sub-abas **Geral** e **Privacidade**).

### Portabilidade da Alma (`.ashy-soul` Export / Import)
Sua história com a Ashy pertence a você e não fica presa a nenhuma nuvem ou máquina:
- **Exportar Alma (`Exportar .ashy-soul`):** Na seção **Portabilidade da Alma & Reset**, clique em **Exportar `.ashy-soul`**. A Ashy gera um pacote JSON canônico assinado por um **checksum `SHA-256`** contendo:
  - Episódios consolidados e fatos semânticos com proveniência;
  - Marcos autobiográficos de **Nossa História** e troféus do **Quarto da Ashy**;
  - Piadas internas (`InsideJokeMotif`) e estado de cooldown;
  - Intenções prospectivas e hábitos observados;
  - Vetor afetivo atual, os 5 traços de personalidade, histórico do *Dream & Reflection* e exemplares de estilo.
  - *(Nota de segurança: chaves de API nunca são incluídas no arquivo `.ashy-soul`.)*
- **Importar Alma (`Importar .ashy-soul`):** Selecione um arquivo `.ashy-soul` ou cole o conteúdo JSON no campo de importação e clique em **Importar `.ashy-soul`**. O Córtex valida o schema Valibot e o checksum `SHA-256` **em memória antes de tocar no banco**; se o arquivo estiver íntegro, restaura toda a memória e história compartilhada em uma única transação atômica. Arquivos corrompidos ou adulterados são rejeitados com segurança sem alterar seus dados atuais.

### Criptografia em Repouso (`AES-256-GCM`)
Em **`Ajustes > Privacidade`**, no card **Criptografia em Repouso (`AES-256-GCM`)**:
- Ao ativar o switch **Criptografar banco de dados em repouso**, o Host gera uma chave mestra de 256 bits protegida pelo cofre nativo do sistema operacional (`safeStorage` — DPAPI no Windows, Keychain no macOS, Secret Service/libsecret no Linux).
- Além do `ashy.db` vivo durante a sessão, um snapshot criptografado autenticado **`ashy.db.enc`** (`AES-256-GCM` com IV de 96 bits e Auth Tag de 128 bits) é mantido e sincronizado automaticamente no disco, protegendo suas memórias contra leitura não autorizada do armazenamento local.

### Apagar Tudo com 1 Clique (`Factory Reset` Atômico)
Se você quiser recomeçar do zero absoluto ou limpar todos os dados locais da máquina:
1. Vá até **`Ajustes`** no card **Portabilidade da Alma & Reset**;
2. Clique em **`Apagar tudo (Factory Reset)`**;
3. Confirme na etapa de segurança clicando em **`Confirmar exclusão total`**.
4. **O que acontece imediatamente:**
   - Todas as tabelas do `ashy.db` (episódios, fatos, marcos, piadas internas, intenções, hábitos, logs de evolução, auditoria MCP e histórico de mensagens), além do snapshot `ashy.db.enc` e configurações de sessão, são apagados atomicamente;
   - Os controles de privacidade retornam ao estado seguro padrão;
   - A interface volta instantaneamente para o **Wizard de Primeiro Encontro (`FirstMeetingWizard`)**, pronta para uma nova jornada limpa.

---

## 7. Modo ao vivo (chamada)

O **Modo ao vivo** (Live Mode) é uma **chamada de voz contínua e mãos-livres** com a Ashy: você fala, ela responde com voz, pode ser interrompida no meio da frase, o avatar mexe a boca com o áudio que está tocando e as falas dos dois lados entram no chat (com o ícone 🎤) e na memória como mensagens de voz. Se você a interromper, o histórico guarda **só o trecho que você realmente ouviu**. A arquitetura está no [ADR-0008](./adr/0008-live-call-engine-pluggable-voice-sessions.md); detalhes de cada provedor estão no [Guia de Provedores](./PROVIDER_GUIDE.md#6-modo-ao-vivo-chamada--backends-e-provedores).

### Como ligar
- **Botão Ligar** no centro do dock da aba **Companhia**. O anel mostra o estado: ouvindo, você falando, pensando, falando, reconectando. Durante a chamada aparecem o botão de **mute**, a **legenda ao vivo** e o chip de **latência**. Clique de novo para **Desligar**.
- **Atalho global `Ctrl+Alt+L`**: liga e desliga a chamada de qualquer lugar.
- **Overlay (avatar flutuante):** os botões **Ligar/Desligar** e **Mic on/off** ficam na ilha de controles. O ponto de estado continua visível durante a chamada mesmo sem o mouse em cima. A chamada continua funcionando com a janela principal fechada.
- Quando a chamada termina por erro, a faixa do dock mostra o motivo (motor não instalado, chave inválida, microfone negado etc.).

### Escolhendo o backend (Configurações › Live Mode)
Em **Configurações** › **Live Mode**, escolha um dos cards:

| Card | O que é | Quando usar |
|---|---|---|
| **Local omni + minha voz (híbrido)** — *padrão* | O LFM3-Omni-2B local (llama.cpp) pensa em texto e o `/tts` do llama.cpp fala, frase a frase, com voz feminina/masculina ou com a **sua voz de referência**. | **Recomendado no computador local.** É o modo mais controlável com um modelo pequeno: ecos e repetições são cortados antes de virar áudio. |
| **Local omni (LFM3 via llama.cpp)** | O mesmo modelo responde texto e áudio intercalados direto (`/v1/realtime`). | Um pouco mais rápido, mas o áudio sai junto com o texto e não dá para filtrar; tende a repetir a primeira forma de resposta. |
| **Pipeline clássica (STT → modelo de texto → voz)** | Transcrição → **qualquer modelo de texto** (Ollama, OpenRouter, Anthropic, OpenAI, NVIDIA NIM ou "Mesmo modelo do chat") → voz (llama.cpp `/tts`, Kokoro, OpenAI TTS ou ElevenLabs). Usa a persona, a memória e as ferramentas completas da Ashy. | **Melhor qualidade e melhores ferramentas no local** com `qwen3:4b-instruct` no Ollama (`ollama pull qwen3:4b-instruct`, ~2,5 GB). Também é o jeito de conversar por voz com Claude, GPT etc. |
| **OpenAI Realtime / compatível** | Fala→fala na nuvem: OpenAI (`gpt-realtime-2.1-mini`), Qwen-Omni (DashScope) ou um servidor próprio compatível. | Menor latência e um modelo grande. **Requer chave**, e o áudio vai para o provedor. |
| **Gemini Live** | Fala→fala na nuvem do Google (`gemini-3.8-live`). | Mesma coisa: **requer chave** (Google AI Studio). |

A troca de card é salva na hora. Os campos de cada painel são gravados com o botão **Salvar** no fim da página.

### Instalando o motor local
Vale para os dois backends locais e para a pipeline clássica com a voz do llama.cpp. No painel **Motor local (llama.cpp)**:
1. Veja a **GPU detectada** e a variante recomendada: **CUDA 12.4 (NVIDIA)**, **Vulkan (AMD/Intel)** ou **CPU**. "Automática" usa a recomendada; você pode forçar outra.
2. Clique em **Instalar motor**. A Ashy baixa só o build fixado do llama.cpp (`b12024`, releases oficiais no GitHub) e confere o SHA256. Tamanhos aproximados: CUDA ~670 MB (motor + runtime CUDA), Vulkan ~38 MB, CPU ~25 MB.
3. Clique em **Baixar modelo**: LFM3-Omni 2B Q4_K_M + mmproj Q8_0, ~1,6 GB, do Hugging Face, com SHA256 conferido. **Se o Ollama já tiver o mesmo arquivo GGUF, ele é reaproveitado** em vez de baixado de novo (o mmproj vem sempre do Hugging Face).
4. **Iniciar / Parar** liga e desliga o servidor local, que escuta só em `127.0.0.1`. Ao ligar uma chamada, ele é iniciado automaticamente.
5. **Aviso do Visual C++:** se aparecer *"Falta um componente da Microsoft (Visual C++ Runtime)"*, clique em **Instalar componente da Microsoft**. O instalador oficial (`vc_redist.x64.exe`) é baixado do site da Microsoft, o Windows pede permissão de administrador e às vezes é preciso reiniciar.
6. Em vez do servidor gerenciado, você pode informar a **URL de um llama-server seu** (ex.: `http://127.0.0.1:8080`).

### Voz de referência (híbrido e pipeline com a voz do llama.cpp)
- Em **Voz de referência**, clique em **Enviar amostra**: de 5 a 30 s de fala limpa (wav, mp3, flac, ogg ou m4a). O áudio é convertido no próprio PC para mono 24 kHz e fica só no seu computador.
- **Ouvir** sintetiza uma frase de teste, **Usar** escolhe a voz e **Excluir** remove.
- Use só vozes que você tem direito de usar.

### Testar chamada
**Testar chamada** faz uma chamada de um turno: uma pergunta sintetizada substitui o microfone, e cada etapa (microfone, VAD, backend, primeira resposta, playback) aparece com ✓/✗ e o tempo em ms. Nada do teste vai para a memória. Como a pergunta é falada pela voz local do llama.cpp, o teste precisa do motor local instalado mesmo nos backends de nuvem; a chamada normal não precisa.

### Recursos na chamada
Em **Recursos na chamada** (todos desligados por padrão e salvos na hora):
- **Ferramentas:** ela pode ver a janela ativa, olhar a tela autorizada, ler um arquivo do workspace e escrever uma nota de projeto. Com o modelo local de 2B funciona melhor para pedidos simples; na nuvem, ou na pipeline clássica com um modelo maior, é mais confiável.
- **Visão:** quando você pergunta algo como "o que tem na minha tela?", ela olha a tela **respeitando o modo Tela/Janela da privacidade** (`Eyes`). Enquanto captura, aparece **"👁 vendo a tela"**. A descrição da tela é feita pelo motor local.
- **Iniciativa:** depois de um tempo em silêncio (padrão 90 s, ajustável em "Puxar assunto após"), ela pode puxar assunto **raramente e com contexto**: no máximo uma vez a cada 10 min e nunca com o mic mudo, com Não perturbe ou fora do horário permitido.

**Aprovações:** quando uma ação precisa de permissão, aparece um card no dock e no balão do overlay com **Aprovar**, **Sempre permitir** (grava a permissão para aquela ferramenta) e **Negar**. Você também pode responder **por voz**, com a frase inteira: "pode", "pode fazer" ou "autorizo" aprovam; "pode sempre" aprova sempre; "não", "cancela" ou "deixa" negam. Frases maiores ("pode me contar uma piada") não aprovam nada. A Ashy nunca se aprova sozinha, e ações de alto impacto (com aviso de risco) só são aprovadas por clique.

### Privacidade: o que sai do computador
- **Backends locais (híbrido e local omni):** nada sai da máquina. O motor escuta só em `127.0.0.1` e exige uma chave aleatória por execução, que a interface nunca vê.
- **OpenAI Realtime / Qwen / Gemini:** vão para o provedor escolhido o **áudio do microfone durante a chamada**, as instruções da Ashy (persona, seu nome, as últimas mensagens do chat e as memórias relevantes de cada turno) e os resultados das ferramentas. As chaves ficam cifradas no seu PC e só o processo principal as usa, por um relay local; a interface só grava a chave e mostra o status mascarado. Na OpenAI, se você não colar uma chave própria do Live Mode, a chave do chat é usada.
- **Pipeline clássica:** o texto da conversa vai para o provedor de LLM escolhido (se for de nuvem), e o áudio vai para o STT/TTS escolhido (se for de nuvem).
- A voz de referência e as capturas de tela ficam locais (a tela é descrita pelo motor local).

### Solução de problemas
- **Ela se ouve e responde a si mesma (eco):** com caixas de som, o cancelamento de eco nem sempre basta. **Use fone de ouvido.**
- **A primeira resposta demora:** na primeira chamada (ou logo depois de iniciar o motor) o modelo ainda está sendo carregado na memória/VRAM. As respostas seguintes são mais rápidas. Com a GPU ocupada por outros programas, tudo fica mais lento.
- **"Motor não instalado" ou a chamada termina logo:** instale o motor e o modelo em Configurações › Live Mode, ou escolha um backend de nuvem / a pipeline clássica.
- **Erro de DLL / Visual C++:** use o botão **Instalar componente da Microsoft** e reinicie se for pedido.
- **Nuvem:** "chave de API inválida (HTTP 401)", "limite de uso/cota excedido (HTTP 429)" ou "Chave de API do … não configurada" aparecem na faixa da chamada. Confira a chave no painel do backend.
- **A aprovação por voz não funcionou:** a transcrição precisa ser exatamente uma das frases. Se o reconhecimento errar, use o botão.
- **Logs:** o log do motor local fica em `%APPDATA%\@ashy\desktop\logs\llama-server.log`. Os dados da Ashy (banco, `live-mode.json`, vozes de referência) ficam em `%APPDATA%\@ashy\desktop\`.
