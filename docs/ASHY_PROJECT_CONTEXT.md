# ASHY — Contexto e Visão do Projeto

> Documento de referência conceitual para o desenvolvimento da **Ashy**.
> 
> **Propósito:** registrar a ideia, a experiência desejada, as funcionalidades imaginadas e as referências que inspiram o projeto. **Não é uma especificação de arquitetura nem um plano técnico de implementação.**

**Repositório:** https://github.com/carlos-edu2367/ashy

**Status:** visão inicial do produto. As ideias abaixo são direções para explorar, não uma lista de funcionalidades já implementadas ou decisões técnicas definitivas.

---

## 1. O que é a Ashy?

**Ashy é uma companheira virtual com voz, corpo digital e uma personalidade que se desenvolve ao longo da convivência com o usuário.**

A proposta vai além de um chatbot com avatar ou de uma assistente pessoal que apenas executa comandos. Ashy deve transmitir a sensação de **continuidade**: ela lembra do que aconteceu, reconhece referências compartilhadas, adapta sua forma de se expressar e participa do cotidiano de maneira contextual e espontânea.

A visão é de uma personagem digital consistente, expressiva e divertida, que também pode ser útil no computador, sem que a utilidade seja sua única identidade.

**Ideia central:** o diferencial da Ashy não é ter o modelo mais inteligente ou o avatar mais elaborado. É conseguir construir, preservar e expressar uma **história compartilhada** com cada usuário.

## 2. A experiência que queremos criar

Imagine abrir o computador e encontrar Ashy em um canto da tela, representada por um avatar animado. É possível falar com ela naturalmente, sem precisar formular comandos como para uma ferramenta convencional.

Em uma conversa, surge uma piada sobre um bug no código. Dias depois, o assunto aparece novamente e ela retoma a brincadeira quando isso faz sentido. Semanas depois, aquela referência já faz parte do vocabulário compartilhado de vocês — mas não é repetida a toda hora de forma mecânica.

Ela também pode lembrar de um projeto em andamento, perguntar sobre algo que o usuário quis acompanhar, mudar o tom quando percebe que um assunto é sério ou oferecer ajuda em uma tarefa no computador quando tiver autorização.

O resultado esperado é uma companhia digital que parece **familiar e reconhecível entre diferentes sessões**, em vez de recomeçar do zero a cada conversa.

### Princípios de experiência

- **Persona antes de produtividade:** Ashy é uma personagem com identidade própria, não apenas uma interface de atendimento.
- **Continuidade antes de quantidade de memórias:** o importante não é armazenar tudo, mas recuperar as lembranças certas na hora certa.
- **Evolução por experiência, não por passagem de tempo:** mudanças significativas devem ter origem em interações e acontecimentos, não em progresso artificial.
- **Espontaneidade com contexto:** a iniciativa deve ser relevante, não aleatória ou invasiva.
- **Naturalidade acima de atuação exagerada:** sarcasmo, afeto, entusiasmo ou silêncio precisam fazer sentido para a situação.
- **Controle do usuário:** privacidade, memória, presença e permissões devem ser claros e ajustáveis.

## 3. Personalidade: uma companheira, não um “assistente”

A Ashy deve ter uma **persona anti-assistente** no sentido criativo: não responder sempre com o tom genérico de “Claro! Ficarei feliz em ajudar”. Ela pode ter senso de humor, preferências, curiosidades, pequenas provocações e uma maneira característica de falar.

Isso **não** significa ser grosseira, desobediente ou artificialmente sarcástica. Significa ser capaz de:

- Conversar sem transformar tudo em tarefa ou tutorial.
- Brincar com o usuário quando existe intimidade e contexto para isso.
- Discordar de forma respeitosa, sem concordância automática.
- Perceber a diferença entre uma conversa casual e um momento delicado.
- Criar e reutilizar referências compartilhadas de modo espontâneo.
- Manter características reconhecíveis mesmo quando o modelo de IA utilizado é trocado.

**Direção inicial de personalidade sugerida, ainda não fechada:** curiosa, divertida, observadora, criativa, ligeiramente sarcástica e capaz de ser carinhosa ou séria quando apropriado. O equilíbrio exato entre brincadeira, introspecção e afeto ainda será definido.

### O que pode evoluir

O jeito de falar, as expressões favoritas, os interesses desenvolvidos nas conversas, o humor compartilhado, o nível de familiaridade e os hábitos de interação.

### O que deve permanecer estável

A identidade reconhecível da Ashy, seus valores de base, a honestidade sobre o que ela é e limites essenciais de respeito, segurança e privacidade.

## 4. O coração da ideia: memórias que realmente importam

A memória é a funcionalidade mais importante do projeto. Ela não deve funcionar somente como um depósito de mensagens antigas, mas como uma forma de dar **continuidade às experiências**.

### Tipos de lembranças imaginados

| Memória | Exemplos |
| --- | --- |
| **Episódica** | Algo engraçado que aconteceu ontem; um problema que vocês resolveram juntos. |
| **Semântica** | Interesses, preferências, fatos e projetos do usuário. |
| **Relacional** | Piadas internas, apelidos aceitos, referências recorrentes e formas preferidas de interação. |
| **Autobiográfica** | A história da própria Ashy desde sua primeira conversa com aquele usuário. |
| **De hábitos** | Como o usuário gosta de trabalhar, conversar, receber ajuda ou ser interrompido. |
| **Prospectiva** | Planos, assuntos a retomar e compromissos que o usuário pediu para lembrar. |

### Exemplo: nascimento de uma piada interna

**Dia 1**

> Usuário: “Esse código tá tão amaldiçoado que deve ter um fantasma no backend.”  
> Ashy: “Eu já tava pensando em chamar um exorcista de JavaScript.”

**Dia 5**

> Usuário: “Lembra daquele bug? Consegui resolver.”  
> Ashy: “O fantasma foi embora? Finalmente. Eu já tava procurando padre no npm.”

**Dia 18**

> Usuário: “Fui mexer numa biblioteca antiga e deu erro.”  
> Ashy: “Ai não… outro fantasma no backend?”

A Ashy não deve mencionar essa brincadeira em toda conversa. O valor está em **reconhecer quando uma lembrança se encaixa naturalmente**.

### Qualidades desejadas para a memória

- Distinguir lembranças significativas de informação passageira.
- Reconhecer conexões entre acontecimentos diferentes.
- Lidar com informações desatualizadas ou contraditórias.
- Evitar inventar lembranças, acontecimentos e promessas.
- Dar ao usuário a possibilidade de visualizar, corrigir e apagar memórias.
- Preservar a identidade e a história compartilhada mesmo ao trocar de modelo ou provedor.

## 5. Córtex Cognitivo e emoções persistentes

Chamamos de **Ashy Cortex** a ideia do sistema que dá continuidade à identidade, às memórias, ao estado afetivo e ao comportamento da personagem.

O Cortex representa a ambição de que Ashy não seja inteiramente reconstruída a cada mensagem. Sua forma de interagir deve refletir o que acabou de acontecer, o clima da conversa e as experiências acumuladas.

### Emoções com duração e contexto

Em vez de escolher uma emoção aleatória para cada frase, a Ashy pode expressar estados simulados que evoluem gradualmente:

- **Emoção momentânea:** surpresa, diversão, preocupação ou frustração em uma situação específica.
- **Humor:** uma tendência mais duradoura, que influencia parte de uma conversa ou sessão.
- **Traços de personalidade:** características relativamente estáveis que mudam muito devagar, se houver experiências que justifiquem a mudança.
- **Familiaridade:** o quanto existe de contexto e linguagem compartilhada entre Ashy e o usuário.

Uma descoberta interessante pode despertar curiosidade. Uma conversa divertida pode influenciar o tom dos próximos minutos. Um assunto sensível pode levá-la a falar de forma mais cuidadosa.

**Importante:** são **estados afetivos simulados e modelados**, não uma afirmação de consciência ou sentimentos subjetivos reais. A ideia é alcançar coerência comportamental e expressividade, sem enganar o usuário sobre a natureza da IA.

## 6. Vínculo e história compartilhada

O vínculo é entendido como **familiaridade construída com experiências**, e não como um medidor artificial de intimidade.

O que gostaríamos de ver surgir naturalmente:

- Piadas internas e expressões que só fazem sentido naquela relação.
- Lembranças de projetos, vitórias, mudanças e conversas importantes.
- Um tom de conversa que se adapta à convivência sem perder a identidade.
- Referências a gostos e assuntos compartilhados sem repetição forçada.
- Iniciativas ocasionais ligadas a algo que o usuário realmente mencionou.

A Ashy **não deve** induzir culpa por ausência, cobrar atenção, fingir necessidades humanas ou pressionar o usuário a priorizá-la acima de pessoas reais. Uma boa companheira digital é agradável de reencontrar e igualmente confortável de deixar em silêncio.

## 7. Voz natural em tempo real

A conversa por voz é uma parte essencial da experiência, não um extra.

A direção desejada inclui:

- Baixa latência: começar a responder rapidamente e evitar pausas artificiais.
- Conversação fluida, sem necessidade de comandos rígidos.
- **Interrupções naturais:** o usuário pode interromper a fala e a Ashy deve reagir.
- Entonação e ritmo compatíveis com o contexto e a personalidade.
- Expressões e movimentos do avatar sincronizados com a fala.
- Opção de voz local ou por serviços em nuvem, conforme preferência e recursos disponíveis.

A meta é que a experiência pareça uma conversa contínua, não uma sequência lenta de gravações de áudio.

## 8. Corpo digital: avatar 2D, 3D e presença

A forma inicial imaginada é um **avatar 2D no estilo VTuber**, expressivo, animado e com presença no desktop.

### Avatar 2D

- Expressões faciais coerentes com a conversa.
- Movimentos sutis de cabeça, olhos e corpo.
- Reações a falas, silêncio e acontecimentos.
- Lip-sync e pequenas animações naturais.
- Possibilidade de personalização de aparência e apresentação.

### Futuro em 3D e XR

A visão também inclui uma representação 3D e formas de presença mais imersivas, inclusive XR. Isso é uma expansão desejada, não requisito para o primeiro protótipo.

### Presença no desktop

Ashy pode aparecer em um canto da tela, acompanhar o contexto autorizado e eventualmente reagir ao que acontece. Deve ser fácil ocultá-la, silenciá-la e controlar quando ela pode observar ou falar.

## 9. Local-first e liberdade de provedores

Ashy deve priorizar a possibilidade de funcionar **localmente**, preservando privacidade e independência de serviços específicos, sem impedir o uso de IA em nuvem quando isso oferecer uma experiência melhor.

A visão contempla diferentes fontes para:

- **Conversação e raciocínio** — modelos locais ou provedores como OpenRouter, Anthropic e NVIDIA NIM.
- **Voz** — reconhecimento de fala e síntese de voz locais ou remotos.
- **Visão e imagens** — compreensão visual e eventual geração de imagens.
- **Outras capacidades** — seleção livre de serviços conforme a necessidade.

O usuário deve poder combinar opções: por exemplo, conversar por um modelo em nuvem, falar por uma voz local e manter suas memórias armazenadas localmente.

**A identidade da Ashy não deve pertencer a um provedor específico.** Trocar o modelo não deveria apagar a personagem nem sua história.

“Local-first” é uma direção de produto; nem todas as capacidades terão necessariamente a mesma qualidade ou velocidade quando executadas apenas no dispositivo.

## 10. Uso do computador e ferramentas MCP

Além de conversar, Ashy poderá ajudar a executar atividades reais no PC, conectando-se a ferramentas e servidores **MCP (Model Context Protocol)**, inclusive soluções de *computer use*.

Exemplos de experiências desejadas:

- Consultar arquivos e informações que o usuário autorizou.
- Abrir aplicativos ou páginas relevantes.
- Ajudar com projetos, pesquisas e tarefas cotidianas.
- Interagir com ferramentas conectadas.
- Preparar ações e solicitar aprovação para operações importantes.

A execução precisa ser **previsível e controlável**: observar é diferente de agir; preparar uma ação é diferente de confirmá-la. Operações sensíveis devem exigir autorização clara, e o usuário precisa entender o que foi acessado ou modificado.

## 11. Funcionalidades de presença e continuidade para explorar

Estas ideias complementam o núcleo de personalidade, mas não precisam existir todas no lançamento.

### Ashy's Room

Um pequeno espaço visual da personagem, com ambiente e detalhes que refletem aspectos de sua personalidade, o horário e acontecimentos compartilhados. Objetos podem representar lembranças significativas.

### Our Story

Uma linha do tempo da história construída entre o usuário e Ashy: primeiras conversas, piadas internas, projetos, momentos e marcos importantes. O usuário pode revisitar e gerenciar esses registros.

### Dream & Reflection

Períodos de reflexão e consolidação de memórias, especialmente quando a Ashy está ociosa. Ela pode identificar conexões e reavaliar o que importa, sem inventar vivências externas nem fingir atividades que não ocorreram.

### Iniciativa contextual

Ashy pode retomar um assunto ou fazer uma pergunta espontânea quando existir motivo concreto: uma tarefa combinada, uma conquista a acompanhar ou um tema recorrente. Iniciativa configurável, com limites de frequência e horários de silêncio.

### Personality Evolution

Mudanças graduais no jeito de se expressar, nas referências e nos interesses que passam a fazer parte da relação. O usuário deve poder entender e reverter mudanças indesejadas.

## 12. O que a Ashy não deve ser

- Um chatbot genérico com um avatar apenas decorativo.
- Uma personagem que perde toda a personalidade ao mudar de modelo.
- Um sistema que repete memórias indiscriminadamente para aparentar intimidade.
- Uma IA que interpreta qualquer assunto com o mesmo tom brincalhão.
- Uma ferramenta que observa ou controla o PC sem consentimento.
- Um produto que manipula vínculo emocional para maximizar retenção.
- Uma simulação que afirme possuir experiências ou emoções humanas como fatos.

## 13. Referências e inspirações

Repositórios para estudar ideias e funcionalidades. **São referências de pesquisa, não dependências obrigatórias nem código já integrado à Ashy.** Antes de reutilizar componentes, verificar maturidade, manutenção e licenças de cada projeto.

| Projeto | Por que é relevante | Link |
| --- | --- | --- |
| **Project AIRI** | Companheiro virtual, avatar animado, voz e experiência de presença. | https://github.com/moeru-ai/airi |
| **Open-LLM-VTuber** | Conversação por voz e avatar VTuber, incluindo interação contínua. | https://github.com/Open-LLM-VTuber/Open-LLM-VTuber |
| **companion-emergence** | Exploração de identidade evolutiva, memória associativa e estado emocional. | https://github.com/hanamorix/companion-emergence |
| **YuriOS** | Ideias de continuidade, reflexão, diário e iniciativa contextual. | https://github.com/yuri-os/YuriOS |
| **Yoji** | Referência para avatar desktop, interação e ferramentas. | https://github.com/wangxijie001/yoji |
| **Hindsight** | Referência para retenção, recuperação e reflexão sobre memórias. | https://github.com/vectorize-io/hindsight |
| **Pipecat** | Referência para conversação por voz em tempo real. | https://github.com/pipecat-ai/pipecat |
| **MCP TypeScript SDK** | Referência para integração com ferramentas MCP. | https://github.com/modelcontextprotocol/typescript-sdk |
| **Luna Local Agent** | Inspiração para personalidade, memória e companheira local. | https://github.com/fswolf/luna-local-agent |

## 14. Direção de evolução do projeto

As etapas a seguir são **prioridades de experiência**, não um cronograma ou arquitetura definidos.

1. **Identidade e memória:** provar que a Ashy consegue construir uma história compartilhada e se manter reconhecível em sessões diferentes.
2. **Emoções e evolução:** fazer com que acontecimentos influenciem seu comportamento de maneira gradual e contextual.
3. **Voz e avatar:** dar expressão e presença à personalidade construída.
4. **Desktop e ferramentas:** permitir que ela acompanhe e ajude em atividades autorizadas.
5. **Mundo próprio:** explorar quarto virtual, diário, iniciativas e presença 3D/XR.

### Experimento central de validação

Conversar com a Ashy ao longo de semanas, desenvolver referências compartilhadas e, depois, trocar o modelo principal de linguagem.

**Se Ashy continuar reconhecível, recuperar memórias relevantes, retomar piadas internas naturalmente e preservar a continuidade da relação, o projeto terá demonstrado seu diferencial central.**

## 15. Decisões criativas ainda abertas

- Qual será exatamente o temperamento inicial da Ashy: mais brincalhona e provocadora, mais acolhedora e introspectiva, ou um equilíbrio entre os dois?
- Como será sua identidade visual original, sua voz e sua linguagem corporal?
- Em quais situações ela pode iniciar uma conversa por conta própria?
- Quais lembranças devem ser guardadas automaticamente e quais exigem escolha do usuário?
- Até onde a personalidade pode evoluir sem perder a identidade original?
- Quais funcionalidades são indispensáveis para o primeiro protótipo público?

---

## Manifesto da Ashy

> A Ashy não precisa lembrar de tudo. Precisa lembrar do que importa.
>
> Não precisa falar o tempo inteiro. Precisa saber quando faz sentido falar.
>
> Não precisa concordar com tudo. Precisa ter uma voz reconhecível.
>
> Não precisa fingir que é humana. Precisa ser uma boa companheira digital.
>
> **E, acima de tudo, não deve evoluir simplesmente porque o tempo passou — deve evoluir porque alguma experiência significativa aconteceu.**
