import type { Locale } from '../i18n'

export interface RecentUpdate {
  version: string
  priority: number
  persistent: boolean
  messages: Record<Locale, string>
}

export const RECENT_UPDATES: RecentUpdate[] = [
  {
    version: '0.10.27',
    priority: 210,
    persistent: false,
    messages: {
      en: 'Traces can now go to Langfuse as well as Phoenix (or both at once), and a new eval layer catches agents that loop, get stuck, or burn turns without making progress.',
      zh: '追踪数据现在可以发往 Langfuse,也可以和 Phoenix 同时双写;新增的评测层能抓出打转、卡死、空烧 turn 却毫无进展的轨迹。',
      de: 'Traces können jetzt zusätzlich zu Phoenix auch an Langfuse gehen (oder an beide gleichzeitig), und eine neue Eval-Schicht erkennt Agenten, die sich im Kreis drehen, feststecken oder Turns ohne Fortschritt verbrauchen.',
      fr: 'Les traces peuvent désormais être envoyées à Langfuse en plus de Phoenix (ou aux deux à la fois), et une nouvelle couche d’évaluation détecte les agents qui tournent en rond, se bloquent ou consomment des tours sans progresser.',
      es: 'Las trazas ahora pueden enviarse a Langfuse además de a Phoenix (o a ambos a la vez), y una nueva capa de evaluación detecta agentes que dan vueltas, se atascan o queman turnos sin avanzar.',
      ko: '이제 추적 데이터를 Phoenix와 함께 Langfuse로도(또는 양쪽 동시에) 보낼 수 있으며, 새 평가 계층이 제자리를 맴돌거나 멈추거나 진전 없이 턴만 소모하는 에이전트를 잡아냅니다.',
    },
  },
  {
    version: '0.10.26',
    priority: 200,
    persistent: false,
    messages: {
      en: 'Network calls now retry transient failures with backoff, misbehaving MCP servers get circuit-broken instead of stalling every call, and unattended runs never answer questions on your behalf.',
      zh: '网络调用遇到瞬态故障会自动退避重试,异常的 MCP server 会被熔断而不是拖慢每次调用,无人值守时 Astraea 也绝不会替你回答确认问题。',
      de: 'Netzwerkaufrufe wiederholen vorübergehende Fehler jetzt mit Backoff, fehlerhafte MCP-Server werden per Circuit-Breaker abgetrennt statt jeden Aufruf zu blockieren, und unbeaufsichtigte Läufe beantworten niemals Fragen in Ihrem Namen.',
      fr: 'Les appels réseau réessaient désormais les échecs transitoires avec backoff, les serveurs MCP défaillants sont coupés par disjoncteur au lieu de ralentir chaque appel, et les exécutions sans surveillance ne répondent jamais aux questions à votre place.',
      es: 'Las llamadas de red ahora reintentan fallos transitorios con backoff, los servidores MCP defectuosos se desconectan con un cortacircuitos en lugar de frenar cada llamada, y las ejecuciones desatendidas nunca responden preguntas en tu nombre.',
      ko: '네트워크 호출이 일시적 오류 시 백오프로 자동 재시도하고, 오작동하는 MCP 서버는 매 호출을 지연시키는 대신 차단되며, 무인 실행에서는 절대 사용자를 대신해 질문에 답하지 않습니다.',
    },
  },
  {
    version: '0.10.25',
    priority: 190,
    persistent: false,
    messages: {
      en: 'No more silent hangs: every network, IPC and subprocess call now has a timeout, and Esc truly cancels running shell commands, searches, MCP calls and sub-agents.',
      zh: '不再悄悄卡死：所有网络、进程间通信与子进程调用都有了超时,Esc 现在能真正取消正在跑的 shell 命令、搜索、MCP 调用和子代理。',
      de: 'Keine stillen Hänger mehr: Jeder Netzwerk-, IPC- und Subprozess-Aufruf hat jetzt ein Timeout, und Esc bricht laufende Shell-Befehle, Suchen, MCP-Aufrufe und Sub-Agenten wirklich ab.',
      fr: 'Fini les blocages silencieux : chaque appel réseau, IPC et sous-processus a désormais un délai d’expiration, et Échap annule réellement les commandes shell, recherches, appels MCP et sous-agents en cours.',
      es: 'Se acabaron los cuelgues silenciosos: cada llamada de red, IPC y subproceso ahora tiene tiempo límite, y Esc cancela de verdad los comandos de shell, búsquedas, llamadas MCP y subagentes en ejecución.',
      ko: '조용한 멈춤은 이제 없습니다: 모든 네트워크·IPC·하위 프로세스 호출에 시간 제한이 적용되고, Esc가 실행 중인 셸 명령·검색·MCP 호출·하위 에이전트를 실제로 취소합니다.',
    },
  },
  {
    version: '0.10.24',
    priority: 180,
    persistent: false,
    messages: {
      en: 'Tool descriptions got sharper: timer delays are unambiguous now, Write points to Edit for small changes, and each shell tool states its platform — fewer wrong-tool and wrong-parameter calls.',
      zh: '工具说明更精确了：定时延迟单位不再歧义,Write 会提示小改动改用 Edit,shell 工具各自声明平台——选错工具、传错参数的情况会更少。',
      de: 'Tool-Beschreibungen sind präziser geworden: Timer-Verzögerungen sind jetzt eindeutig, Write verweist für kleine Änderungen auf Edit, und jedes Shell-Tool nennt seine Plattform — weniger falsche Tool- und Parameterwahl.',
      fr: 'Les descriptions d’outils sont plus précises : les délais de minuterie sont désormais sans ambiguïté, Write renvoie vers Edit pour les petites modifications, et chaque outil shell indique sa plateforme — moins d’erreurs d’outil ou de paramètre.',
      es: 'Las descripciones de herramientas son más precisas: los retrasos del temporizador ya no son ambiguos, Write remite a Edit para cambios pequeños y cada herramienta de shell declara su plataforma — menos llamadas con herramienta o parámetros equivocados.',
      ko: '도구 설명이 더 정확해졌습니다: 타이머 지연 단위가 명확해졌고, Write는 작은 수정에 Edit를 안내하며, 각 셸 도구가 자신의 플랫폼을 명시합니다 — 잘못된 도구·매개변수 호출이 줄어듭니다.',
    },
  },
  {
    version: '0.10.23',
    priority: 170,
    persistent: false,
    messages: {
      en: 'Tool calls are now validated before they run: missing or mistyped parameters are caught at the gate with a clear, fixable message instead of a raw TypeError.',
      zh: '工具调用现在会在执行前统一校验参数：缺失或类型错误会在入口被拦下,并返回清晰可修正的提示,而不是一段原始 TypeError。',
      de: 'Tool-Aufrufe werden jetzt vor der Ausführung validiert: fehlende oder falsch typisierte Parameter werden am Eingang mit einer klaren, korrigierbaren Meldung abgefangen statt mit einem rohen TypeError.',
      fr: 'Les appels d’outils sont désormais validés avant exécution : les paramètres manquants ou mal typés sont interceptés à l’entrée avec un message clair et corrigible au lieu d’un TypeError brut.',
      es: 'Las llamadas a herramientas ahora se validan antes de ejecutarse: los parámetros faltantes o mal tipados se interceptan en la entrada con un mensaje claro y corregible en lugar de un TypeError sin procesar.',
      ko: '도구 호출이 이제 실행 전에 검증됩니다: 누락되거나 잘못된 타입의 매개변수는 원시 TypeError 대신 명확하고 수정 가능한 메시지와 함께 입구에서 차단됩니다.',
    },
  },
  {
    version: '0.10.21',
    priority: 160,
    persistent: false,
    messages: {
      en: 'Grep can now show N lines of context around each match (context_lines), and no longer freezes the terminal while searching large repos.',
      zh: 'Grep 现在可以带上匹配行前后各 N 行上下文（context_lines），大仓库慢搜索时也不会再卡住终端。',
      de: 'Grep kann jetzt N Zeilen Kontext um jeden Treffer anzeigen (context_lines) und blockiert das Terminal nicht mehr bei der Suche in großen Repos.',
      fr: 'Grep peut désormais afficher N lignes de contexte autour de chaque correspondance (context_lines) et ne fige plus le terminal lors de recherches dans de grands dépôts.',
      es: 'Grep ahora puede mostrar N líneas de contexto alrededor de cada coincidencia (context_lines) y ya no bloquea la terminal al buscar en repositorios grandes.',
      ko: 'Grep가 이제 각 일치 항목 주변에 N줄의 컨텍스트를 표시할 수 있으며(context_lines), 대형 저장소 검색 중에도 터미널이 멈추지 않습니다.',
    },
  },
  {
    version: '0.10.19',
    priority: 150,
    persistent: false,
    messages: {
      en: 'Stability: parallel permission prompts now queue up one by one instead of silently hanging a task, and background failures no longer take down your terminal.',
      zh: '稳定性：并发权限确认改为排队逐个处理，不再悄悄卡死任务；后台错误也不会再把整个终端带崩。',
      de: 'Stabilität: Parallele Berechtigungsabfragen werden jetzt nacheinander gestellt, statt eine Aufgabe stumm hängen zu lassen; Hintergrundfehler reißen das Terminal nicht mehr mit.',
      fr: 'Stabilité : les demandes d’autorisation parallèles sont désormais traitées une par une au lieu de bloquer silencieusement une tâche ; les erreurs d’arrière-plan ne font plus tomber votre terminal.',
      es: 'Estabilidad: las solicitudes de permiso paralelas ahora se atienden en cola una por una en lugar de colgar silenciosamente una tarea; los errores en segundo plano ya no tumban tu terminal.',
      ko: '안정성: 동시 권한 확인이 이제 하나씩 순서대로 처리되어 작업이 조용히 멈추지 않으며, 백그라운드 오류가 더 이상 터미널을 종료시키지 않습니다.',
    },
  },
  {
    version: '0.10.12',
    priority: 140,
    persistent: false,
    messages: {
      en: 'Tool calls now glow while they run: a sweeping indigo light traces every live Bash, Read or Write — even quick ones finish their sweep before freezing, so the motion always reads cleanly, then vanishes the instant they land.',
      zh: '工具调用运行时会流光：一道靛蓝扫光划过正在执行的 Bash、Read、Write——再快的工具也会先把扫光播完再定格，动效始终连贯，落盘瞬间隐去、历史保持干净。',
      de: 'Tool-Aufrufe leuchten jetzt während der Ausführung: ein wanderndes Indigo-Licht streicht über jedes laufende Bash, Read oder Write — selbst schnelle Aufrufe spielen ihren Sweep zu Ende, bevor sie einfrieren, sodass die Bewegung stets sauber wirkt und im Moment des Abschlusses verschwindet.',
      fr: 'Les appels d’outils brillent désormais pendant leur exécution : une lumière indigo balaie chaque Bash, Read ou Write en cours — même les plus rapides terminent leur balayage avant de se figer, le mouvement reste donc toujours net, puis disparaît dès qu’ils se terminent.',
      es: 'Las llamadas a herramientas ahora brillan mientras se ejecutan: una luz índigo recorre cada Bash, Read o Write en curso — incluso las más rápidas completan su barrido antes de congelarse, así el movimiento siempre se lee con claridad y desaparece en cuanto terminan.',
      ko: '도구 호출이 실행 중에 빛납니다: 인디고 빛이 실행 중인 Bash, Read, Write를 훑고 지나갑니다 — 빠른 호출도 멈추기 전에 스윕을 끝까지 재생해 동작이 항상 매끄럽게 보이고, 완료되는 순간 사라집니다.',
    },
  },
  {
    version: '0.10.7',
    priority: 130,
    persistent: false,
    messages: {
      en: '/selection for quick research and task: run /selection start, then select text anywhere and press your shortcut — a floating Astraea panel opens with your selection ready (macOS & Windows).',
      zh: '/selection 让快速研究与任务随手可得：运行 /selection start，然后在任意位置选中文字、按下快捷键，即可弹出已带入选区的 Astraea 悬浮窗（支持 macOS 与 Windows）。',
      de: '/selection für schnelle Recherche und Aufgaben: /selection start ausführen, dann irgendwo Text auswählen und den Kurzbefehl drücken – ein schwebendes Astraea-Fenster öffnet sich mit deiner Auswahl (macOS & Windows).',
      fr: '/selection pour la recherche et les tâches rapides : lancez /selection start, sélectionnez du texte n’importe où et appuyez sur votre raccourci — un panneau Astraea flottant s’ouvre avec votre sélection (macOS & Windows).',
      es: '/selection para investigación y tareas rápidas: ejecuta /selection start, selecciona texto en cualquier lugar y pulsa tu atajo: se abre un panel flotante de Astraea con tu selección (macOS y Windows).',
      ko: '빠른 리서치와 작업을 위한 /selection: /selection start를 실행하고 어디서든 텍스트를 선택한 뒤 단축키를 누르면 선택 내용이 채워진 Astraea 플로팅 창이 열립니다 (macOS & Windows).',
    },
  },
  {
    version: '0.10.7',
    priority: 120,
    persistent: false,
    messages: {
      en: '/init can now scan a repo and create or update Astraea AGENTS.md instructions.',
      zh: '/init 现在可以扫描仓库并创建或更新 Astraea 的 AGENTS.md 项目指令。',
      de: '/init kann jetzt ein Repo scannen und Astraea-AGENTS.md-Anweisungen erstellen oder aktualisieren.',
      fr: '/init peut maintenant analyser un dépôt et créer ou mettre à jour les instructions AGENTS.md d’Astraea.',
      es: '/init ahora puede analizar un repo y crear o actualizar instrucciones AGENTS.md de Astraea.',
      ko: '/init이 이제 저장소를 스캔하고 Astraea AGENTS.md 지침을 만들거나 업데이트할 수 있습니다.',
    },
  },
  {
    version: '0.9.28',
    priority: 100,
    persistent: true,
    messages: {
      en: 'Ambiguous tasks → Counsel automatically. /goal: dynamic graphs, per-step criteria, sourced evidence. Stronger shell, MCP, network safety.',
      zh: '模糊任务 → Counsel；/goal 支持动态图、分步标准和可溯源证据。Shell、MCP、网络安全增强。',
      de: 'Unklare Aufgaben → Counsel. /goal: dynamische Graphen, Kriterien pro Schritt, belegte Nachweise. Verbesserter Shell-, MCP- und Netzwerkschutz.',
      fr: 'Tâches ambiguës → Counsel. /goal: graphes dynamiques, critères par étape, preuves sourcées. Sécurité Shell, MCP, réseau renforcée.',
      es: 'Tareas ambiguas → Counsel. /goal: grafos dinámicos, criterios por paso, evidencias con fuente. Seguridad Shell, MCP, red mejorada.',
      ko: '모호한 작업 → Counsel. /goal: 동적 그래프, 단계별 기준, 출처 증거. Shell, MCP, 네트워크 보안 강화.',
    },
  },
  {
    version: '0.9.26',
    priority: 100,
    persistent: true,
    messages: {
      en: 'DeepSeek models are now V4 Flash / Pro. Run /login to sign in again.',
      zh: 'DeepSeek 模型已升级为 V4 Flash / Pro，请运行 /login 重新登录。',
      de: 'DeepSeek-Modelle sind jetzt V4 Flash / Pro. Führe /login aus, um dich erneut anzumelden.',
      fr: 'Les modèles DeepSeek sont maintenant V4 Flash / Pro. Lancez /login pour vous reconnecter.',
      es: 'Los modelos DeepSeek ahora son V4 Flash / Pro. Ejecuta /login para volver a iniciar sesión.',
      ko: 'DeepSeek 모델이 V4 Flash / Pro로 변경되었습니다. /login을 실행해 다시 로그인하세요.',
    },
  },
  {
    version: '0.9.29',
    priority: 95,
    persistent: true,
    messages: {
      en: 'Todo and task capabilities are greatly improved in the latest version.',
      zh: 'Todo 和 task 的能力在最新版本中显著提高。',
      de: 'Todo- und Task-Funktionen wurden in der neuesten Version erheblich verbessert.',
      fr: 'Les capacités de todo et task sont considérablement améliorées dans la dernière version.',
      es: 'Las capacidades de todo y task han mejorado significativamente en la última versión.',
      ko: '최신 버전에서 todo 및 task 기능이 크게 향상되었습니다.',
    },
  },
]

export function getRecentUpdates(version: string, locale: Locale): string[] {
  return RECENT_UPDATES
    .filter(update => update.version === version || update.persistent)
    .sort((a, b) => b.priority - a.priority)
    .map(update => update.messages[locale])
}
