import React, { useEffect, useState } from 'react'
import {
  ASHY_EMOTIONS,
  MILESTONE_CATEGORIES,
  SEMANTIC_FACT_CATEGORIES,
  type AshyEmotion,
  type MilestoneCategory,
  type SemanticFactCategory,
} from '@ashy/shared'
import type { FsrsReviewRating } from '@ashy/cortex'
import { AshyStageCanvas } from '@ashy/stage'
import {
  BookOpen,
  Box,
  Calendar,
  ChevronRight,
  ChevronUp,
  Database,
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

  // Semantic Fact form state
  const [factCategory, setFactCategory] = useState<SemanticFactCategory>('preference')
  const [factSubject, setFactSubject] = useState('User')
  const [factPredicate, setFactPredicate] = useState('favorite_stack_is')
  const [factObject, setFactObject] = useState('')

  // Voice Identity (voice.md) live editor state
  const [voiceDraft, setVoiceDraft] = useState(state.voiceIdentity.content)
  const [voiceSavedNotice, setVoiceSavedNotice] = useState<string | null>(null)

  useEffect(() => {
    void useAshyStore.getState().bootstrapFromHost()
  }, [])

  useEffect(() => {
    setVoiceDraft(state.voiceIdentity.content)
  }, [state.voiceIdentity.content])

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
          background: 'radial-gradient(circle at 50% 38%, #261f35 0%, #111017 80%)',
        }}
      >
        <div
          className="ashy-card"
          data-ui-island="true"
          style={{
            width: '410px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '14px',
            background: 'rgba(24, 21, 34, 0.92)',
            backdropFilter: 'blur(18px)',
            border: '1px solid rgba(244, 166, 136, 0.38)',
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.65)',
          }}
        >
          <div
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

          <div
            style={{
              borderRadius: '14px',
              overflow: 'hidden',
              border: '1px solid var(--border-soft)',
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
              width={360}
              height={420}
            />
          </div>

          <div
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

          <form onSubmit={handleSendChat} style={{ width: '100%', display: 'flex', gap: '8px' }}>
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
                  data-testid="btn-new-memory"
                  className="ashy-peach-btn"
                  onClick={() => setShowNewMemoryModal(!showNewMemoryModal)}
                >
                  <Plus size={16} />
                  <span>Nova memória</span>
                </button>
              </div>
            </header>

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
                      Referências vivas e piadas nossas ({state.relationalMotifs.length})
                    </span>
                    <span className="ashy-badge violet">
                      {state.relationalMotifs.length} referências
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
                    {state.relationalMotifs.map((motif) => {
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
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </details>
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
                {state.milestones.map((ms) => (
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
                      }}
                    >
                      <h3 className="ashy-setting-title" style={{ fontSize: '16px', margin: 0 }}>
                        {ms.title}
                      </h3>
                      <span className="ashy-badge violet">{ms.category}</span>
                    </div>
                    <p className="ashy-setting-desc" style={{ lineHeight: 1.55 }}>
                      {ms.narrative}
                    </p>
                  </article>
                ))}

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
                <section className="ashy-preview-card">
                  <h2 className="ashy-serif-panel">O que aprendi sobre você</h2>
                  <p className="ashy-subtitle" style={{ marginTop: '-8px' }}>
                    Preferências e hábitos que evoluem com o tempo.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {state.semanticFacts.map((fact) => (
                      <div
                        key={fact.id}
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
                        <span className={`ashy-badge ${fact.invalidAt ? 'amber' : 'emerald'}`}>
                          {fact.invalidAt ? 'Antigo' : 'Ativo'}
                        </span>
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
                      width={310}
                      height={310}
                      fullBleed={true}
                    />
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
                    <div style={{ paddingLeft: '42px' }}>
                      <select
                        aria-label="Política de aprovação de ações"
                        className="ashy-select"
                        value={state.computerActionsPolicy}
                        onChange={(e) =>
                          state.setComputerActionsPolicy(
                            e.target.value as 'ask' | 'session' | 'off',
                          )
                        }
                      >
                        <option value="ask">Pedir aprovação antes de executar</option>
                        <option value="session">Lembrar aprovação durante a sessão</option>
                        <option value="off">Desativar execução de ações</option>
                      </select>
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
