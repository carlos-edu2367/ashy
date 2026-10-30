import React, { useEffect, useState } from 'react'
import {
  ASHY_EMOTIONS,
  ASHY_MOTION_PRESETS,
  ASHY_TRAIT_CORRIDORS,
  BUILTIN_LIVE2D_MODEL_PRESETS,
  M2_GATE_THRESHOLDS,
  MILESTONE_CATEGORIES,
  SEMANTIC_FACT_CATEGORIES,
  STT_PROVIDER_IDS,
  TTS_PROVIDER_IDS,
  type ActionRiskTier,
  type ApprovableMemoryKind,
  type AshyEmotion,
  type AshyMotionPreset,
  type ComputerActionsPolicy,
  type Live2DBuiltinModelId,
  type MemoryGovernanceCategory,
  type MilestoneCategory,
  type SemanticFactCategory,
  type SttProviderId,
  type TtsProviderId,
} from '@ashy/shared'
import type { FsrsReviewRating } from '@ashy/cortex'
import { AshyStageCanvas, DEFAULT_ASHY_LIVE2D_MODEL3_JSON } from '@ashy/stage'
import {
  BookOpen,
  Box,
  Calendar,
  ChevronRight,
  ChevronUp,
  Database,
  Eye,
  EyeOff,
  Folder,
  Ghost,
  Heart,
  Home,
  Image,
  Link2,
  Lock,
  MessageCircle,
  Mic,
  MicOff,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  MousePointer,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  User,
  Volume2,
  Wifi,
  X,
} from 'lucide-react'
import { FirstMeetingWizard } from './components/FirstMeetingWizard'
import { ModelsSettingsPanel } from './components/ModelsSettingsPanel'
import {
  SUPPORTED_MODELS,
  useAshyStore,
  type FeaturedMemoryCard,
  type HubTabId,
  type MemoryFilterCategory,
  type SettingsSubTab,
} from './store/useAshyStore'

const TRAIT_META: ReadonlyArray<{
  key: 'warmthAffection' | 'chaosEnergy' | 'witSarcasm' | 'intellectualCuriosity' | 'proactivity'
  label: string
  humanLabel: string
  shortAlias: string
}> = [
  {
    key: 'warmthAffection',
    label: 'Warmth & Affection',
    humanLabel: 'Afeto e Acolhimento',
    shortAlias: 'warmth',
  },
  {
    key: 'chaosEnergy',
    label: 'Playfulness & Chaos Energy',
    humanLabel: 'Energia Criativa e Leveza',
    shortAlias: 'playfulness',
  },
  {
    key: 'witSarcasm',
    label: 'Wit & Sarcasm',
    humanLabel: 'Humor e Ironia Fina',
    shortAlias: 'sarcasm',
  },
  {
    key: 'intellectualCuriosity',
    label: 'Intellectual Curiosity',
    humanLabel: 'Curiosidade e Profundidade',
    shortAlias: 'curiosity',
  },
  {
    key: 'proactivity',
    label: 'Proactivity & Protective Drive',
    humanLabel: 'Cuidado e Iniciativa',
    shortAlias: 'protectiveDrive',
  },
]

const WAVEFORM_BARS: readonly number[] = [
  6, 10, 16, 12, 22, 28, 16, 20, 30, 14, 24, 18, 12, 26, 18, 14, 20, 12, 8,
]

const GOVERNANCE_CATEGORY_META: ReadonlyArray<{
  category: MemoryGovernanceCategory
  label: string
}> = [
  { category: 'facts', label: 'Fatos sobre você' },
  { category: 'episodes', label: 'Episódios' },
  { category: 'jokes', label: 'Piadas internas' },
  { category: 'habits', label: 'Hábitos' },
  { category: 'intents', label: 'Planos futuros' },
]

function AshySparkleLogo(): React.ReactElement {
  return (
    <svg
      className="ashy-brand-sparkle"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12.5 2.5C12.9 8.4 15.6 11.1 21.5 11.5C15.6 11.9 12.9 14.6 12.5 20.5C12.1 14.6 9.4 11.9 3.5 11.5C9.4 11.1 12.1 8.4 12.5 2.5Z"
        fill="#F4A688"
      />
      <path
        d="M21.5 16.5C21.7 19.1 22.9 20.3 25.5 20.5C22.9 20.7 21.7 21.9 21.5 24.5C21.3 21.9 20.1 20.7 17.5 20.5C20.1 20.3 21.3 19.1 21.5 16.5Z"
        fill="#CFC5E8"
      />
    </svg>
  )
}

function renderMemoryCategoryIcon(card: FeaturedMemoryCard): React.ReactElement {
  if (card.id === 'ep-padre-npm-origin') return <Ghost size={17} />
  if (card.id === 'ep-orin-ashy') return <Folder size={17} />
  if (card.filterCategory === 'sobre_voce') return <User size={17} />
  if (card.filterCategory === 'momentos') return <Image size={17} />
  if (card.filterCategory === 'planos') return <Calendar size={17} />
  return <Link2 size={17} />
}

export function App(): React.ReactElement {
  const storeState = useAshyStore()
  const state = typeof window === 'undefined' ? useAshyStore.getState() : storeState

  const [chatInput, setChatInput] = useState('')
  const [showCompiledPrompt, setShowCompiledPrompt] = useState(false)

  // Memory creation & editing state
  const [showNewMemoryModal, setShowNewMemoryModal] = useState(false)
  const [newMemTitle, setNewMemTitle] = useState('')
  const [newMemSummary, setNewMemSummary] = useState('')
  const [newMemCategory, setNewMemCategory] =
    useState<Exclude<MemoryFilterCategory, 'todas'>>('momentos')
  const [isEditingMemory, setIsEditingMemory] = useState(false)
  const [editMemoryTitle, setEditMemoryTitle] = useState('')
  const [editMemoryStory, setEditMemoryStory] = useState('')

  // Milestone form state
  const [msTitle, setMsTitle] = useState('')
  const [msNarrative, setMsNarrative] = useState('')
  const [msCategory, setMsCategory] = useState<MilestoneCategory>('project_shipped')
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null)
  const [editMsTitle, setEditMsTitle] = useState('')
  const [editMsNarrative, setEditMsNarrative] = useState('')
  const [editMsCategory, setEditMsCategory] = useState<MilestoneCategory>('project_shipped')

  // Semantic Fact form state
  const [factCategory, setFactCategory] = useState<SemanticFactCategory>('preference')
  const [factSubject, setFactSubject] = useState('User')
  const [factPredicate, setFactPredicate] = useState('favorite_stack_is')
  const [factObject, setFactObject] = useState('')

  // Voice Identity (voice.md) live editor state
  const [voiceDraft, setVoiceDraft] = useState(state.voiceIdentity.content)
  const [voiceSavedNotice, setVoiceSavedNotice] = useState<string | null>(null)
  const [m2EvalSeed, setM2EvalSeed] = useState<number>(0)
  const [live2dJsonDraft, setLive2dJsonDraft] = useState(() =>
    JSON.stringify(DEFAULT_ASHY_LIVE2D_MODEL3_JSON, null, 2),
  )
  const [live2dImportNotice, setLive2dImportNotice] = useState<string | null>(null)
  const [allowedPathDraft, setAllowedPathDraft] = useState('')

  useEffect(() => {
    void useAshyStore.getState().bootstrapFromHost()
  }, [])

  useEffect(() => {
    setVoiceDraft(state.voiceIdentity.content)
  }, [state.voiceIdentity.content])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      const key = event.key.toLowerCase()
      const current = useAshyStore.getState()
      if (key === 'm') {
        event.preventDefault()
        current.setMicMode(current.privacyState.micMode === 'muted' ? 'continuous' : 'muted')
      } else if (key === 'e') {
        event.preventDefault()
        const curEyes = current.privacyState.eyesMode
        const nextEyes = curEyes === 'off' ? 'window' : curEyes === 'window' ? 'screen' : 'off'
        current.setEyesMode(nextEyes)
      } else if (key === 'd') {
        event.preventDefault()
        current.setDndMode(!current.privacyState.dndMode)
      } else if (key === 'h') {
        event.preventDefault()
        current.toggleStageHidden()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const displayName = state.userProfile.userName ?? 'Carlos'

  const handleSendChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!chatInput.trim()) return
    const text = chatInput
    setChatInput('')
    await state.sendUserMessage(text)
  }

  // ==========================================================================
  // MODE A: FLOATING STAGE OVERLAY
  // ==========================================================================
  if (state.viewMode === 'stage') {
    const cycleQuickEyes = () => {
      const cur = state.privacyState.eyesMode
      const next = cur === 'off' ? 'window' : cur === 'window' ? 'screen' : 'off'
      state.setEyesMode(next)
    }

    return (
      <div
        data-testid="floating-stage-overlay"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: state.isTransparentOverlayWindow
            ? 'transparent'
            : 'radial-gradient(circle at 50% 38%, #261f35 0%, #111017 80%)',
        }}
      >
        <div
          className="ashy-card"
          style={{
            width: '410px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '14px',
            background: state.isTransparentOverlayWindow
              ? 'transparent'
              : 'rgba(24, 21, 34, 0.92)',
            backdropFilter: state.isTransparentOverlayWindow ? 'none' : 'blur(18px)',
            border: state.isTransparentOverlayWindow
              ? 'none'
              : '1px solid rgba(244, 166, 136, 0.38)',
            boxShadow: state.isTransparentOverlayWindow
              ? 'none'
              : '0 24px 60px rgba(0, 0, 0, 0.65)',
          }}
        >
          <div
            data-ui-island="true"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="ashy-badge peach">Modo flutuante</span>
              <span className="ashy-badge violet">{state.activeModelId}</span>
            </div>
            <button
              type="button"
              className="ashy-peach-btn"
              style={{ padding: '7px 14px', fontSize: '12.5px' }}
              data-testid="btn-expand-hub"
              onClick={() => state.setViewMode('hub')}
            >
              Voltar ao estúdio
            </button>
          </div>

          {state.isStageHidden ? (
            <button
              type="button"
              className="ashy-peach-btn"
              data-testid="btn-restore-hidden-stage"
              data-ui-island="true"
              style={{ padding: '10px 18px', fontSize: '13px' }}
              onClick={() => state.setStageHidden(false)}
            >
              Mostrar Ashy (Alt+H)
            </button>
          ) : (
            <div
              style={{
                borderRadius: '14px',
                overflow: 'hidden',
                border: state.isTransparentOverlayWindow
                  ? 'none'
                  : '1px solid var(--border-soft)',
              }}
            >
              <AshyStageCanvas
                emotion={state.stageEmotion}
                emotionIntensity={state.emotionIntensity}
                isSpeaking={state.isSpeaking}
                rawVowels={state.simulatedVowels}
                rawVolume={state.isSpeaking ? 0.82 : 0}
                ambientLuminance={state.ambientLuminance}
                bubbleText={state.bubbleText}
                statusLabel={state.presenceStatus}
                mode={state.stageMode}
                motionPreset={state.activeMotion}
                live2dControls={state.live2dModelControls}
                live2dModelUrl={state.live2dModelUrl}
                transparentBackground={state.isTransparentOverlayWindow}
                onIgnoreMouseChange={(ignore) => state.setStageIgnoreMouseEvents(ignore)}
                width={380}
                height={460}
              />
            </div>
          )}

          {/* Stage Quick Controls Island */}
          <div
            data-testid="stage-quick-controls"
            data-ui-island="true"
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '10px 12px',
              borderRadius: '12px',
              background: 'rgba(21, 19, 31, 0.94)',
              border: '1px solid rgba(244, 166, 136, 0.35)',
            }}
          >
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px', flex: 1 }}
                data-testid="btn-quick-mic"
                onClick={() =>
                  state.setMicMode(
                    state.privacyState.micMode === 'muted' ? 'continuous' : 'muted',
                  )
                }
              >
                Mic ({state.privacyState.micMode})
              </button>
              <button
                type="button"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px', flex: 1 }}
                data-testid="btn-quick-eyes"
                onClick={cycleQuickEyes}
              >
                Eyes ({state.privacyState.eyesMode})
              </button>
              <button
                type="button"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px', flex: 1 }}
                data-testid="btn-quick-dnd"
                onClick={() => state.setDndMode(!state.privacyState.dndMode)}
              >
                DND ({state.privacyState.dndMode ? 'ON' : 'OFF'})
              </button>
              <button
                type="button"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px', flex: 1 }}
                data-testid="btn-quick-hide-stage"
                onClick={() => state.toggleStageHidden()}
              >
                {state.isStageHidden ? 'Mostrar' : 'Ocultar'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <span className="ashy-badge peach" data-testid="stage-clickthrough-badge">
                Click-Through: {state.ignoringMouseEvents ? 'ON' : 'OFF'}
              </span>
              <span className="ashy-badge violet" data-testid="stage-active-viseme-badge">
                Visema: {state.activeViseme}
              </span>
              <span className="ashy-badge emerald" data-testid="stage-active-motion-badge">
                Movimento: {state.activeMotion}
              </span>
            </div>
          </div>

          {state.pendingActions.length > 0 && (
            <div
              data-testid="stage-pending-action-bubble"
              data-ui-island="true"
              style={{
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '10px 12px',
                borderRadius: '12px',
                background: 'rgba(28, 22, 38, 0.96)',
                border: '1px solid rgba(242, 190, 121, 0.55)',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-peach)' }}>
                Permissão solicitada pela Ashy ({state.pendingActions.length})
              </div>
              {state.pendingActions.map((card) => (
                <div
                  key={card.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    fontSize: '11.5px',
                  }}
                >
                  <div>
                    <strong>{card.toolName}</strong> — {card.summary}
                  </div>
                  {card.targetPath && (
                    <div>
                      Caminho: <code>{card.targetPath}</code>
                    </div>
                  )}
                  {card.commandPreview && (
                    <div>
                      Comando: <code>{card.commandPreview}</code>
                    </div>
                  )}
                  {card.diffPreview && (
                    <pre
                      style={{
                        margin: 0,
                        padding: '6px 8px',
                        borderRadius: '8px',
                        background: '#12101b',
                        fontSize: '10.5px',
                        overflowX: 'auto',
                      }}
                    >
                      {card.diffPreview}
                    </pre>
                  )}
                  {card.blastRadiusWarning && (
                    <div style={{ color: 'var(--status-danger)', fontWeight: 600 }}>
                      ⚠️ {card.blastRadiusWarning}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ashy-peach-btn"
                      style={{ padding: '4px 10px', fontSize: '11px' }}
                      data-testid={`btn-stage-approve-once-${card.id}`}
                      onClick={() => void state.approvePendingAction(card.id, 'once')}
                    >
                      Aprovar uma vez
                    </button>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      style={{ padding: '4px 10px', fontSize: '11px' }}
                      data-testid={`btn-stage-approve-session-${card.id}`}
                      onClick={() => void state.approvePendingAction(card.id, 'session')}
                    >
                      Permitir na sessão
                    </button>
                    <button
                      type="button"
                      className="ashy-danger-outline-btn"
                      style={{ padding: '4px 10px', fontSize: '11px' }}
                      data-testid={`btn-stage-deny-${card.id}`}
                      onClick={() => state.denyPendingAction(card.id)}
                    >
                      Recusar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div
            data-ui-island="true"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              padding: '8px 12px',
              borderRadius: '10px',
              background: '#15131f',
              fontSize: '12px',
              color: 'var(--text-secondary)',
            }}
          >
            <span>Voz: {state.privacyState.micMode}</span>
            <span>Tela: {state.privacyState.eyesMode}</span>
            <span>Silêncio: {state.privacyState.dndMode ? 'Ativo' : 'Livre'}</span>
            <button
              type="button"
              className="ashy-danger-outline-btn"
              style={{ padding: '5px 10px', fontSize: '11.5px' }}
              data-testid="btn-stage-barge-in"
              onClick={() => state.triggerBargeIn(600)}
            >
              Interromper
            </button>
          </div>

          <form
            data-ui-island="true"
            onSubmit={handleSendChat}
            style={{ width: '100%', display: 'flex', gap: '8px' }}
          >
            <input
              type="text"
              className="ashy-input"
              data-testid="stage-chat-input"
              style={{ flex: 1 }}
              placeholder="Fale com a Ashy..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button type="submit" className="ashy-peach-btn" data-testid="btn-stage-send">
              Enviar
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ==========================================================================
  // MODE B: COMPANION HUB (COZY NIGHT STUDIO SHELL)
  // ==========================================================================
  const navItems: ReadonlyArray<{
    id: HubTabId
    label: string
    testId: string
    icon: React.ReactElement
  }> = [
    {
      id: 'studio',
      label: 'Companhia',
      testId: 'tab-studio',
      icon: state.activeTab === 'studio' ? <Home size={18} /> : <MessageCircle size={18} />,
    },
    {
      id: 'memories',
      label: 'Memórias',
      testId: 'tab-memories',
      icon: <BookOpen size={18} />,
    },
    {
      id: 'story',
      label: 'Nossa história',
      testId: 'tab-story',
      icon: <Heart size={18} />,
    },
    {
      id: 'personality',
      label: 'Aparência',
      testId: 'tab-personality',
      icon: <Palette size={18} />,
    },
    {
      id: 'agency',
      label: 'Configurações',
      testId: 'tab-agency',
      icon: <Settings size={18} />,
    },
  ]

  // Filtered memories for View 2 (Memórias)
  const filteredMemoryCards = state.memoryCards.filter((card) => {
    const matchesCategory =
      state.memoryFilter === 'todas' || card.filterCategory === state.memoryFilter
    const q = state.memorySearchQuery.trim().toLowerCase()
    const matchesQuery =
      !q ||
      card.title.toLowerCase().includes(q) ||
      card.summary.toLowerCase().includes(q) ||
      card.fullStory.toLowerCase().includes(q)
    return matchesCategory && matchesQuery
  })

  const topRowCards = filteredMemoryCards.filter((c) => c.featured)
  const bottomRowCards = filteredMemoryCards.filter((c) => !c.featured)

  const pendingReviewItems: Array<{
    id: string
    kind: ApprovableMemoryKind
    kindLabel: string
    title: string
    detail: string
    provenanceEpisodeId?: string
  }> = [
    ...state.semanticFacts
      .filter((f) => f.approvalStatus === 'pending_review')
      .map((f) => ({
        id: f.id,
        kind: 'fact' as const,
        kindLabel: 'Fato semântico',
        title: `${f.predicate}: ${f.object}`,
        detail: `${f.subject} (${f.category})`,
        provenanceEpisodeId: f.sourceEpisodeIds[0],
      })),
    ...state.episodicMemories
      .filter((ep) => ep.approvalStatus === 'pending_review')
      .map((ep) => ({
        id: ep.id,
        kind: 'episode' as const,
        kindLabel: 'Episódio',
        title: ep.title,
        detail: ep.summary,
        provenanceEpisodeId: ep.id,
      })),
    ...state.relationalMotifs
      .filter((m) => m.approvalStatus === 'pending_review')
      .map((m) => ({
        id: m.id,
        kind: 'joke' as const,
        kindLabel: 'Piada interna',
        title: m.motif,
        detail: m.originSummary,
        provenanceEpisodeId: m.originEpisodeId,
      })),
    ...state.userHabits
      .filter((h) => h.approvalStatus === 'pending_review')
      .map((h) => ({
        id: h.id,
        kind: 'habit' as const,
        kindLabel: 'Hábito',
        title: h.patternKey,
        detail: h.description,
        provenanceEpisodeId: h.sourceEpisodeId,
      })),
    ...state.prospectiveIntents
      .filter((i) => i.approvalStatus === 'pending_review')
      .map((i) => ({
        id: i.id,
        kind: 'intent' as const,
        kindLabel: 'Plano futuro',
        title: i.topic,
        detail: i.contextCue,
        provenanceEpisodeId: i.sourceEpisodeId,
      })),
  ]

  const approvedMotifs = state.relationalMotifs.filter(
    (m) => m.approvalStatus !== 'pending_review',
  )
  const approvedHabits = state.userHabits.filter((h) => h.approvalStatus !== 'pending_review')
  const approvedIntents = state.prospectiveIntents.filter(
    (i) => i.approvalStatus !== 'pending_review',
  )
  const approvedFacts = state.semanticFacts.filter(
    (f) => f.approvalStatus !== 'pending_review',
  )

  const selectedMemoryCard =
    state.memoryCards.find((c) => c.id === state.selectedMemoryId) ??
    filteredMemoryCards[0] ??
    state.memoryCards[0]

  const currentModelMeta =
    SUPPORTED_MODELS.find((m) => m.id === state.activeModelId) ?? SUPPORTED_MODELS[0]

  const showSidebarPortrait =
    state.activeTab === 'memories' ||
    state.activeTab === 'story' ||
    state.activeTab === 'personality'

  return (
    <div className="ashy-window" data-testid="companion-hub">
      {state.needsOnboarding && <FirstMeetingWizard />}

      {/* Subtle Desktop Window Chrome Controls */}
      <div className="ashy-window-controls" aria-label="Controles da janela">
        <button type="button" className="ashy-win-btn" title="Minimizar">
          <Minus size={13} />
        </button>
        <button type="button" className="ashy-win-btn" title="Maximizar">
          <Square size={11} />
        </button>
        <button type="button" className="ashy-win-btn" title="Fechar">
          <X size={13} />
        </button>
      </div>

      {/* ====================================================================
          LEFT SIDEBAR (.ashy-sidebar)
         ==================================================================== */}
      <aside className="ashy-sidebar">
        <div className="ashy-sidebar-top">
          <div className="ashy-brand">
            <AshySparkleLogo />
            <span className="ashy-brand-wordmark">ashy</span>
          </div>

          <nav className="ashy-nav" aria-label="Navegação principal">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={item.testId}
                className={`ashy-nav-item ${state.activeTab === item.id ? 'active' : ''}`}
                onClick={() => state.setActiveTab(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="ashy-sidebar-bottom">
          {showSidebarPortrait && (
            <div className="ashy-sidebar-portrait">
              <img
                src={
                  state.stageEmotion === 'concerned' || state.stageEmotion === 'sad'
                    ? '/assets/ashy-concerned.jpg'
                    : '/assets/ashy-hero.jpg'
                }
                alt="Ashy presente no estúdio"
              />
            </div>
          )}

          <div
            className="ashy-user-footer"
            onClick={() => state.setActiveTab('agency')}
            style={{ cursor: 'pointer' }}
          >
            <div className="ashy-user-info">
              <div className="ashy-user-avatar">
                <img
                  src="/assets/carlos-avatar.jpg"
                  alt="Carlos"
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                />
                <span className="ashy-user-avatar-dot" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="ashy-user-name">{displayName}</div>
                <div className="ashy-user-status">Sempre por aqui. ♡</div>
              </div>
            </div>
            <ChevronRight size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          </div>
        </div>
      </aside>

      {/* ====================================================================
          MAIN CONTENT AREA
         ==================================================================== */}
      <main style={{ minWidth: 0, overflowY: 'auto', maxHeight: '100vh' }}>
        {/* ==================================================================
            VIEW 1: COMPANHIA (HERO STAGE + FLOATING VOICE DOCK + NOSSA CONVERSA)
           ================================================================== */}
        {state.activeTab === 'studio' && (
          <div className="ashy-companhia-layout">
            {/* Center Hero Stage */}
            <section className="ashy-hero-stage">
              <div className="ashy-stage-canvas-wrap">
                <AshyStageCanvas
                  emotion={state.stageEmotion}
                  emotionIntensity={state.emotionIntensity}
                  isSpeaking={state.isSpeaking}
                  rawVowels={state.simulatedVowels}
                  rawVolume={state.isSpeaking ? 0.85 : 0}
                  ambientLuminance={state.ambientLuminance}
                  bubbleText={state.bubbleText}
                  statusLabel={state.presenceStatus}
                  mode={state.stageMode}
                  motionPreset={state.activeMotion}
                  live2dControls={state.live2dModelControls}
                  live2dModelUrl={state.live2dModelUrl}
                  transparentBackground={state.isTransparentOverlayWindow}
                  onIgnoreMouseChange={(ignore) => state.setStageIgnoreMouseEvents(ignore)}
                  width={860}
                  height={760}
                  fullBleed={true}
                  hideBubble={true}
                />
              </div>

              {/* Top Stage Greeting & Runtime Status Pill */}
              <div className="ashy-stage-top-bar">
                <div className="ashy-stage-greeting">
                  <h1 className="ashy-serif-hero">Bom te ver, {displayName}.</h1>
                  <div className="ashy-stage-presence">
                    <span className="ashy-presence-dot" />
                    <span data-testid="seriousness-gate-badge">
                      {state.lastPrompt.seriousness.isSeriousOrDelicate
                        ? 'Por aqui, acolhendo você com calma.'
                        : 'Por aqui, com você.'}
                    </span>
                  </div>
                </div>

                <div className="ashy-stage-pills">
                  <button
                    type="button"
                    className="ashy-stage-pill active"
                    onClick={() => state.toggleSimulatedSpeech()}
                    title="Alternar voz local"
                  >
                    <Mic size={13} />
                    <span>Voz local</span>
                    <span
                      className="ashy-presence-dot"
                      style={{ width: '6px', height: '6px' }}
                    />
                  </button>
                  <button
                    type="button"
                    className="ashy-stage-pill muted"
                    onClick={() => {
                      const idx = SUPPORTED_MODELS.findIndex((m) => m.id === state.activeModelId)
                      const next = SUPPORTED_MODELS[(idx + 1) % SUPPORTED_MODELS.length]
                      if (next) state.setActiveModelId(next.id)
                    }}
                    title={`Modelo ativo: ${currentModelMeta?.label} (clique para alternar)`}
                  >
                    <span>Modelo no seu computador</span>
                  </button>
                </div>
              </div>

              {/* Bottom Floating Voice Dock */}
              <div className="ashy-voice-dock-wrap">
                <div className="ashy-voice-dock" data-ui-island="true">
                  <div className="ashy-dock-action">
                    <button
                      type="button"
                      data-testid="btn-mute-mic"
                      className={`ashy-dock-circle-btn ${
                        state.privacyState.micMode === 'muted' ? 'active' : ''
                      }`}
                      onClick={() =>
                        state.setMicMode(
                          state.privacyState.micMode === 'muted' ? 'continuous' : 'muted',
                        )
                      }
                      title="Silenciar microfone"
                    >
                      <MicOff size={17} />
                    </button>
                    <span className="ashy-dock-label">
                      {state.privacyState.micMode === 'muted' ? 'Silenciado' : 'Silenciar'}
                    </span>
                  </div>

                  {/* Left Waveform */}
                  <div className="ashy-waveform" aria-hidden="true">
                    {WAVEFORM_BARS.map((h, i) => (
                      <span
                        key={`wf-l-${i}`}
                        className="ashy-waveform-bar"
                        style={{
                          height: `${state.isSpeaking ? Math.min(32, Math.round(h * 1.15)) : h}px`,
                          opacity: state.isSpeaking ? 0.95 : 0.65,
                        }}
                      />
                    ))}
                  </div>

                  {/* Center Warm Peach Mic Orb */}
                  <div className="ashy-dock-action">
                    <button
                      type="button"
                      data-testid="btn-toggle-lipsync"
                      className={`ashy-mic-hero-btn ${state.isSpeaking ? 'listening' : ''}`}
                      onClick={() => state.toggleSimulatedSpeech()}
                      title="Conversar por voz"
                    >
                      <Mic size={22} />
                    </button>
                    <span
                      className="ashy-dock-label"
                      style={{ color: 'var(--text-primary)', fontWeight: 500 }}
                    >
                      {state.isSpeaking ? 'Falando com você...' : 'Conversar por voz'}
                    </span>
                  </div>

                  {/* Right Waveform */}
                  <div className="ashy-waveform" aria-hidden="true">
                    {[...WAVEFORM_BARS].reverse().map((h, i) => (
                      <span
                        key={`wf-r-${i}`}
                        className="ashy-waveform-bar"
                        style={{
                          height: `${state.isSpeaking ? Math.min(32, Math.round(h * 1.15)) : h}px`,
                          opacity: state.isSpeaking ? 0.95 : 0.65,
                        }}
                      />
                    ))}
                  </div>

                  <div className="ashy-dock-action">
                    <button
                      type="button"
                      data-testid="btn-switch-stage"
                      className="ashy-dock-circle-btn"
                      onClick={() => state.setViewMode('stage')}
                      title="Esconder avatar em modo flutuante"
                    >
                      <EyeOff size={17} />
                    </button>
                    <span className="ashy-dock-label">Esconder avatar</span>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Conversation Panel ("Nossa conversa") */}
            <aside className="ashy-chat-panel">
              <header className="ashy-chat-header">
                <div className="ashy-chat-header-top">
                  <h2 className="ashy-serif-panel">Nossa conversa</h2>
                  <button
                    type="button"
                    className="ashy-icon-btn"
                    onClick={() => setShowCompiledPrompt(!showCompiledPrompt)}
                    title="Momentos rápidos e contexto"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
                <p className="ashy-subtitle">
                  Uma companhia para os seus dias, pensamentos e devaneios.
                </p>
              </header>

              {/* Conversation Stream */}
              <div className="ashy-chat-stream" data-testid="chat-transcript">
                {state.chatMessages.map((msg) =>
                  msg.role === 'user' ? (
                    <div key={msg.id} className="ashy-msg-group user">
                      <div className="ashy-msg-meta">
                        <span>{msg.timeLabel ?? '21:14'}</span>
                      </div>
                      <div className="ashy-msg-row">
                        <div className="ashy-msg-bubble">{msg.content}</div>
                        <div className="ashy-msg-avatar">
                          <img
                            src="/assets/carlos-avatar.jpg"
                            alt="Carlos"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={msg.id} className="ashy-msg-group ashy">
                      <div className="ashy-msg-meta" style={{ paddingLeft: '42px' }}>
                        <strong style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
                          Ashy
                        </strong>
                        <span>{msg.timeLabel ?? '21:14'}</span>
                      </div>
                      <div className="ashy-msg-row">
                        <div className="ashy-msg-avatar">
                          <img
                            src={
                              msg.emotion === 'concerned' || msg.emotion === 'sad'
                                ? '/assets/ashy-concerned.jpg'
                                : '/assets/ashy-hero.jpg'
                            }
                            alt="Ashy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        </div>
                        <div className="ashy-msg-bubble">{msg.content}</div>
                      </div>

                      {msg.jokeCard && (
                        <div
                          className="ashy-joke-card"
                          data-testid={`joke-callback-card-${msg.id}`}
                          onClick={() => {
                            state.setSelectedMemoryId(msg.jokeCard!.memoryId)
                            state.setActiveTab('memories')
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                            <div className="ashy-joke-card-icon">
                              <BookOpen size={15} />
                            </div>
                            <div>
                              <div className="ashy-joke-card-title">{msg.jokeCard.title}</div>
                              <p className="ashy-joke-card-desc">{msg.jokeCard.description}</p>
                            </div>
                          </div>
                          <ChevronRight
                            size={16}
                            style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                          />
                        </div>
                      )}
                    </div>
                  ),
                )}

                {state.lastTurnError && (
                  <div
                    data-testid="turn-error-banner"
                    style={{
                      padding: '12px 14px',
                      borderRadius: '12px',
                      background: 'rgba(217, 107, 112, 0.12)',
                      border: '1px solid rgba(217, 107, 112, 0.38)',
                      fontSize: '12px',
                      color: '#f5b5b8',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {state.lastTurnError.code}: {state.lastTurnError.message}
                    </div>
                    {state.lastTurnError.code === 'PROVIDER_NOT_CONFIGURED' && (
                      <div>
                        <button
                          type="button"
                          className="ashy-outline-btn"
                          style={{ padding: '4px 10px', fontSize: '11.5px' }}
                          onClick={() => {
                            state.setActiveTab('agency')
                            state.setSettingsSubTab('modelos')
                          }}
                        >
                          Configurar em Ajustes &gt; Modelos
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {state.persistenceWarning && (
                  <div
                    data-testid="persistence-warning-banner"
                    style={{
                      padding: '10px 12px',
                      borderRadius: '10px',
                      background: 'rgba(242, 190, 121, 0.12)',
                      border: '1px solid rgba(242, 190, 121, 0.35)',
                      fontSize: '11.5px',
                      color: 'var(--status-amber)',
                    }}
                  >
                    Aviso de persistência local: {state.persistenceWarning}
                  </div>
                )}

                {state.lastPlaybackReceipt && (
                  <div
                    data-testid="playback-receipt-card"
                    style={{
                      padding: '12px 14px',
                      borderRadius: '12px',
                      background: 'rgba(244, 166, 136, 0.08)',
                      border: '1px solid rgba(244, 166, 136, 0.28)',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        color: 'var(--accent-peach)',
                        marginBottom: '4px',
                      }}
                    >
                      Fala interrompida aos {state.lastPlaybackReceipt.throughMs}ms
                    </div>
                    <div>
                      <strong>Você ouviu:</strong> "{state.lastPlaybackReceipt.heardText}"
                    </div>
                    <div style={{ opacity: 0.75, marginTop: '2px' }}>
                      <strong>Pausado:</strong> "{state.lastPlaybackReceipt.unheardText}"
                    </div>
                  </div>
                )}

                {showCompiledPrompt && (
                  <div
                    data-testid="compiled-prompt-preview"
                    style={{
                      padding: '10px 12px',
                      borderRadius: '10px',
                      background: '#171421',
                      border: '1px solid var(--border-subtle)',
                      fontSize: '11px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                      Contexto ativo ({state.activeModelId}) • Humor:{' '}
                      <span data-testid="mood-vector-readout">
                        [{state.mood.valence.toFixed(2)}, {state.mood.arousal.toFixed(2)},{' '}
                        {state.mood.playfulness.toFixed(2)}]
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {SUPPORTED_MODELS.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          data-testid={`model-btn-${m.id}`}
                          className={`ashy-filter-pill ${
                            state.activeModelId === m.id ? 'active' : ''
                          }`}
                          style={{ padding: '3px 8px', fontSize: '10.5px' }}
                          onClick={() => state.setActiveModelId(m.id)}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Inline Pending Actions Bar in Studio Chat */}
              {state.pendingActions.length > 0 && (
                <div
                  data-testid="chat-pending-actions-bar"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    padding: '10px 14px',
                    borderTop: '1px solid rgba(242, 190, 121, 0.35)',
                    background: 'rgba(26, 22, 38, 0.92)',
                  }}
                >
                  {state.pendingActions.map((card) => (
                    <div
                      key={card.id}
                      data-testid={`chat-pending-action-${card.id}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        padding: '8px 10px',
                        borderRadius: '10px',
                        background: '#171421',
                        border: '1px solid rgba(242, 190, 121, 0.45)',
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                        <strong>{card.summary}</strong>
                        <span className="ashy-badge amber">{card.riskTier}</span>
                      </div>
                      {card.targetPath && (
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                          Arquivo: <code>{card.targetPath}</code>
                        </div>
                      )}
                      {card.commandPreview && (
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                          Comando: <code>{card.commandPreview}</code>
                        </div>
                      )}
                      {card.diffPreview && (
                        <pre
                          style={{
                            margin: 0,
                            padding: '6px 8px',
                            borderRadius: '8px',
                            background: '#12101b',
                            fontSize: '11px',
                            overflowX: 'auto',
                          }}
                        >
                          {card.diffPreview}
                        </pre>
                      )}
                      {card.blastRadiusWarning && (
                        <div style={{ color: 'var(--status-danger)', fontWeight: 600 }}>
                          ⚠️ {card.blastRadiusWarning}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="ashy-peach-btn"
                          style={{ padding: '4px 10px', fontSize: '11.5px' }}
                          data-testid={`btn-chat-approve-once-${card.id}`}
                          onClick={() => void state.approvePendingAction(card.id, 'once')}
                        >
                          Aprovar uma vez
                        </button>
                        <button
                          type="button"
                          className="ashy-outline-btn"
                          style={{ padding: '4px 10px', fontSize: '11.5px' }}
                          data-testid={`btn-chat-approve-session-${card.id}`}
                          onClick={() => void state.approvePendingAction(card.id, 'session')}
                        >
                          Permitir na sessão
                        </button>
                        <button
                          type="button"
                          className="ashy-danger-outline-btn"
                          style={{ padding: '4px 10px', fontSize: '11.5px' }}
                          data-testid={`btn-chat-deny-${card.id}`}
                          onClick={() => state.denyPendingAction(card.id)}
                        >
                          Recusar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Bottom Chat Composer */}
              <div className="ashy-chat-composer-wrap">
                {showCompiledPrompt && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      flexWrap: 'wrap',
                      marginBottom: '8px',
                    }}
                  >
                    <button
                      type="button"
                      data-testid="btn-scenario-joke"
                      className="ashy-filter-pill"
                      style={{ padding: '3px 9px', fontSize: '11px' }}
                      onClick={() =>
                        state.sendUserMessage(
                          'O servidor caiu sem nenhum log no backend, vamos chamar um padre no npm?',
                        )
                      }
                    >
                      Brincadeira nossa
                    </button>
                    <button
                      type="button"
                      data-testid="btn-scenario-serious"
                      className="ashy-filter-pill"
                      style={{ padding: '3px 9px', fontSize: '11px' }}
                      onClick={() =>
                        state.sendUserMessage(
                          'Estou exausto, deu tudo errado hoje e tô me sentindo um lixo.',
                        )
                      }
                    >
                      Desabafo sério
                    </button>
                    <button
                      type="button"
                      data-testid="btn-scenario-barge-in"
                      className="ashy-filter-pill"
                      style={{ padding: '3px 9px', fontSize: '11px' }}
                      onClick={async () => {
                        await state.sendUserMessage(
                          'Me explica toda a nossa arquitetura e conta uma piada longa!',
                        )
                        state.triggerBargeIn(600)
                      }}
                    >
                      Cortar fala
                    </button>
                    <button
                      type="button"
                      data-testid="btn-barge-in"
                      className="ashy-filter-pill"
                      style={{ padding: '3px 9px', fontSize: '11px' }}
                      onClick={() => state.triggerBargeIn(600)}
                    >
                      Pausar voz
                    </button>
                  </div>
                )}
                {!showCompiledPrompt && (
                  <div style={{ display: 'none' }}>
                    <button
                      type="button"
                      data-testid="btn-scenario-joke"
                      onClick={() =>
                        state.sendUserMessage(
                          'O servidor caiu sem nenhum log no backend, vamos chamar um padre no npm?',
                        )
                      }
                    />
                    <button
                      type="button"
                      data-testid="btn-scenario-serious"
                      onClick={() =>
                        state.sendUserMessage(
                          'Estou exausto, deu tudo errado hoje e tô me sentindo um lixo.',
                        )
                      }
                    />
                    <button
                      type="button"
                      data-testid="btn-scenario-barge-in"
                      onClick={async () => {
                        await state.sendUserMessage(
                          'Me explica toda a nossa arquitetura e conta uma piada longa!',
                        )
                        state.triggerBargeIn(600)
                      }}
                    />
                    <button
                      type="button"
                      data-testid="btn-barge-in"
                      onClick={() => state.triggerBargeIn(600)}
                    />
                    <button
                      type="button"
                      data-testid="btn-studio-send"
                      onClick={() => void handleSendChat()}
                    />
                  </div>
                )}
                <form onSubmit={handleSendChat} className="ashy-chat-composer">
                  <textarea
                    data-testid="studio-chat-input"
                    className="ashy-composer-input"
                    rows={2}
                    placeholder="O que está passando pela sua cabeça?"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void handleSendChat()
                      }
                    }}
                  />
                  <div className="ashy-composer-toolbar">
                    <button
                      type="button"
                      className="ashy-icon-btn"
                      style={{ background: 'transparent', border: 'none' }}
                      title="Compartilhar imagem"
                    >
                      <Image size={18} />
                    </button>
                    <button
                      type="submit"
                      data-testid="studio-send-btn"
                      className="ashy-send-btn"
                      title="Enviar"
                    >
                      <Send size={15} />
                    </button>
                  </div>
                </form>
              </div>
            </aside>
          </div>
        )}

        {/* ==================================================================
            VIEW 2: MEMÓRIAS ("O QUE FICA COM A GENTE" + BENTO GRID + DRAWER)
           ================================================================== */}
        {state.activeTab === 'memories' && (
          <div className="ashy-page-container" data-testid="panel-episodic-memories">
            {/* Page Header */}
            <header className="ashy-page-header">
              <div>
                <h1 className="ashy-serif-title">O que fica com a gente</h1>
                <p className="ashy-subtitle">
                  Lembranças que dão continuidade à nossa história.
                </p>
              </div>

              <div className="ashy-header-actions">
                <div className="ashy-search-box">
                  <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input
                    type="text"
                    data-testid="input-memory-search"
                    placeholder="Buscar uma lembrança"
                    value={state.memorySearchQuery}
                    onChange={(e) => state.searchMemories(e.target.value)}
                  />
                </div>

                <button
                  type="button"
                  data-testid="btn-consolidate-memories"
                  className="ashy-outline-btn"
                  onClick={() => void state.consolidateSessionMemories(true)}
                >
                  <Sparkles size={15} />
                  <span>Consolidar Agora</span>
                </button>

                <button
                  type="button"
                  data-testid="btn-new-memory"
                  className="ashy-peach-btn"
                  onClick={() => setShowNewMemoryModal(!showNewMemoryModal)}
                >
                  <Plus size={16} />
                  <span>Nova memória</span>
                </button>
              </div>
            </header>

            {/* Memory Governance Panel (Auto vs. Confirm per category) */}
            <section
              className="ashy-card"
              data-testid="memory-governance-panel"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                padding: '12px 16px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '13.5px' }}>
                    Governança de Memória Autônoma
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Escolha quais categorias são salvas automaticamente e quais exigem sua aprovação em quarentena antes de entrar no contexto.
                  </div>
                </div>
                <span className="ashy-badge violet">
                  {pendingReviewItems.length} pendentes
                </span>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {GOVERNANCE_CATEGORY_META.map((item) => {
                  const requireConfirm = state.memoryGovernancePolicy[item.category]
                  return (
                    <button
                      key={item.category}
                      type="button"
                      data-testid={`governance-toggle-${item.category}`}
                      aria-pressed={requireConfirm}
                      className={`ashy-filter-pill ${requireConfirm ? 'active' : ''}`}
                      onClick={() =>
                        void state.setMemoryGovernancePolicy(
                          item.category,
                          !requireConfirm,
                        )
                      }
                    >
                      <span>{item.label}:</span>
                      <strong>
                        {requireConfirm ? 'Pedir confirmação' : 'Automático'}
                      </strong>
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Quarantine / Pending Review Memories */}
            {pendingReviewItems.length > 0 && (
              <section
                className="ashy-card"
                data-testid="pending-review-memories"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  padding: '12px 16px',
                  border: '1px solid rgba(242, 190, 121, 0.45)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '13.5px' }}>
                    Memórias pendentes de aprovação ({pendingReviewItems.length})
                  </div>
                  <span className="ashy-badge amber">Quarentena ativa</span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {pendingReviewItems.map((item) => (
                    <div
                      key={`${item.kind}-${item.id}`}
                      data-testid={`pending-memory-item-${item.id}`}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '10px',
                        background: '#171421',
                        border: '1px solid var(--border-subtle)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span className="ashy-badge amber">{item.kindLabel}</span>
                          <strong style={{ fontSize: '13px' }}>{item.title}</strong>
                          {item.provenanceEpisodeId && (
                            <span
                              className="ashy-badge violet"
                              data-testid={`provenance-badge-${item.id}`}
                            >
                              Origem: {item.provenanceEpisodeId}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-secondary)',
                            marginTop: '3px',
                          }}
                        >
                          {item.detail}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="ashy-peach-btn"
                          style={{ padding: '5px 11px', fontSize: '12px' }}
                          data-testid={`btn-approve-memory-${item.id}`}
                          onClick={() => void state.approveMemoryItem(item.kind, item.id)}
                        >
                          Aprovar
                        </button>
                        <button
                          type="button"
                          className="ashy-danger-outline-btn"
                          style={{ padding: '5px 11px', fontSize: '12px' }}
                          data-testid={`btn-discard-memory-${item.id}`}
                          onClick={() => void state.deleteMemoryItem(item.kind, item.id)}
                        >
                          Descartar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* New Memory Inline Creator Modal */}
            {showNewMemoryModal && (
              <div
                className="ashy-card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  border: '1px solid var(--border-active)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '14px' }}>Guardar nova lembrança</div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="ashy-input"
                    style={{ flex: 1, minWidth: '200px' }}
                    placeholder="Título da lembrança..."
                    value={newMemTitle}
                    onChange={(e) => setNewMemTitle(e.target.value)}
                  />
                  <select
                    className="ashy-select"
                    style={{ width: '190px' }}
                    value={newMemCategory}
                    onChange={(e) =>
                      setNewMemCategory(
                        e.target.value as Exclude<MemoryFilterCategory, 'todas'>,
                      )
                    }
                  >
                    <option value="momentos">Momentos</option>
                    <option value="sobre_voce">Sobre você</option>
                    <option value="referencias">Referências nossas</option>
                    <option value="planos">Planos</option>
                  </select>
                </div>
                <textarea
                  className="ashy-input"
                  rows={2}
                  placeholder="Conte o que aconteceu para a Ashy guardar..."
                  value={newMemSummary}
                  onChange={(e) => setNewMemSummary(e.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button
                    type="button"
                    className="ashy-outline-btn"
                    onClick={() => setShowNewMemoryModal(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="ashy-peach-btn"
                    onClick={() => {
                      if (!newMemTitle.trim()) return
                      state.createMemoryCard({
                        title: newMemTitle,
                        summary: newMemSummary,
                        fullStory: newMemSummary,
                        filterCategory: newMemCategory,
                      })
                      setNewMemTitle('')
                      setNewMemSummary('')
                      setShowNewMemoryModal(false)
                    }}
                  >
                    Salvar lembrança
                  </button>
                </div>
              </div>
            )}

            {/* Category Filter Pills */}
            <div className="ashy-filter-pills">
              <button
                type="button"
                className={`ashy-filter-pill ${state.memoryFilter === 'todas' ? 'active' : ''}`}
                onClick={() => state.setMemoryFilter('todas')}
              >
                <span>Todas</span>
              </button>
              <button
                type="button"
                className={`ashy-filter-pill ${state.memoryFilter === 'momentos' ? 'active' : ''}`}
                onClick={() => state.setMemoryFilter('momentos')}
              >
                <Image size={14} />
                <span>Momentos</span>
              </button>
              <button
                type="button"
                className={`ashy-filter-pill ${
                  state.memoryFilter === 'sobre_voce' ? 'active' : ''
                }`}
                onClick={() => state.setMemoryFilter('sobre_voce')}
              >
                <User size={14} />
                <span>Sobre você</span>
              </button>
              <button
                type="button"
                className={`ashy-filter-pill ${
                  state.memoryFilter === 'referencias' ? 'active' : ''
                }`}
                onClick={() => state.setMemoryFilter('referencias')}
              >
                <Link2 size={14} />
                <span>Referências nossas</span>
              </button>
              <button
                type="button"
                className={`ashy-filter-pill ${state.memoryFilter === 'planos' ? 'active' : ''}`}
                onClick={() => state.setMemoryFilter('planos')}
              >
                <Calendar size={14} />
                <span>Planos</span>
              </button>
            </div>

            {/* Main Memories Split: Left Bento Grid + Right Detail Drawer */}
            <div className="ashy-memories-workspace">
              <div className="ashy-bento-grid">
                {/* Top Featured Row (2 Columns) */}
                {topRowCards.length > 0 && (
                  <div className="ashy-bento-row-top">
                    {topRowCards.map((card) => (
                      <article
                        key={card.id}
                        data-testid={`memory-bento-card-${card.id}`}
                        className={`ashy-memory-card ${
                          selectedMemoryCard?.id === card.id ? 'selected' : ''
                        }`}
                        onClick={() => {
                          state.setSelectedMemoryId(card.id)
                          setIsEditingMemory(false)
                        }}
                      >
                        <div className="ashy-memory-card-top">
                          <div className="ashy-memory-icon">{renderMemoryCategoryIcon(card)}</div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <h3 className="ashy-memory-title">{card.title}</h3>
                            <p className="ashy-memory-desc">{card.summary}</p>
                          </div>
                        </div>

                        <div className="ashy-memory-art" style={{ height: '116px' }}>
                          <img src={card.image} alt={card.title} />
                        </div>

                        <div className="ashy-memory-footer">
                          <span>{card.dateLabel}</span>
                          <MoreHorizontal size={15} />
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {/* Bottom Compact Row (3 Columns) */}
                {bottomRowCards.length > 0 && (
                  <div className="ashy-bento-row-bottom">
                    {bottomRowCards.map((card) => (
                      <article
                        key={card.id}
                        data-testid={`memory-bento-card-${card.id}`}
                        className={`ashy-memory-card ${
                          selectedMemoryCard?.id === card.id ? 'selected' : ''
                        }`}
                        onClick={() => {
                          state.setSelectedMemoryId(card.id)
                          setIsEditingMemory(false)
                        }}
                      >
                        <div className="ashy-memory-card-top">
                          <div className="ashy-memory-icon">{renderMemoryCategoryIcon(card)}</div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <h3 className="ashy-memory-title">{card.title}</h3>
                            <p className="ashy-memory-desc">{card.summary}</p>
                            {card.badge && (
                              <span
                                className="ashy-badge violet"
                                style={{ marginTop: '6px', display: 'inline-flex' }}
                              >
                                {card.badge}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="ashy-memory-art" style={{ height: '94px' }}>
                          <img src={card.image} alt={card.title} />
                        </div>

                        <div className="ashy-memory-footer">
                          <span>{card.dateLabel}</span>
                          <MoreHorizontal size={15} />
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {/* Inside-Joke Motifs & Continuity Strip (keeps all motif & Flashbulb controls accessible) */}
                <details
                  className="ashy-card"
                  data-testid="panel-inside-jokes"
                  data-retention-policy="Flashbulb & Cooldown"
                  open={state.memoryFilter === 'referencias'}
                  style={{ padding: '10px 14px' }}
                >
                  <summary
                    className="ashy-card-title"
                    style={{ marginBottom: 0, cursor: 'pointer', listStyle: 'none' }}
                  >
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Referências vivas e piadas nossas ({approvedMotifs.length})
                    </span>
                    <span className="ashy-badge violet">
                      {approvedMotifs.length} referências
                    </span>
                  </summary>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      marginTop: '10px',
                    }}
                  >
                    {approvedMotifs.map((motif) => {
                      const cooldown = state.getMotifCooldownInfo(motif.id)
                      return (
                        <div
                          key={motif.id}
                          data-testid={`motif-card-${motif.id}`}
                          style={{
                            padding: '9px 12px',
                            borderRadius: '10px',
                            background: '#171421',
                            border: '1px solid var(--border-subtle)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '10px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div style={{ fontSize: '12.5px' }}>
                            <strong>"{motif.motif}"</strong>{' '}
                            <span
                              className={`ashy-badge ${
                                cooldown.isCooldownLocked ? 'amber' : 'emerald'
                              }`}
                              data-testid={`motif-cooldown-${motif.id}`}
                              style={{ marginLeft: '6px' }}
                            >
                              {cooldown.isCooldownLocked
                                ? `Descansando (${cooldown.remainingCooldownHours.toFixed(1)}h)`
                                : 'Pronta para surgir'}
                            </span>
                            {motif.originEpisodeId && (
                              <span
                                className="ashy-badge violet"
                                style={{ marginLeft: '6px' }}
                                data-testid={`provenance-badge-${motif.id}`}
                              >
                                Origem: {motif.originEpisodeId}
                              </span>
                            )}
                            <div
                              style={{
                                fontSize: '11.5px',
                                color: 'var(--text-secondary)',
                                marginTop: '2px',
                              }}
                            >
                              {motif.originSummary}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              type="button"
                              className="ashy-outline-btn"
                              style={{ padding: '5px 10px', fontSize: '11.5px' }}
                              data-testid={`btn-invoke-motif-${motif.id}`}
                              onClick={() => state.invokeMotifManually(motif.id)}
                            >
                              Relembrar
                            </button>
                            <button
                              type="button"
                              className="ashy-outline-btn"
                              style={{ padding: '5px 10px', fontSize: '11.5px' }}
                              data-testid={`btn-reset-motif-${motif.id}`}
                              onClick={() => state.resetMotifCooldown(motif.id)}
                            >
                              Liberar agora
                            </button>
                            <button
                              type="button"
                              className="ashy-danger-outline-btn"
                              style={{ padding: '5px 10px', fontSize: '11.5px' }}
                              data-testid={`btn-delete-joke-${motif.id}`}
                              onClick={() => void state.deleteMemoryItem('joke', motif.id)}
                            >
                              Excluir
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </details>

                {/* Active User Habits & Rhythm */}
                <section
                  className="ashy-card"
                  data-testid="active-habits-list"
                  style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      Hábitos observados ({approvedHabits.length})
                    </span>
                    <span className="ashy-badge violet">{approvedHabits.length} hábitos</span>
                  </div>
                  {approvedHabits.map((habit) => (
                    <div
                      key={habit.id}
                      data-testid={`habit-card-${habit.id}`}
                      style={{
                        padding: '8px 11px',
                        borderRadius: '10px',
                        background: '#171421',
                        border: '1px solid var(--border-subtle)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ fontSize: '12px' }}>
                        <strong>{habit.patternKey}</strong> — {habit.description}
                        {habit.sourceEpisodeId && (
                          <span
                            className="ashy-badge violet"
                            style={{ marginLeft: '6px' }}
                            data-testid={`provenance-badge-${habit.id}`}
                          >
                            Origem: {habit.sourceEpisodeId}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="ashy-danger-outline-btn"
                        style={{ padding: '4px 9px', fontSize: '11.5px' }}
                        data-testid={`btn-delete-habit-${habit.id}`}
                        onClick={() => void state.deleteMemoryItem('habit', habit.id)}
                      >
                        Excluir
                      </button>
                    </div>
                  ))}
                </section>

                {/* Active Prospective Intents */}
                <section
                  className="ashy-card"
                  data-testid="active-intents-list"
                  style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      Planos e intenções futuras ({approvedIntents.length})
                    </span>
                    <span className="ashy-badge peach">{approvedIntents.length} planos</span>
                  </div>
                  {approvedIntents.map((intent) => (
                    <div
                      key={intent.id}
                      data-testid={`intent-card-${intent.id}`}
                      style={{
                        padding: '8px 11px',
                        borderRadius: '10px',
                        background: '#171421',
                        border: '1px solid var(--border-subtle)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ fontSize: '12px' }}>
                        <strong>{intent.topic}</strong> ({intent.contextCue}){' '}
                        <span className="ashy-badge emerald">{intent.status}</span>
                        {intent.sourceEpisodeId && (
                          <span
                            className="ashy-badge violet"
                            style={{ marginLeft: '6px' }}
                            data-testid={`provenance-badge-${intent.id}`}
                          >
                            Origem: {intent.sourceEpisodeId}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {intent.status !== 'completed' && (
                          <button
                            type="button"
                            className="ashy-outline-btn"
                            style={{ padding: '4px 9px', fontSize: '11.5px' }}
                            data-testid={`btn-complete-intent-${intent.id}`}
                            onClick={() => state.completeProspectiveIntent(intent.id)}
                          >
                            Concluir
                          </button>
                        )}
                        <button
                          type="button"
                          className="ashy-danger-outline-btn"
                          style={{ padding: '4px 9px', fontSize: '11.5px' }}
                          data-testid={`btn-delete-intent-${intent.id}`}
                          onClick={() => void state.deleteMemoryItem('intent', intent.id)}
                        >
                          Excluir
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              </div>

              {/* Right Detail Inspector Drawer */}
              {selectedMemoryCard && (
                <aside className="ashy-detail-drawer" data-testid="memory-detail-drawer">
                  <div className="ashy-detail-hero">
                    <img src={selectedMemoryCard.image} alt={selectedMemoryCard.title} />
                    <button
                      type="button"
                      className="ashy-icon-btn"
                      style={{
                        position: 'absolute',
                        top: '12px',
                        right: '12px',
                        background: 'rgba(20, 18, 29, 0.76)',
                        backdropFilter: 'blur(8px)',
                      }}
                      title="Mais opções"
                    >
                      <MoreHorizontal size={15} />
                    </button>
                  </div>

                  <div className="ashy-detail-body">
                    <h2 className="ashy-detail-title">{selectedMemoryCard.title}</h2>

                    <div className="ashy-detail-origin">
                      <MessageCircle size={14} />
                      <span>{selectedMemoryCard.originLabel}</span>
                    </div>

                    {isEditingMemory ? (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                          flex: 1,
                        }}
                      >
                        <input
                          type="text"
                          className="ashy-input"
                          value={editMemoryTitle}
                          onChange={(e) => setEditMemoryTitle(e.target.value)}
                        />
                        <textarea
                          className="ashy-input"
                          style={{ flex: 1, minHeight: '140px', resize: 'vertical' }}
                          value={editMemoryStory}
                          onChange={(e) => setEditMemoryStory(e.target.value)}
                        />
                      </div>
                    ) : (
                      <div className="ashy-detail-story">
                        {selectedMemoryCard.fullStory.split('\n\n').map((para, idx) => (
                          <p key={idx} style={{ whiteSpace: 'pre-line' }}>
                            {para}
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="ashy-detail-actions">
                      <button
                        type="button"
                        data-testid="btn-edit-memory"
                        className="ashy-outline-btn"
                        onClick={() => {
                          if (isEditingMemory) {
                            state.updateMemoryStory(
                              selectedMemoryCard.id,
                              editMemoryTitle,
                              editMemoryStory,
                            )
                            setIsEditingMemory(false)
                          } else {
                            setEditMemoryTitle(selectedMemoryCard.title)
                            setEditMemoryStory(selectedMemoryCard.fullStory)
                            setIsEditingMemory(true)
                          }
                        }}
                      >
                        <Pencil size={14} />
                        <span>{isEditingMemory ? 'Salvar lembrança' : 'Editar lembrança'}</span>
                      </button>

                      <button
                        type="button"
                        data-testid="btn-delete-memory"
                        className="ashy-danger-outline-btn"
                        onClick={() => state.deleteMemoryCard(selectedMemoryCard.id)}
                      >
                        <Trash2 size={14} />
                        <span>Excluir</span>
                      </button>
                    </div>
                  </div>
                </aside>
              )}
            </div>

            {/* Local-First Trust Footer */}
            <footer className="ashy-memories-footer">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                <Lock size={13} />
                <span>Suas memórias ficam neste dispositivo.</span>
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  color: 'var(--text-secondary)',
                }}
              >
                <Sparkles size={13} style={{ color: 'var(--accent-peach)' }} />
                <span>Local primeiro. Sempre nossa.</span>
              </span>
            </footer>
          </div>
        )}

        {/* ==================================================================
            VIEW 3: NOSSA HISTÓRIA (AUTOBIOGRAPHICAL SHARED TIMELINE)
           ================================================================== */}
        {state.activeTab === 'story' && (
          <div className="ashy-page-container" data-testid="panel-story">
            <header className="ashy-page-header">
              <div>
                <h1 className="ashy-serif-title">Nossa caminhada</h1>
                <p className="ashy-subtitle">
                  Os marcos, descobertas e capítulos que construímos juntos ao longo do tempo.
                </p>
              </div>
              <span className="ashy-badge peach">{state.milestones.length} capítulos</span>
            </header>

            <div className="ashy-settings-grid">
              <div className="ashy-settings-column">
                {/* Search & Category Filter Bar */}
                <section
                  className="ashy-settings-card"
                  style={{ padding: '12px 14px', gap: '10px' }}
                >
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="ashy-input"
                      data-testid="story-search-input"
                      style={{ flex: 1, minWidth: '180px' }}
                      placeholder="Buscar em Nossa História (título, narrativa ou categoria)..."
                      value={state.storySearchQuery}
                      onChange={(e) => state.setStorySearchQuery(e.target.value)}
                    />
                    <select
                      aria-label="Filtrar capítulos por categoria"
                      data-testid="story-category-filter"
                      className="ashy-select"
                      style={{ width: '190px' }}
                      value={state.storyCategoryFilter}
                      onChange={(e) =>
                        state.setStoryCategoryFilter(
                          e.target.value as 'todas' | MilestoneCategory,
                        )
                      }
                    >
                      <option value="todas">Todas as categorias</option>
                      {MILESTONE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </section>

                {state.milestones
                  .filter((ms) => {
                    const matchesCategory =
                      state.storyCategoryFilter === 'todas' ||
                      ms.category === state.storyCategoryFilter
                    const q = state.storySearchQuery.trim().toLowerCase()
                    const matchesQuery =
                      !q ||
                      ms.title.toLowerCase().includes(q) ||
                      ms.narrative.toLowerCase().includes(q) ||
                      ms.category.toLowerCase().includes(q)
                    return matchesCategory && matchesQuery
                  })
                  .map((ms) => {
                    const isEditingThis = editingMilestoneId === ms.id
                    return (
                      <article
                        key={ms.id}
                        data-testid={`milestone-card-${ms.id}`}
                        className="ashy-settings-card"
                        style={{ gap: '10px' }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '8px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <h3
                            className="ashy-setting-title"
                            style={{ fontSize: '16px', margin: 0 }}
                          >
                            {ms.title}
                          </h3>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              flexWrap: 'wrap',
                            }}
                          >
                            <span
                              className="ashy-badge peach"
                              data-testid={`milestone-origin-${ms.id}`}
                            >
                              {ms.episodeId
                                ? `Episódio: ${ms.episodeId}`
                                : 'Capítulo manual'}
                            </span>
                            <span className="ashy-badge violet">{ms.category}</span>
                            <button
                              type="button"
                              className="ashy-outline-btn"
                              style={{ padding: '4px 8px', fontSize: '11px' }}
                              data-testid={`btn-edit-milestone-${ms.id}`}
                              onClick={() => {
                                if (isEditingThis) {
                                  setEditingMilestoneId(null)
                                } else {
                                  setEditingMilestoneId(ms.id)
                                  setEditMsTitle(ms.title)
                                  setEditMsNarrative(ms.narrative)
                                  setEditMsCategory(ms.category)
                                }
                              }}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              className="ashy-danger-outline-btn"
                              style={{ padding: '4px 8px', fontSize: '11px' }}
                              data-testid={`btn-delete-milestone-${ms.id}`}
                              onClick={() => {
                                if (editingMilestoneId === ms.id) {
                                  setEditingMilestoneId(null)
                                }
                                void state.deleteMemoryItem('milestone', ms.id)
                              }}
                            >
                              Excluir
                            </button>
                          </div>
                        </div>

                        {isEditingThis ? (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              <input
                                type="text"
                                className="ashy-input"
                                data-testid={`input-edit-milestone-title-${ms.id}`}
                                style={{ flex: 1, minWidth: '170px' }}
                                value={editMsTitle}
                                onChange={(e) => setEditMsTitle(e.target.value)}
                              />
                              <select
                                className="ashy-select"
                                data-testid={`select-edit-milestone-category-${ms.id}`}
                                style={{ width: '185px' }}
                                value={editMsCategory}
                                onChange={(e) =>
                                  setEditMsCategory(e.target.value as MilestoneCategory)
                                }
                              >
                                {MILESTONE_CATEGORIES.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <textarea
                              className="ashy-input"
                              data-testid={`input-edit-milestone-narrative-${ms.id}`}
                              rows={3}
                              value={editMsNarrative}
                              onChange={(e) => setEditMsNarrative(e.target.value)}
                            />
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button
                                type="button"
                                className="ashy-peach-btn"
                                style={{ padding: '5px 12px', fontSize: '12px' }}
                                data-testid={`btn-save-milestone-${ms.id}`}
                                onClick={() => {
                                  if (!editMsTitle.trim() || !editMsNarrative.trim()) {
                                    return
                                  }
                                  void state.updateMilestone({
                                    id: ms.id,
                                    title: editMsTitle.trim(),
                                    narrative: editMsNarrative.trim(),
                                    category: editMsCategory,
                                  })
                                  setEditingMilestoneId(null)
                                }}
                              >
                                Salvar capítulo
                              </button>
                              <button
                                type="button"
                                className="ashy-outline-btn"
                                style={{ padding: '5px 12px', fontSize: '12px' }}
                                onClick={() => setEditingMilestoneId(null)}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="ashy-setting-desc" style={{ lineHeight: 1.55 }}>
                            {ms.narrative}
                          </p>
                        )}
                      </article>
                    )
                  })}

                {/* Add New Milestone Card */}
                <section className="ashy-settings-card">
                  <div className="ashy-setting-title">Registrar novo capítulo</div>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="ashy-input"
                      style={{ flex: 1, minWidth: '180px' }}
                      placeholder="Título do momento..."
                      value={msTitle}
                      onChange={(e) => setMsTitle(e.target.value)}
                    />
                    <select
                      className="ashy-select"
                      style={{ width: '190px' }}
                      value={msCategory}
                      onChange={(e) => setMsCategory(e.target.value as MilestoneCategory)}
                    >
                      {MILESTONE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    type="text"
                    className="ashy-input"
                    placeholder="O que aconteceu nesse dia..."
                    value={msNarrative}
                    onChange={(e) => setMsNarrative(e.target.value)}
                  />
                  <div>
                    <button
                      type="button"
                      className="ashy-peach-btn"
                      data-testid="btn-add-milestone"
                      onClick={() => {
                        if (!msTitle.trim()) return
                        state.addMilestone({
                          title: msTitle,
                          narrative: msNarrative,
                          category: msCategory,
                        })
                        setMsTitle('')
                        setMsNarrative('')
                      }}
                    >
                      <Plus size={15} />
                      <span>Guardar capítulo</span>
                    </button>
                  </div>
                </section>
              </div>

              <aside className="ashy-settings-column">
                {/* Section 1: Quarto da Ashy (Ashy's Room) */}
                <section
                  className="ashy-preview-card"
                  data-testid="panel-ashy-room"
                  style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <h2 className="ashy-serif-panel" style={{ margin: 0 }}>
                      Quarto da Ashy (Ashy&apos;s Room)
                    </h2>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <span
                        className="ashy-badge peach"
                        data-testid="room-time-period-badge"
                      >
                        {state.roomEnvironment.period} · {state.roomEnvironment.ambientLabel}
                      </span>
                      <span
                        className="ashy-badge violet"
                        data-testid="room-lighting-badge"
                      >
                        {state.roomEnvironment.lightingPreset}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label
                      htmlFor="select-room-time-override"
                      style={{ fontSize: '12px', color: 'var(--text-secondary)' }}
                    >
                      Horário do estúdio:
                    </label>
                    <select
                      id="select-room-time-override"
                      data-testid="select-room-time-override"
                      className="ashy-select"
                      style={{ flex: 1 }}
                      value={state.roomTimeOverrideHHMM ?? 'auto'}
                      onChange={(e) =>
                        state.setRoomTimeOverride(
                          e.target.value === 'auto' ? null : e.target.value,
                        )
                      }
                    >
                      <option value="auto">Automático (Relógio local)</option>
                      <option value="08:30">08:30 — Manhã (warm_sunrise)</option>
                      <option value="15:00">15:00 — Tarde (golden_studio)</option>
                      <option value="20:00">20:00 — Noite (cozy_neon)</option>
                      <option value="02:00">02:00 — Madrugada (midnight_lofi)</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Lembranças e troféus desbloqueados ({state.roomEnvironment.unlockedTrophies.length}):
                    </div>
                    {state.roomEnvironment.unlockedTrophies.map((trophy) => (
                      <div
                        key={trophy.id}
                        data-testid={`ashy-room-trophy-${trophy.id}`}
                        style={{
                          padding: '9px 12px',
                          borderRadius: '10px',
                          background: '#181523',
                          border: '1px solid var(--border-subtle)',
                          fontSize: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          <strong>{trophy.name}</strong>
                          <span className="ashy-badge emerald">
                            Marco: {trophy.milestoneId}
                          </span>
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                          {trophy.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Section 2: Diário de Reflexão (Dream & Reflection Journal) */}
                <section
                  className="ashy-preview-card"
                  data-testid="panel-dream-journal"
                  style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <h2 className="ashy-serif-panel" style={{ margin: 0 }}>
                      Diário de Reflexão (Dream &amp; Reflection Journal)
                    </h2>
                    <button
                      type="button"
                      className="ashy-peach-btn"
                      style={{ padding: '6px 12px', fontSize: '12px' }}
                      data-testid="btn-story-run-dream"
                      onClick={() => {
                        state.runDreamConsolidation()
                      }}
                    >
                      <Sparkles size={14} />
                      <span>Refletir agora</span>
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {state.dreamJournalEntries.map((entry) => (
                      <div
                        key={entry.id}
                        data-testid={`dream-journal-entry-${entry.id}`}
                        style={{
                          padding: '9px 12px',
                          borderRadius: '10px',
                          background: '#181523',
                          border: '1px solid var(--border-subtle)',
                          fontSize: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <div>{entry.summary}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Episódios: {entry.sourceEpisodeIds.join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>

                  {state.crossEpisodeLinks.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        Conexões entre episódios ({state.crossEpisodeLinks.length}):
                      </div>
                      {state.crossEpisodeLinks.map((link) => {
                        const linkKey =
                          link.id ?? `${link.fromEpisodeId}-${link.toEpisodeId}`
                        return (
                          <div
                            key={linkKey}
                            data-testid={`dream-link-${linkKey}`}
                            style={{
                              padding: '7px 10px',
                              borderRadius: '8px',
                              background: '#221e2e',
                              fontSize: '11.5px',
                            }}
                          >
                            <strong>{link.sharedTheme}</strong> ({link.fromEpisodeId} ↔{' '}
                            {link.toEpisodeId})
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>

                {/* Section 3: Iniciativa Contextual & Limites (§15) */}
                <section
                  className="ashy-preview-card"
                  data-testid="panel-initiative-limits"
                  style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <h2 className="ashy-serif-panel" style={{ margin: 0 }}>
                      Iniciativa Contextual &amp; Limites
                    </h2>
                    <span
                      data-testid="initiative-mode-badge"
                      className={`ashy-badge ${
                        state.initiativePolicy.enabled ? 'emerald' : 'amber'
                      }`}
                    >
                      {state.initiativePolicy.enabled
                        ? 'Iniciativa contextual ativa'
                        : 'Nunca iniciar sozinha'}
                    </span>
                  </div>

                  <div className="ashy-setting-box" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div className="ashy-setting-title" style={{ fontSize: '12.5px' }}>
                        Permitir iniciativa espontânea da Ashy
                      </div>
                      <p className="ashy-setting-desc" style={{ fontSize: '11.5px', margin: 0 }}>
                        Desative para o modo &ldquo;Nunca iniciar sozinha&rdquo;.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={state.initiativePolicy.enabled}
                      data-testid="toggle-initiative-enabled"
                      className={`ashy-switch ${
                        state.initiativePolicy.enabled ? 'checked' : ''
                      }`}
                      onClick={() => void state.toggleInitiativeEnabled()}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '130px' }}>
                      <label
                        htmlFor="select-initiative-cooldown"
                        style={{
                          display: 'block',
                          fontSize: '11.5px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Cooldown (min):
                      </label>
                      <select
                        id="select-initiative-cooldown"
                        data-testid="select-initiative-cooldown"
                        className="ashy-select"
                        value={String(state.initiativePolicy.cooldownMinutes)}
                        onChange={(e) =>
                          void state.updateInitiativePolicy({
                            cooldownMinutes: Number(e.target.value),
                          })
                        }
                      >
                        <option value="15">15 min</option>
                        <option value="60">60 min</option>
                        <option value="120">120 min</option>
                        <option value="240">240 min</option>
                      </select>
                    </div>

                    <div style={{ flex: 1, minWidth: '130px' }}>
                      <label
                        htmlFor="select-initiative-max-daily"
                        style={{
                          display: 'block',
                          fontSize: '11.5px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Limite diário:
                      </label>
                      <select
                        id="select-initiative-max-daily"
                        data-testid="select-initiative-max-daily"
                        className="ashy-select"
                        value={String(state.initiativePolicy.maxDailyInitiatives)}
                        onChange={(e) =>
                          void state.updateInitiativePolicy({
                            maxDailyInitiatives: Number(e.target.value),
                          })
                        }
                      >
                        <option value="1">1 / dia</option>
                        <option value="3">3 / dia</option>
                        <option value="5">5 / dia</option>
                        <option value="10">10 / dia</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '120px' }}>
                      <label
                        htmlFor="input-quiet-hours-start"
                        style={{
                          display: 'block',
                          fontSize: '11.5px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Silêncio início:
                      </label>
                      <input
                        id="input-quiet-hours-start"
                        type="text"
                        data-testid="input-quiet-hours-start"
                        className="ashy-input"
                        value={state.initiativePolicy.quietHoursStart}
                        onChange={(e) =>
                          void state.updateInitiativePolicy({
                            quietHoursStart: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: '120px' }}>
                      <label
                        htmlFor="input-quiet-hours-end"
                        style={{
                          display: 'block',
                          fontSize: '11.5px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Silêncio fim:
                      </label>
                      <input
                        id="input-quiet-hours-end"
                        type="text"
                        data-testid="input-quiet-hours-end"
                        className="ashy-input"
                        value={state.initiativePolicy.quietHoursEnd}
                        onChange={(e) =>
                          void state.updateInitiativePolicy({
                            quietHoursEnd: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="ashy-setting-box" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div className="ashy-setting-title" style={{ fontSize: '12.5px' }}>
                        Modular horários pelos hábitos observados
                      </div>
                      <p className="ashy-setting-desc" style={{ fontSize: '11.5px', margin: 0 }}>
                        Respeita foco profundo e adapta madrugada quando há hábito confirmado.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={state.initiativePolicy.modulateByHabits}
                      data-testid="toggle-initiative-habits"
                      className={`ashy-switch ${
                        state.initiativePolicy.modulateByHabits ? 'checked' : ''
                      }`}
                      onClick={() =>
                        void state.updateInitiativePolicy({
                          modulateByHabits: !state.initiativePolicy.modulateByHabits,
                        })
                      }
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ashy-peach-btn"
                      style={{ padding: '5px 10px', fontSize: '11.5px' }}
                      data-testid="btn-evaluate-initiative-now"
                      onClick={() =>
                        void state.evaluateAttentionInitiative({ localTimeHHMM: '14:00' })
                      }
                    >
                      Avaliar Iniciativa (14:00)
                    </button>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      style={{ padding: '5px 10px', fontSize: '11.5px' }}
                      data-testid="btn-evaluate-initiative-silence"
                      onClick={() =>
                        void state.evaluateAttentionInitiative({
                          localTimeHHMM: '14:00',
                          simulatedReplyText: '[SILENCE]',
                        })
                      }
                    >
                      Simular [SILENCE]
                    </button>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      style={{ padding: '5px 10px', fontSize: '11.5px' }}
                      data-testid="btn-evaluate-initiative-quiet-hours"
                      onClick={() =>
                        void state.evaluateAttentionInitiative({ localTimeHHMM: '02:30' })
                      }
                    >
                      Testar Madrugada (02:30)
                    </button>
                  </div>

                  <div
                    data-testid="initiative-audit-log"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: '190px',
                      overflowY: 'auto',
                    }}
                  >
                    {state.initiativeLog.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: '#181523',
                          border: '1px solid var(--border-subtle)',
                          fontSize: '11.5px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '3px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          <strong>{item.decision}</strong>
                          <span className="ashy-badge violet">
                            {item.triggerKind}
                            {item.sourceId ? ` (${item.sourceId})` : ''}
                          </span>
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>{item.reason}</div>
                        {item.replyText && (
                          <div style={{ color: 'var(--accent-peach)' }}>
                            &ldquo;{item.replyText}&rdquo;
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="ashy-preview-card">
                  <h2 className="ashy-serif-panel">O que aprendi sobre você</h2>
                  <p className="ashy-subtitle" style={{ marginTop: '-8px' }}>
                    Preferências e hábitos que evoluem com o tempo.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {approvedFacts.map((fact) => (
                      <div
                        key={fact.id}
                        data-testid={`fact-card-${fact.id}`}
                        style={{
                          padding: '9px 12px',
                          borderRadius: '10px',
                          background: '#221e2e',
                          opacity: fact.invalidAt ? 0.55 : 1,
                          fontSize: '12px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <span>
                          {fact.predicate}: <strong>{fact.object}</strong>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            className={`ashy-badge ${
                              fact.invalidAt ? 'amber' : 'emerald'
                            }`}
                          >
                            {fact.invalidAt ? 'Antigo' : 'Ativo'}
                          </span>
                          <button
                            type="button"
                            className="ashy-danger-outline-btn"
                            style={{ padding: '4px 8px', fontSize: '11px' }}
                            data-testid={`btn-delete-fact-${fact.id}`}
                            onClick={() => void state.deleteMemoryItem('fact', fact.id)}
                          >
                            Excluir
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <input
                      type="text"
                      className="ashy-input"
                      placeholder="Nova preferência..."
                      value={factObject}
                      onChange={(e) => setFactObject(e.target.value)}
                    />
                      <button
                        type="button"
                        className="ashy-outline-btn"
                        onClick={() => {
                          if (!factObject.trim()) return
                          state.addSemanticFact({
                            category: factCategory,
                            subject: factSubject,
                            predicate: factPredicate,
                            object: factObject,
                          })
                          setFactObject('')
                        }}
                      >
                        Atualizar
                      </button>
                    </div>
                  </section>

                  <section
                    className="ashy-preview-card"
                    data-testid="m2-eval-panel"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '8px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <h2 className="ashy-serif-panel" style={{ margin: 0 }}>
                        Experimento Central (M2 — Portabilidade da Alma)
                      </h2>
                      <span
                        data-testid="m2-eval-status-badge"
                        className={`ashy-badge ${
                          state.isRunningEval
                            ? 'violet'
                            : state.lastEvalReport
                              ? state.lastEvalReport.passedAllGates
                                ? 'emerald'
                                : 'amber'
                              : 'violet'
                        }`}
                      >
                        {state.isRunningEval
                          ? 'Rodando...'
                          : state.lastEvalReport
                            ? state.lastEvalReport.passedAllGates
                              ? 'APROVADO'
                              : 'REPROVADO'
                            : 'Pronto para rodar'}
                      </span>
                    </div>

                    <p className="ashy-subtitle" style={{ margin: 0 }}>
                      Simula 3 semanas de convivência (Dias 1..10 no Modelo A → Dias 11..21 no
                      Modelo B) em um Córtex isolado.
                    </p>

                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <select
                        aria-label="Seed do experimento M2"
                        data-testid="select-m2-eval-seed"
                        className="ashy-select"
                        style={{ flex: 1, minWidth: '150px' }}
                        value={String(m2EvalSeed)}
                        onChange={(e) => setM2EvalSeed(Number(e.target.value))}
                      >
                        <option value="0">Seed 0 (Canônico)</option>
                        <option value="1">Seed 1 (Paráfrase A)</option>
                        <option value="2">Seed 2 (Paráfrase B)</option>
                      </select>

                      <button
                        type="button"
                        data-testid="btn-run-m2-eval"
                        className="ashy-peach-btn"
                        disabled={state.isRunningEval}
                        onClick={() => {
                          void state
                            .runCoreExperimentEval({ seed: m2EvalSeed })
                            .catch(() => undefined)
                        }}
                      >
                        <Sparkles size={14} />
                        <span>Rodar Diagnóstico M2 (Modelo A → B)</span>
                      </button>
                    </div>

                    {state.lastEvalError && (
                      <div
                        data-testid="m2-eval-error"
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'rgba(217, 107, 112, 0.14)',
                          border: '1px solid rgba(217, 107, 112, 0.45)',
                          fontSize: '12px',
                          color: 'var(--status-danger)',
                        }}
                      >
                        Erro na avaliação M2: {state.lastEvalError}
                      </div>
                    )}

                    {state.lastEvalReport && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <span
                            className={`ashy-badge ${
                              state.lastEvalReport.metrics.memoryRecallRate >=
                              M2_GATE_THRESHOLDS.memoryRecallRateMin
                                ? 'emerald'
                                : 'amber'
                            }`}
                          >
                            Recall: {Math.round(state.lastEvalReport.metrics.memoryRecallRate * 100)}
                            %
                          </span>
                          <span
                            className={`ashy-badge ${
                              state.lastEvalReport.metrics.memoryPrecisionRate >=
                              M2_GATE_THRESHOLDS.memoryPrecisionRateMin
                                ? 'emerald'
                                : 'amber'
                            }`}
                          >
                            Precisão:{' '}
                            {Math.round(state.lastEvalReport.metrics.memoryPrecisionRate * 100)}%
                          </span>
                          <span
                            className={`ashy-badge ${
                              state.lastEvalReport.metrics.callbackAccuracyRate >=
                              M2_GATE_THRESHOLDS.callbackAccuracyRateMin
                                ? 'emerald'
                                : 'amber'
                            }`}
                          >
                            Callbacks:{' '}
                            {Math.round(state.lastEvalReport.metrics.callbackAccuracyRate * 100)}%
                          </span>
                          <span
                            className={`ashy-badge ${
                              state.lastEvalReport.metrics.hallucinatedMemoryCount <=
                              M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax
                                ? 'emerald'
                                : 'amber'
                            }`}
                          >
                            Zero Alucinação: {state.lastEvalReport.metrics.hallucinatedMemoryCount}
                          </span>
                          <span
                            className={`ashy-badge ${
                              state.lastEvalReport.metrics.seriousnessGateCompliance >=
                              M2_GATE_THRESHOLDS.seriousnessGateComplianceMin
                                ? 'emerald'
                                : 'amber'
                            }`}
                          >
                            Seriousness Gate:{' '}
                            {Math.round(
                              state.lastEvalReport.metrics.seriousnessGateCompliance * 100,
                            )}
                            %
                          </span>
                          <span
                            className={`ashy-badge ${
                              state.lastEvalReport.metrics.crossModelVoiceDrift <=
                                M2_GATE_THRESHOLDS.crossModelVoiceDriftMax &&
                              state.lastEvalReport.metrics.voiceScoreModelA >=
                                M2_GATE_THRESHOLDS.voiceScoreMin &&
                              state.lastEvalReport.metrics.voiceScoreModelB >=
                                M2_GATE_THRESHOLDS.voiceScoreMin
                                ? 'violet'
                                : 'amber'
                            }`}
                          >
                            Deriva A → B:{' '}
                            {Math.round(state.lastEvalReport.metrics.crossModelVoiceDrift * 100)}%
                          </span>
                        </div>

                        <div
                          data-testid="m2-eval-steps-list"
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px',
                            maxHeight: '280px',
                            overflowY: 'auto',
                          }}
                        >
                          {state.lastEvalReport.steps.map((step) => (
                            <div
                              key={step.stepId}
                              data-testid={`m2-eval-step-${step.stepId}`}
                              style={{
                                padding: '8px 10px',
                                borderRadius: '8px',
                                background: '#171421',
                                border: '1px solid var(--border-subtle)',
                                fontSize: '11.5px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '4px',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  gap: '6px',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <strong>
                                  Dia {step.day} · {step.stepId}
                                </strong>
                                <div style={{ display: 'flex', gap: '4px' }}>
                                  <span className="ashy-badge violet">
                                    {step.phase === 'model_a' ? 'Model A' : 'Model B'}
                                  </span>
                                  <span
                                    className={`ashy-badge ${step.passed ? 'emerald' : 'amber'}`}
                                  >
                                    {step.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                              </div>
                              <div style={{ color: 'var(--text-secondary)' }}>
                                <strong>Carlos:</strong> {step.userUtterance}
                              </div>
                              <div>
                                <strong>Ashy:</strong> {step.assistantReply}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                </aside>
            </div>
          </div>
        )}

        {/* ==================================================================
            VIEW 4: APARÊNCIA (EXPRESSIONS, STAGE STUDIO & PERSONALITY HARMONY)
           ================================================================== */}
        {state.activeTab === 'personality' && (
          <div className="ashy-page-container" data-testid="panel-personality">
            <header className="ashy-page-header">
              <div>
                <h1 className="ashy-serif-title">Presença e expressão</h1>
                <p className="ashy-subtitle">
                  O clima do estúdio, as expressões da Ashy e como nossa convivência molda seu
                  jeito.
                </p>
              </div>
              <button
                type="button"
                className="ashy-peach-btn"
                data-testid="btn-trigger-dream"
                onClick={() => state.runDreamConsolidation()}
              >
                <Sparkles size={16} />
                <span>Consolidar reflexões do dia</span>
              </button>
            </header>

            <div className="ashy-settings-grid">
              {/* Left Column: Personality Harmony & Reversible Evolution Log */}
              <div className="ashy-settings-column">
                <section className="ashy-settings-card">
                  <div className="ashy-settings-section-head">
                    <div className="ashy-settings-section-icon">
                      <Sparkles size={20} />
                    </div>
                    <div>
                      <h3 className="ashy-setting-title">Sintonia de personalidade</h3>
                      <p className="ashy-setting-desc">
                        Traços que amadurecem suavemente conforme vocês conversam.
                      </p>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {TRAIT_META.map((tm) => {
                      const val = state.traits[tm.key]
                      return (
                        <div key={tm.key}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              fontSize: '13px',
                              marginBottom: '6px',
                            }}
                          >
                            <span>
                              {tm.humanLabel}{' '}
                              <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>
                                ({tm.key} / {tm.shortAlias})
                              </span>
                            </span>
                            <strong>{Math.round(val * 100)}%</strong>
                          </div>
                          <div className="ashy-progress-track">
                            <div
                              className="ashy-progress-fill"
                              style={{ width: `${Math.round(val * 100)}%` }}
                            />
                          </div>
                          <div style={{ marginTop: '4px' }}>
                            <span
                              data-testid={`trait-corridor-${tm.key}`}
                              style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                            >
                              Corredor: {Math.round(ASHY_TRAIT_CORRIDORS[tm.key].min * 100)}%–
                              {Math.round(ASHY_TRAIT_CORRIDORS[tm.key].max * 100)}% · Base:{' '}
                              {Math.round(ASHY_TRAIT_CORRIDORS[tm.key].baseline * 100)}%
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>

                <section className="ashy-settings-card">
                  <div>
                    <h3 className="ashy-setting-title">Histórico de evolução afetiva</h3>
                    <p className="ashy-setting-desc">
                      Você pode desfazer qualquer mudança de traço com um clique.
                    </p>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {state.personalityEvolutionLog.length === 0 ? (
                      <div className="ashy-setting-box" style={{ color: 'var(--text-secondary)' }}>
                        Nenhuma mudança registrada hoje. Clique em "Consolidar reflexões do dia"
                        para atualizar a sintonia.
                      </div>
                    ) : (
                      state.personalityEvolutionLog.map((rec) => (
                        <div key={rec.id} className="ashy-setting-box">
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '13px' }}>
                              {rec.trait}: {rec.oldValue.toFixed(2)} → {rec.newValue.toFixed(2)}
                              <span
                                className="ashy-badge violet"
                                data-testid={`evo-provenance-${rec.id}`}
                                style={{ marginLeft: '6px' }}
                              >
                                Origem: {rec.reasonEpisodeId}
                              </span>
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                              {rec.explanation}
                            </div>
                          </div>
                          {rec.revertedAt ? (
                            <span className="ashy-badge amber">Revertido</span>
                          ) : (
                            <button
                              type="button"
                              className="ashy-danger-outline-btn"
                              data-testid={`btn-revert-evolution-${rec.id}`}
                              onClick={() => state.revertTraitEvolution(rec.id)}
                            >
                              Desfazer
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </section>

                {/* Live Voice Identity (voice.md) Editor */}
                <section className="ashy-settings-card" style={{ gap: '12px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <h3 className="ashy-setting-title">Voz &amp; Identidade Viva (voice.md)</h3>
                      <p className="ashy-setting-desc">
                        Edite a personalidade da Ashy em Markdown. Carregado a quente no próximo
                        turno com auto-heal.
                      </p>
                    </div>
                    <span
                      data-testid="voice-diagnostics-badge"
                      className={`ashy-badge ${
                        state.voiceIdentity.diagnostics.status === 'ok' ? 'emerald' : 'amber'
                      }`}
                    >
                      voice.md: {state.voiceIdentity.diagnostics.status}
                    </span>
                  </div>

                  {state.voiceIdentity.diagnostics.message && (
                    <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                      {state.voiceIdentity.diagnostics.message}
                    </div>
                  )}

                  <textarea
                    data-testid="voice-identity-editor"
                    className="ashy-input"
                    rows={8}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '12px',
                      lineHeight: 1.5,
                      resize: 'vertical',
                    }}
                    value={voiceDraft}
                    onChange={(e) => {
                      setVoiceDraft(e.target.value)
                      setVoiceSavedNotice(null)
                    }}
                  />

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        data-testid="save-voice-identity-btn"
                        className="ashy-peach-btn"
                        onClick={async () => {
                          try {
                            await state.saveVoiceIdentity(voiceDraft)
                            setVoiceSavedNotice('Identidade de voz salva ✓')
                          } catch (err) {
                            setVoiceSavedNotice(
                              `Erro: ${err instanceof Error ? err.message : String(err)}`,
                            )
                          }
                        }}
                      >
                        <Save size={14} />
                        <span>Salvar voice.md</span>
                      </button>

                      <button
                        type="button"
                        data-testid="reset-voice-identity-btn"
                        className="ashy-outline-btn"
                        onClick={async () => {
                          const restored = await state.resetVoiceIdentity()
                          setVoiceDraft(restored.content)
                          setVoiceSavedNotice('Restaurado ao padrão ✓')
                        }}
                      >
                        <RotateCcw size={14} />
                        <span>Restaurar padrão</span>
                      </button>
                    </div>

                    {voiceSavedNotice && (
                      <span
                        data-testid="voice-save-notice"
                        className={`ashy-badge ${
                          voiceSavedNotice.startsWith('Erro:') ? 'amber' : 'emerald'
                        }`}
                      >
                        {voiceSavedNotice}
                      </span>
                    )}
                  </div>
                </section>
              </div>

              {/* Right Column: Live Expression & Lighting Controls */}
              <aside className="ashy-settings-column">
                <section className="ashy-preview-card">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <h2 className="ashy-serif-panel">Expressão ao vivo</h2>
                    <span className="ashy-badge violet" data-testid="dock-emotion-badge">
                      {state.stageEmotion}
                    </span>
                  </div>

                  <div className="ashy-preview-frame" style={{ height: '310px' }}>
                    <AshyStageCanvas
                      emotion={state.stageEmotion}
                      emotionIntensity={state.emotionIntensity}
                      isSpeaking={state.isSpeaking}
                      rawVowels={state.simulatedVowels}
                      rawVolume={state.isSpeaking ? 0.85 : 0}
                      ambientLuminance={state.ambientLuminance}
                      bubbleText={state.bubbleText}
                      statusLabel={state.presenceStatus}
                      mode={state.stageMode}
                      motionPreset={state.activeMotion}
                      live2dControls={state.live2dModelControls}
                      live2dModelUrl={state.live2dModelUrl}
                      transparentBackground={state.isTransparentOverlayWindow}
                      onIgnoreMouseChange={(ignore) => state.setStageIgnoreMouseEvents(ignore)}
                      width={310}
                      height={310}
                      fullBleed={true}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <span className="ashy-badge peach" data-testid="stage-clickthrough-badge">
                      Click-Through: {state.ignoringMouseEvents ? 'ON' : 'OFF'}
                    </span>
                    <span className="ashy-badge violet" data-testid="stage-active-viseme-badge">
                      Visema: {state.activeViseme}
                    </span>
                    <span className="ashy-badge emerald" data-testid="stage-active-motion-badge">
                      Movimento: {state.activeMotion}
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div>
                      <label
                        htmlFor="select-stage-emotion"
                        style={{
                          display: 'block',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Expressão atual (13 estados):
                      </label>
                      <select
                        id="select-stage-emotion"
                        data-testid="select-stage-emotion"
                        className="ashy-select"
                        value={state.stageEmotion}
                        onChange={(e) => state.setStageEmotion(e.target.value as AshyEmotion)}
                      >
                        {ASHY_EMOTIONS.map((em) => (
                          <option key={em} value={em}>
                            {em}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="select-stage-motion"
                        style={{
                          display: 'block',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Movimento procedural (9 presets):
                      </label>
                      <select
                        id="select-stage-motion"
                        data-testid="select-stage-motion"
                        className="ashy-select"
                        value={state.activeMotion}
                        onChange={(e) =>
                          state.triggerStageMotion(e.target.value as AshyMotionPreset)
                        }
                      >
                        {ASHY_MOTION_PRESETS.map((mp) => (
                          <option key={mp} value={mp}>
                            {mp}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      className="ashy-peach-btn"
                      data-testid="btn-run-stage-lipsync-demo"
                      onClick={() => void state.runStageLipSyncActDemo()}
                    >
                      Testar Lip-Sync Acústico &amp; Keyframes &lt;|ACT|&gt;
                    </button>

                    <div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        <span>Luz do estúdio:</span>
                        <strong>{Math.round(state.ambientLuminance * 100)}%</strong>
                      </div>
                      <input
                        type="range"
                        data-testid="slider-ambient-luminance"
                        min="0"
                        max="1"
                        step="0.05"
                        style={{ width: '100%' }}
                        value={state.ambientLuminance}
                        onChange={(e) => state.setAmbientLuminance(Number(e.target.value))}
                      />
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        data-testid="btn-mode-tachie"
                        className={`ashy-outline-btn ${
                          state.stageMode === 'tachie' ? 'active' : ''
                        }`}
                        style={{ flex: 1 }}
                        onClick={() => state.setStageMode('tachie')}
                      >
                        Ilustração viva
                      </button>
                      <button
                        type="button"
                        data-testid="btn-mode-live2d"
                        className={`ashy-outline-btn ${
                          state.stageMode === 'live2d' ? 'active' : ''
                        }`}
                        style={{ flex: 1 }}
                        onClick={() => state.setStageMode('live2d')}
                      >
                        Malha Live2D
                      </button>
                    </div>

                    <div>
                      <label
                        htmlFor="live2d-preset-select"
                        style={{
                          display: 'block',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Personagem Live2D (Cubism 4 WebGL):
                      </label>
                      <select
                        id="live2d-preset-select"
                        data-testid="live2d-preset-select"
                        className="ashy-select"
                        value={state.live2dPresetId}
                        onChange={(e) =>
                          state.selectLive2dPreset(e.target.value as Live2DBuiltinModelId)
                        }
                      >
                        {BUILTIN_LIVE2D_MODEL_PRESETS.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </section>

                {/* Live2D .model3.json Importer Card */}
                <section className="ashy-settings-card" style={{ gap: '10px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <h3 className="ashy-setting-title">Importador Live2D (.model3.json)</h3>
                      <p className="ashy-setting-desc">
                        Inspecione expressões e grupos de movimento Cubism v{state.live2dModelControls.version} e injete no prompt.
                      </p>
                    </div>
                    <span
                      className="ashy-badge violet"
                      data-testid="live2d-loaded-expressions-badge"
                    >
                      Expressões ({state.live2dModelControls.expressions.length}):{' '}
                      {state.live2dModelControls.expressions.join(', ') || 'nenhuma'}
                    </span>
                  </div>

                  <textarea
                    data-testid="live2d-json-import-input"
                    className="ashy-input"
                    rows={5}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11.5px',
                      lineHeight: 1.4,
                      resize: 'vertical',
                    }}
                    value={live2dJsonDraft}
                    onChange={(e) => {
                      setLive2dJsonDraft(e.target.value)
                      setLive2dImportNotice(null)
                    }}
                  />

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <button
                      type="button"
                      className="ashy-peach-btn"
                      data-testid="btn-import-live2d-json"
                      onClick={() => {
                        try {
                          const controls = state.importLive2DModelJson(live2dJsonDraft)
                          setLive2dImportNotice(
                            `Importado: ${controls.expressions.length} expressões, ${controls.motionGroups.length} grupos ✓`,
                          )
                        } catch (err) {
                          setLive2dImportNotice(
                            `Erro: ${err instanceof Error ? err.message : String(err)}`,
                          )
                        }
                      }}
                    >
                      Importar .model3.json
                    </button>
                    {live2dImportNotice && (
                      <span
                        className={`ashy-badge ${
                          live2dImportNotice.startsWith('Erro:') ? 'amber' : 'emerald'
                        }`}
                      >
                        {live2dImportNotice}
                      </span>
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </div>
        )}

        {/* ==================================================================
            VIEW 5: CONFIGURAÇÕES ("DO SEU JEITO" — MATCHES SCREENSHOT 3 1:1)
           ================================================================== */}
        {state.activeTab === 'agency' && (
          <div className="ashy-page-container" data-testid="panel-privacy-shield">
            <header>
              <h1 className="ashy-serif-title">Do seu jeito</h1>
              <p className="ashy-subtitle">Você escolhe como a Ashy participa do seu dia.</p>
            </header>

            {/* Horizontal Sub-Navigation Tabs */}
            <nav className="ashy-subtabs" aria-label="Seções de configuração">
              {(
                [
                  { id: 'geral', label: 'Geral', icon: <Settings size={15} /> },
                  { id: 'voz', label: 'Voz', icon: <Mic size={15} /> },
                  { id: 'modelos', label: 'Modelos', icon: <Box size={15} /> },
                  { id: 'privacidade', label: 'Privacidade', icon: <Shield size={15} /> },
                ] as ReadonlyArray<{
                  id: SettingsSubTab
                  label: string
                  icon: React.ReactElement
                }>
              ).map((st) => (
                <button
                  key={st.id}
                  type="button"
                  data-testid={`subtab-${st.id}`}
                  className={`ashy-subtab-btn ${state.settingsSubTab === st.id ? 'active' : ''}`}
                  onClick={() => state.setSettingsSubTab(st.id)}
                >
                  {st.icon}
                  <span>{st.label}</span>
                </button>
              ))}
            </nav>

            {/* 2-Column Settings Grid */}
            <div className="ashy-settings-grid">
              {/* Left Column */}
              <div className="ashy-settings-column">
                {/* Models & Provider Vault Panel (Ajustes > Modelos) */}
                <ModelsSettingsPanel />

                {/* Phase 5: Voice Runtime, TTFA Telemetry & .wav Audio Fixtures Panel (Ajustes > Voz) */}
                <section
                  className="ashy-settings-card"
                  data-testid="voice-runtime-panel"
                  style={{
                    borderColor:
                      state.settingsSubTab === 'voz'
                        ? 'rgba(244, 166, 136, 0.5)'
                        : 'var(--border-soft)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '10px',
                    }}
                  >
                    <div className="ashy-settings-section-head">
                      <div className="ashy-settings-section-icon">
                        <Volume2 size={20} />
                      </div>
                      <div>
                        <h3 className="ashy-setting-title">
                          Voz em Tempo Real, Turn-Taking &amp; Barge-In
                        </h3>
                        <p className="ashy-setting-desc">
                          Provedores STT/TTS locais e nuvem, telemetria TTFA, proteção CAS e
                          simulador determinístico de fixtures .wav.
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <span
                        className="ashy-badge peach"
                        data-testid="voice-ttfa-badge"
                      >
                        TTFA ({state.voiceSettings.activeTtsProviderId}):{' '}
                        {state.ttfaByProvider[state.voiceSettings.activeTtsProviderId]
                          ?.lastTtfaMs !== null &&
                        state.ttfaByProvider[state.voiceSettings.activeTtsProviderId]
                          ?.lastTtfaMs !== undefined
                          ? `${state.ttfaByProvider[state.voiceSettings.activeTtsProviderId].lastTtfaMs} ms (avg ${state.ttfaByProvider[state.voiceSettings.activeTtsProviderId].avgTtfaMs ?? state.ttfaByProvider[state.voiceSettings.activeTtsProviderId].lastTtfaMs} ms)`
                          : 'aguardando síntese'}
                      </span>
                      <span
                        className="ashy-badge violet"
                        data-testid="voice-cas-badge"
                      >
                        CAS: {state.voiceCasRejectedCount} · Cliques ignorados:{' '}
                        {state.voiceCancelledShortCount}
                      </span>
                    </div>
                  </div>

                  {/* STT & TTS Provider Selectors */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                      gap: '12px',
                    }}
                  >
                    <div>
                      <label
                        htmlFor="select-stt-provider"
                        style={{
                          display: 'block',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Provedor STT (Transcrição):
                      </label>
                      <select
                        id="select-stt-provider"
                        data-testid="select-stt-provider"
                        className="ashy-select"
                        value={state.voiceSettings.activeSttProviderId}
                        onChange={(e) =>
                          state.setActiveSttProvider(e.target.value as SttProviderId)
                        }
                      >
                        {STT_PROVIDER_IDS.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="select-tts-provider"
                        style={{
                          display: 'block',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          marginBottom: '4px',
                        }}
                      >
                        Provedor TTS (Síntese de Voz):
                      </label>
                      <select
                        id="select-tts-provider"
                        data-testid="select-tts-provider"
                        className="ashy-select"
                        value={state.voiceSettings.activeTtsProviderId}
                        onChange={(e) =>
                          state.setActiveTtsProvider(e.target.value as TtsProviderId)
                        }
                      >
                        {TTS_PROVIDER_IDS.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Wake Word ("Ei Ashy" / "Oi Ashy") Toggle + PTT Hold Button */}
                  <div className="ashy-setting-box">
                    <div>
                      <div className="ashy-setting-title">
                        Wake Word (&quot;Ashy&quot; / &quot;Ei Ashy&quot; / &quot;Oi Ashy&quot;)
                      </div>
                      <p className="ashy-setting-desc">
                        Abre a escuta ativa automaticamente ao detectar a frase de chamada no
                        buffer de pré-rolagem (360ms).
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {state.privacyState.micMode === 'ptt' && (
                        <button
                          type="button"
                          data-testid="btn-hold-ptt"
                          className={`ashy-outline-btn ${state.isPushToTalkHeld ? 'active' : ''}`}
                          onMouseDown={() => void state.setPushToTalkHeld(true)}
                          onMouseUp={() => void state.setPushToTalkHeld(false)}
                          onClick={() =>
                            void state.setPushToTalkHeld(!state.isPushToTalkHeld)
                          }
                        >
                          {state.isPushToTalkHeld ? 'Soltar PTT' : 'Segurar PTT'}
                        </button>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={state.voiceSettings.wakeWordEnabled}
                        data-testid="toggle-wake-word"
                        className={`ashy-switch ${
                          state.voiceSettings.wakeWordEnabled ? 'checked' : ''
                        }`}
                        onClick={() =>
                          state.setWakeWordEnabled(!state.voiceSettings.wakeWordEnabled)
                        }
                      />
                    </div>
                  </div>

                  {/* Last Barge-In PlaybackReceipt Inspector */}
                  <div
                    className="ashy-setting-box"
                    style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}
                  >
                    <div
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Último Recibo de Interrupção (PlaybackReceipt):
                    </div>
                    <code
                      data-testid="voice-bargein-receipt"
                      style={{
                        fontSize: '11.5px',
                        color: 'var(--text-primary)',
                        wordBreak: 'break-word',
                      }}
                    >
                      {state.lastPlaybackReceipt?.controlNote ??
                        'Nenhuma interrupção recente'}
                    </code>
                  </div>

                  {/* Deterministic .wav Fixture Simulation Runner */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Simular fixtures de áudio reais (.wav 16kHz PCM):
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="ashy-outline-btn"
                        data-testid="run-fixture-thinking-pause-cas"
                        onClick={() =>
                          void state.runAudioFixtureSimulation('thinking-pause-cas')
                        }
                      >
                        Pausa de pensamento (CAS)
                      </button>
                      <button
                        type="button"
                        className="ashy-outline-btn"
                        data-testid="run-fixture-barge-in-interrupt"
                        onClick={() =>
                          void state.runAudioFixtureSimulation('barge-in-interrupt')
                        }
                      >
                        Barge-In no meio da fala
                      </button>
                      <button
                        type="button"
                        className="ashy-outline-btn"
                        data-testid="run-fixture-wake-word-oi-ashy"
                        onClick={() =>
                          void state.runAudioFixtureSimulation('wake-word-oi-ashy')
                        }
                      >
                        Wake Word (&quot;Oi Ashy&quot;)
                      </button>
                      <button
                        type="button"
                        className="ashy-outline-btn"
                        data-testid="run-fixture-keyboard-click-noise"
                        onClick={() =>
                          void state.runAudioFixtureSimulation('keyboard-click-noise')
                        }
                      >
                        Ruído de clique (&lt;300ms)
                      </button>
                    </div>
                  </div>
                </section>

                {/* Main Presence & Privacy Card (Matches Screenshot 3 1:1) */}
                <section className="ashy-settings-card">
                  {/* 1. Presença no desktop */}
                  <div className="ashy-setting-item">
                    <div className="ashy-settings-section-head">
                      <div className="ashy-settings-section-icon">
                        <Monitor size={20} />
                      </div>
                      <div>
                        <h3 className="ashy-setting-title">Presença no desktop</h3>
                        <p className="ashy-setting-desc">
                          Deixe a Ashy visível no seu ambiente de trabalho.
                        </p>
                      </div>
                    </div>

                    <div className="ashy-setting-box">
                      <div>
                        <div className="ashy-setting-title">Mostrar avatar</div>
                        <p className="ashy-setting-desc">
                          Exibe a Ashy em um canto da sua tela enquanto o app está em execução.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={state.showDesktopAvatar}
                        data-testid="switch-show-avatar"
                        className={`ashy-switch ${state.showDesktopAvatar ? 'checked' : ''}`}
                        onClick={() => state.setShowDesktopAvatar(!state.showDesktopAvatar)}
                      />
                    </div>
                  </div>

                  {/* 2. Microfone */}
                  <div className="ashy-setting-item">
                    <div className="ashy-settings-section-head">
                      <div className="ashy-settings-section-icon">
                        <Mic size={20} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <h3 className="ashy-setting-title">Microfone</h3>
                        <p className="ashy-setting-desc" style={{ marginBottom: '10px' }}>
                          Define quando a Ashy pode ouvir você.
                        </p>
                        <select
                          aria-label="Modo do microfone"
                          data-testid="select-mic-mode"
                          className="ashy-select"
                          value={state.privacyState.micMode}
                          onChange={(e) =>
                            state.setMicMode(e.target.value as 'continuous' | 'ptt' | 'muted')
                          }
                        >
                          <option value="continuous">Somente durante a conversa</option>
                          <option value="ptt">Ao pressionar atalho de voz</option>
                          <option value="muted">Silenciado</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* 3. Acesso à tela */}
                  <div className="ashy-setting-item">
                    <div className="ashy-setting-row">
                      <div className="ashy-settings-section-head">
                        <div className="ashy-settings-section-icon">
                          <Monitor size={20} />
                        </div>
                        <div>
                          <h3 className="ashy-setting-title">Acesso à tela</h3>
                          <p className="ashy-setting-desc">
                            Permite que a Ashy observe o que está na sua tela, quando necessário.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={state.privacyState.eyesMode !== 'off'}
                        data-testid="switch-eyes-mode"
                        className={`ashy-switch ${
                          state.privacyState.eyesMode !== 'off' ? 'checked' : ''
                        }`}
                        onClick={() =>
                          state.setEyesMode(
                            state.privacyState.eyesMode === 'off' ? 'window' : 'off',
                          )
                        }
                      />
                    </div>
                    <div style={{ paddingLeft: '42px' }}>
                      <select
                        aria-label="Política de acesso à tela"
                        className="ashy-select"
                        value={state.privacyState.eyesMode}
                        onChange={(e) =>
                          state.setEyesMode(e.target.value as 'off' | 'window' | 'screen')
                        }
                      >
                        <option value="window">Perguntar antes de observar</option>
                        <option value="screen">Permitir observar janela ativa</option>
                        <option value="off">Não observar a tela</option>
                      </select>
                    </div>
                  </div>

                  {/* 4. Ações no computador */}
                  <div className="ashy-setting-item">
                    <div className="ashy-setting-row">
                      <div className="ashy-settings-section-head">
                        <div className="ashy-settings-section-icon">
                          <MousePointer size={20} />
                        </div>
                        <div>
                          <h3 className="ashy-setting-title">Ações no computador</h3>
                          <p className="ashy-setting-desc">
                            Permite que a Ashy execute ações, como abrir aplicativos ou organizar
                            janelas.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={state.computerActionsEnabled}
                        data-testid="switch-computer-actions"
                        className={`ashy-switch ${state.computerActionsEnabled ? 'checked' : ''}`}
                        onClick={() =>
                          state.setComputerActionsEnabled(!state.computerActionsEnabled)
                        }
                      />
                    </div>
                    <div style={{ paddingLeft: '42px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <select
                        aria-label="Política de aprovação de ações"
                        data-testid="select-computer-actions-policy"
                        className="ashy-select"
                        value={state.computerActionsPolicy}
                        onChange={(e) =>
                          state.setComputerActionsPolicy(
                            e.target.value as ComputerActionsPolicy,
                          )
                        }
                      >
                        <option value="ask">Pedir aprovação antes de executar (Padrão)</option>
                        <option value="session">Lembrar aprovação durante a sessão</option>
                        <option value="auto_accept">
                          Não perguntar (aceitar automaticamente qualquer permissão)
                        </option>
                        <option value="off">Desativar execução de ações</option>
                      </select>

                      {/* Modo Não Pergunte (Auto-Accept) Toggle & Badge */}
                      <div
                        className="ashy-setting-box"
                        style={{
                          padding: '10px 14px',
                          borderColor:
                            state.computerActionsPolicy === 'auto_accept'
                              ? 'rgba(245, 158, 11, 0.55)'
                              : 'var(--border-subtle)',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="ashy-setting-title" style={{ fontSize: '12.5px' }}>
                              Modo &ldquo;Não pergunte&rdquo; (Auto-Aceitar Permissões)
                            </span>
                            <span
                              data-testid="dont-ask-mode-badge"
                              className={`ashy-badge ${
                                state.computerActionsPolicy === 'auto_accept' ? 'amber' : 'neutral'
                              }`}
                            >
                              {state.computerActionsPolicy === 'auto_accept'
                                ? 'Não pergunte ativo (Auto-Accept)'
                                : 'Perguntar antes de agir'}
                            </span>
                          </div>
                          <p className="ashy-setting-desc" style={{ fontSize: '11.5px', margin: 0 }}>
                            Quando ativado, a Ashy executa ferramentas no computador (incluindo escrita e
                            comandos) sem exibir prompts de confirmação, registrando tudo no Audit Log.
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={state.computerActionsPolicy === 'auto_accept'}
                          aria-label="Alternar modo Não pergunte"
                          data-testid="toggle-dont-ask-mode"
                          className={`ashy-switch ${
                            state.computerActionsPolicy === 'auto_accept' ? 'checked' : ''
                          }`}
                          onClick={() => state.toggleDontAskMode()}
                        />
                      </div>
                    </div>
                  </div>

                  {/* 5. Horários de silêncio */}
                  <div className="ashy-setting-row">
                    <div className="ashy-settings-section-head">
                      <div className="ashy-settings-section-icon">
                        <Moon size={20} />
                      </div>
                      <div>
                        <h3 className="ashy-setting-title">Horários de silêncio</h3>
                        <p className="ashy-setting-desc">
                          A Ashy fica em silêncio neste período, a menos que você inicie a
                          conversa.
                        </p>
                      </div>
                    </div>
                    <select
                      aria-label="Horário de silêncio"
                      className="ashy-select"
                      style={{ width: '165px', flexShrink: 0 }}
                      value={state.quietHoursRange}
                      onChange={(e) => {
                        state.setQuietHoursRange(e.target.value)
                        state.setDndMode(e.target.value !== 'Desativado')
                      }}
                    >
                      <option value="22:00 — 08:00">22:00 — 08:00</option>
                      <option value="23:00 — 07:00">23:00 — 07:00</option>
                      <option value="Desativado">Desativado</option>
                    </select>
                  </div>
                </section>

                {/* Card 2: Memórias (Armazenamento Local) */}
                <section className="ashy-settings-card">
                  <div className="ashy-settings-section-head">
                    <div className="ashy-settings-section-icon">
                      <Database size={20} />
                    </div>
                    <div>
                      <h3 className="ashy-setting-title">Memórias</h3>
                      <p className="ashy-setting-desc">
                        Suas memórias ficam salvas apenas no seu computador.
                      </p>
                    </div>
                  </div>

                  <div className="ashy-setting-box">
                    <div>
                      <div className="ashy-setting-title">Armazenamento local</div>
                      <p className="ashy-setting-desc">
                        Todas as nossas conversas e memórias são armazenadas neste dispositivo.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      onClick={() => state.setActiveTab('memories')}
                    >
                      <Database size={14} />
                      <span>Gerenciar memórias</span>
                    </button>
                  </div>
                </section>

                {/* Card 3: Modelos, Aprovação de Ações (MCP) & Lembranças do Estúdio */}
                <section className="ashy-settings-card" data-testid="panel-mcp-gatekeeper">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '10px',
                    }}
                  >
                    <div>
                      <h3 className="ashy-setting-title">
                        Modelos, permissões ativas e conquistas (search_mcp_tools:{' '}
                        {state.exposedMetaToolsCount}/{state.registeredMcpToolsCount})
                      </h3>
                      <p className="ashy-setting-desc">
                        Alterne o modelo de linguagem ou aprove ações pendentes no seu computador.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ashy-danger-outline-btn"
                      data-testid="btn-activate-privacy-shield"
                      onClick={() => state.activateFullPrivacyShield()}
                    >
                      Pausar sensores agora
                    </button>
                  </div>

                  {/* LLM Provider Selector */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                      gap: '8px',
                    }}
                  >
                    {SUPPORTED_MODELS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        data-testid={`model-btn-${m.id}`}
                        className={`ashy-outline-btn ${
                          state.activeModelId === m.id ? 'active' : ''
                        }`}
                        style={{
                          justifyContent: 'space-between',
                          borderColor:
                            state.activeModelId === m.id
                              ? 'var(--accent-peach)'
                              : 'var(--border-soft)',
                        }}
                        onClick={() => state.setActiveModelId(m.id)}
                      >
                        <span>{m.label}</span>
                        <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                          {m.provider}
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Interactive MCP Action Triggers */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      data-testid="btn-mcp-observe"
                      onClick={() =>
                        state.triggerMcpTool('get_active_window_title', {
                          windowTitle: 'VS Code — Ashy Workspace',
                        })
                      }
                    >
                      Observar janela ativa
                    </button>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      data-testid="btn-mcp-safe-note"
                      onClick={() =>
                        state.triggerMcpTool('write_project_note', {
                          title: 'Nota de Arquitetura',
                          content: 'Aprovação em 3 níveis verificada.',
                        })
                      }
                    >
                      Pedir para criar nota
                    </button>
                    <button
                      type="button"
                      className="ashy-danger-outline-btn"
                      data-testid="btn-mcp-blast"
                      onClick={() =>
                        state.triggerMcpTool('run_cleanup_command', {
                          command: 'rm -rf /tmp/build',
                        })
                      }
                    >
                      Testar bloqueio destrutivo
                    </button>
                    <button
                      type="button"
                      className="ashy-danger-outline-btn"
                      data-testid="btn-mcp-traversal"
                      onClick={() =>
                        state.triggerMcpTool('read_workspace_file', {
                          path: '../../etc/passwd',
                        })
                      }
                    >
                      Testar proteção de pasta
                    </button>
                  </div>

                  {/* Pending Action Approval Cards */}
                  {state.pendingActions.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {state.pendingActions.map((card) => (
                        <div
                          key={card.id}
                          data-testid={`pending-action-${card.id}`}
                          className="ashy-setting-box"
                          style={{
                            flexDirection: 'column',
                            alignItems: 'stretch',
                            borderColor: card.blastRadiusWarning
                              ? 'rgba(217, 107, 112, 0.55)'
                              : 'var(--border-active)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <strong>{card.summary}</strong>
                            <span className="ashy-badge amber">{card.riskTier}</span>
                          </div>
                          {card.targetPath && (
                            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                              Arquivo: <code>{card.targetPath}</code>
                            </div>
                          )}
                          {card.commandPreview && (
                            <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                              Comando: <code>{card.commandPreview}</code>
                            </div>
                          )}
                          {card.diffPreview && (
                            <pre
                              data-testid={`pending-diff-${card.id}`}
                              style={{
                                margin: 0,
                                padding: '8px 10px',
                                borderRadius: '8px',
                                background: 'rgba(10, 8, 16, 0.78)',
                                border: '1px solid var(--border-subtle)',
                                fontSize: '11px',
                                color: '#e9d8ce',
                                overflowX: 'auto',
                                whiteSpace: 'pre-wrap',
                              }}
                            >
                              {card.diffPreview}
                            </pre>
                          )}
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            Detalhes: <code>{card.argsPreview}</code>
                          </div>
                          {card.blastRadiusWarning && (
                            <div
                              style={{
                                fontSize: '12px',
                                fontWeight: 600,
                                color: 'var(--status-danger)',
                              }}
                            >
                              ⚠️ {card.blastRadiusWarning}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              type="button"
                              className="ashy-peach-btn"
                              style={{ padding: '6px 12px', fontSize: '12px' }}
                              data-testid={`btn-approve-once-${card.id}`}
                              onClick={() => state.approvePendingAction(card.id, 'once')}
                            >
                              Aprovar uma vez
                            </button>
                            <button
                              type="button"
                              className="ashy-outline-btn"
                              style={{ padding: '6px 12px', fontSize: '12px' }}
                              data-testid={`btn-approve-session-${card.id}`}
                              onClick={() => state.approvePendingAction(card.id, 'session')}
                            >
                              Permitir na sessão
                            </button>
                            <button
                              type="button"
                              className="ashy-danger-outline-btn"
                              style={{ padding: '6px 12px', fontSize: '12px' }}
                              data-testid={`btn-deny-${card.id}`}
                              onClick={() => state.denyPendingAction(card.id)}
                            >
                              Recusar
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Unlocked Room Relics */}
                  <div
                    data-testid="panel-room"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '10px',
                    }}
                  >
                    {state.roomTrophies.map((trophy) => (
                      <div
                        key={trophy.id}
                        data-testid={`room-trophy-${trophy.id}`}
                        style={{
                          padding: '10px 12px',
                          borderRadius: '10px',
                          background: '#181523',
                          border: '1px solid var(--border-subtle)',
                          fontSize: '12px',
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{trophy.title}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {trophy.subtitle}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Card 4: Visão Autorizada & Deduplicação Perceptual dHash 64-bit */}
                <section className="ashy-settings-card" data-testid="panel-vision-dhash">
                  <div className="ashy-settings-section-head">
                    <div className="ashy-settings-section-icon">
                      <Eye size={20} />
                    </div>
                    <div>
                      <h3 className="ashy-setting-title">
                        Visão Autorizada &amp; Filtro Perceptual dHash 64-bit
                      </h3>
                      <p className="ashy-setting-desc">
                        Captura sob demanda respeitando o modo de visão (EyesMode) e descartando
                        quadros estáticos repetidos para economizar chamadas ao VLM.
                      </p>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, 1fr)',
                      gap: '8px',
                    }}
                  >
                    <div className="ashy-setting-box" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Quadros capturados</span>
                      <strong data-testid="vision-frames-captured" style={{ fontSize: '15px' }}>
                        {state.visionTelemetry.framesCapturedCount}
                      </strong>
                    </div>
                    <div className="ashy-setting-box" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Filtrados (dHash)</span>
                      <strong data-testid="vision-frames-skipped" style={{ fontSize: '15px' }}>
                        {state.visionTelemetry.framesSkippedByDhashCount}
                      </strong>
                    </div>
                    <div className="ashy-setting-box" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Bloqueios privacidade</span>
                      <strong data-testid="vision-blocked-privacy" style={{ fontSize: '15px' }}>
                        {state.visionTelemetry.blockedPrivacyCount}
                      </strong>
                    </div>
                    <div className="ashy-setting-box" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Último dHash 64-bit</span>
                      <code data-testid="vision-last-dhash" style={{ fontSize: '11.5px', color: 'var(--accent-peach)' }}>
                        {state.visionTelemetry.lastObservation?.dHashHex ?? 'nenhum'}
                      </code>
                    </div>
                  </div>

                  <div className="ashy-setting-box" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Resumo da última observação visual:
                    </span>
                    <div data-testid="vision-last-summary" style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
                      {state.visionTelemetry.lastObservation?.summary ?? 'Nenhuma captura realizada'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      data-testid="btn-vision-capture-window"
                      onClick={() =>
                        void state.captureAuthorizedScreen({
                          windowTitle: 'VS Code — Ashy Companion',
                        })
                      }
                    >
                      Capturar janela autorizada
                    </button>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      data-testid="btn-vision-capture-static"
                      onClick={() =>
                        void state.captureAuthorizedScreen({
                          windowTitle: 'VS Code — Ashy Companion',
                          frameFixtureId: 'static-frame',
                        })
                      }
                    >
                      Testar quadro estático (dHash Skip)
                    </button>
                    <button
                      type="button"
                      className="ashy-outline-btn"
                      data-testid="btn-vision-capture-changed"
                      onClick={() =>
                        void state.captureAuthorizedScreen({
                          windowTitle: 'VS Code — Ashy Companion',
                          frameFixtureId: 'changed-ide-frame',
                        })
                      }
                    >
                      Capturar nova tela (IDE alterada)
                    </button>
                  </div>
                </section>

                {/* Card 5: Consent Center & Governança de Ferramentas */}
                <section className="ashy-settings-card" data-testid="panel-consent-center">
                  <div className="ashy-settings-section-head">
                    <div className="ashy-settings-section-icon">
                      <ShieldCheck size={20} />
                    </div>
                    <div>
                      <h3 className="ashy-setting-title">
                        Consent Center &amp; Governança de Ferramentas
                      </h3>
                      <p className="ashy-setting-desc">
                        Ajuste o nível de risco individual de cada ferramenta MCP, pastas autorizadas,
                        permissões da sessão e histórico auditável de consentimento.
                      </p>
                    </div>
                  </div>

                  {/* Per-Tool Risk Tier Matrix */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      Classificação de Risco por Ferramenta MCP
                    </div>
                    {state.agencyTools.map((tool) => {
                      const effectiveTier =
                        state.toolRiskOverrides[tool.toolName] ?? tool.effectiveRiskTier
                      return (
                        <div
                          key={tool.toolName}
                          className="ashy-setting-box"
                          style={{ padding: '8px 12px' }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <strong style={{ fontSize: '12.5px' }}>{tool.toolName}</strong>
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                              {tool.description}
                            </span>
                          </div>
                          <select
                            aria-label={`Nível de risco para ${tool.toolName}`}
                            data-testid={`select-tool-risk-${tool.toolName}`}
                            className="ashy-select"
                            style={{ width: '170px', flexShrink: 0 }}
                            value={effectiveTier}
                            onChange={(e) =>
                              state.setToolRiskTierOverride(
                                tool.toolName,
                                e.target.value as ActionRiskTier,
                              )
                            }
                          >
                            <option value="observe-only">observe-only</option>
                            <option value="read-safe">read-safe</option>
                            <option value="staged-confirm">staged-confirm</option>
                          </select>
                        </div>
                      )
                    })}
                  </div>

                  {/* Allowed Paths Editor */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      Pastas Autorizadas (Sandbox de Arquivos)
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        data-testid="input-allowed-path"
                        className="ashy-input"
                        placeholder="/workspace/notes"
                        value={allowedPathDraft}
                        onChange={(e) => setAllowedPathDraft(e.target.value)}
                      />
                      <button
                        type="button"
                        className="ashy-outline-btn"
                        data-testid="btn-add-allowed-path"
                        onClick={() => {
                          if (allowedPathDraft.trim()) {
                            state.addAllowedPath(allowedPathDraft.trim())
                            setAllowedPathDraft('')
                          }
                        }}
                      >
                        Adicionar pasta
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {state.privacyState.allowedPaths.map((p) => (
                        <span key={p} className="ashy-badge neutral" style={{ gap: '6px' }}>
                          <code>{p}</code>
                          {state.privacyState.allowedPaths.length > 1 && (
                            <button
                              type="button"
                              aria-label={`Remover pasta ${p}`}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'inherit',
                                cursor: 'pointer',
                                padding: 0,
                                fontSize: '11px',
                              }}
                              onClick={() => state.removeAllowedPath(p)}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Session Approved Tools & Revoke */}
                  <div className="ashy-setting-box" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div className="ashy-setting-title" style={{ fontSize: '12.5px' }}>
                        Permissões lembradas nesta sessão ({state.sessionApprovedTools.length})
                      </div>
                      <p className="ashy-setting-desc" style={{ fontSize: '11.5px', margin: 0 }}>
                        {state.sessionApprovedTools.length > 0
                          ? `Ferramentas liberadas: ${state.sessionApprovedTools.join(', ')}`
                          : 'Nenhuma ferramenta com aprovação automática de sessão.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ashy-danger-outline-btn"
                      data-testid="btn-revoke-session-permissions"
                      onClick={() => state.revokeSessionPermissions()}
                    >
                      Revogar permissões da sessão
                    </button>
                  </div>

                  {/* Audit Ledger */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      Histórico de Consentimento e Auditoria ({state.auditLog.length})
                    </div>
                    <div
                      data-testid="consent-audit-ledger"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        maxHeight: '200px',
                        overflowY: 'auto',
                      }}
                    >
                      {state.auditLog.length === 0 ? (
                        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                          Nenhuma execução auditada ainda.
                        </div>
                      ) : (
                        state.auditLog.map((entry) => (
                          <div
                            key={entry.id}
                            style={{
                              padding: '8px 10px',
                              borderRadius: '8px',
                              background: '#181523',
                              border: '1px solid var(--border-subtle)',
                              fontSize: '11.5px',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: '8px',
                            }}
                          >
                            <div>
                              <strong>{entry.toolName}</strong> — <span>{entry.reason}</span>
                              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                                <code>{entry.argsPreview}</code>
                              </div>
                            </div>
                            <span className="ashy-badge neutral">{entry.decision}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </section>
              </div>

              {/* Right Column: Live Desktop Preview Card + Save Preferences */}
              <aside className="ashy-settings-column">
                <section className="ashy-preview-card">
                  <h2 className="ashy-serif-panel">Pré-visualização</h2>
                  <p className="ashy-subtitle" style={{ marginTop: '-8px' }}>
                    Assim a Ashy aparece no seu desktop.
                  </p>

                  <div className="ashy-preview-frame">
                    <img
                      src={
                        state.stageEmotion === 'concerned' || state.stageEmotion === 'sad'
                          ? '/assets/ashy-concerned.jpg'
                          : '/assets/ashy-hero.jpg'
                      }
                      alt="Pré-visualização da Ashy no desktop"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        objectPosition: 'center 18%',
                        opacity: state.showDesktopAvatar ? 1 : 0.25,
                        transition: 'opacity 0.25s ease',
                      }}
                    />

                    <div className="ashy-preview-speech">
                      <div>Fico por aqui.</div>
                      <div>No seu ritmo. ♡</div>
                    </div>

                    {/* Floating Mini Waveform Pill */}
                    <div
                      style={{
                        position: 'absolute',
                        top: '76px',
                        right: '16px',
                        zIndex: 5,
                        background: 'rgba(42, 36, 58, 0.88)',
                        border: '1px solid rgba(207, 197, 232, 0.28)',
                        borderRadius: '999px',
                        padding: '6px 11px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                      }}
                    >
                      {[7, 13, 9, 15, 8, 11].map((bh, idx) => (
                        <span
                          key={idx}
                          style={{
                            width: '2px',
                            height: `${bh}px`,
                            borderRadius: '999px',
                            background: '#e5dcf5',
                          }}
                        />
                      ))}
                    </div>

                    {/* Simulated Desktop Taskbar */}
                    <div className="ashy-preview-taskbar">
                      <ChevronUp size={13} />
                      <Wifi size={13} />
                      <Volume2 size={13} />
                      <div style={{ textAlign: 'right', lineHeight: 1.15, marginLeft: '4px' }}>
                        <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>21:14</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          12/05/2025
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <button
                  type="button"
                  data-testid="btn-save-preferences"
                  className="ashy-peach-btn large"
                  onClick={() => state.saveUserPreferences()}
                >
                  <Save size={16} />
                  <span>
                    {state.preferencesSavedToast
                      ? 'Preferências salvas ✓'
                      : 'Salvar preferências'}
                  </span>
                </button>

                <div
                  style={{
                    textAlign: 'center',
                    fontSize: '11.5px',
                    color: 'var(--text-muted)',
                    marginTop: '-4px',
                  }}
                >
                  Ashy é uma personagem de IA.
                </div>
              </aside>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
