import React, { useState } from 'react'
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
  SUPPORTED_MODELS,
  useAshyStore,
  type HubTabId,
} from './store/useAshyStore'

const TRAIT_META: ReadonlyArray<{
  key: 'warmthAffection' | 'chaosEnergy' | 'witSarcasm' | 'intellectualCuriosity' | 'proactivity'
  label: string
  shortAlias: string
}> = [
  {
    key: 'warmthAffection',
    label: 'Warmth & Affection',
    shortAlias: 'warmth',
  },
  {
    key: 'chaosEnergy',
    label: 'Playfulness & Chaos Energy',
    shortAlias: 'playfulness',
  },
  {
    key: 'witSarcasm',
    label: 'Wit & Sarcasm',
    shortAlias: 'sarcasm',
  },
  {
    key: 'intellectualCuriosity',
    label: 'Intellectual Curiosity',
    shortAlias: 'curiosity',
  },
  {
    key: 'proactivity',
    label: 'Proactivity & Protective Drive',
    shortAlias: 'protectiveDrive',
  },
]

export function App(): React.ReactElement {
  const storeState = useAshyStore()
  const state = typeof window === 'undefined' ? useAshyStore.getState() : storeState
  const [chatInput, setChatInput] = useState('')
  const [showCompiledPrompt, setShowCompiledPrompt] = useState(true)

  // Milestone form state
  const [msTitle, setMsTitle] = useState('')
  const [msNarrative, setMsNarrative] = useState('')
  const [msCategory, setMsCategory] = useState<MilestoneCategory>('project_shipped')

  // Semantic Fact form state
  const [factCategory, setFactCategory] = useState<SemanticFactCategory>('preference')
  const [factSubject, setFactSubject] = useState('User')
  const [factPredicate, setFactPredicate] = useState('favorite_stack_is')
  const [factObject, setFactObject] = useState('')

  const handleSendChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!chatInput.trim()) return
    const text = chatInput
    setChatInput('')
    await state.sendUserMessage(text)
  }

  // Mode A: Floating Stage Overlay
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
          padding: '20px',
          background:
            'radial-gradient(circle at 50% 40%, oklch(0.2 0.06 330 / 0.35), oklch(0.1 0.02 275 / 0.92))',
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
            gap: '12px',
            background: 'oklch(0.14 0.025 278 / 0.9)',
            backdropFilter: 'blur(16px)',
            border: '1px solid oklch(0.72 0.19 345 / 0.45)',
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
              <span className="ashy-badge rose">Floating Stage Overlay</span>
              <span className="ashy-badge violet">{state.activeModelId}</span>
            </div>
            <button
              type="button"
              className="ashy-btn primary"
              data-testid="btn-expand-hub"
              onClick={() => state.setViewMode('hub')}
            >
              Expand Companion Hub
            </button>
          </div>

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

          {/* Quick Privacy Shield Bar */}
          <div
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
              padding: '8px 10px',
              borderRadius: '10px',
              background: 'oklch(0.11 0.015 275)',
              fontSize: '12px',
            }}
          >
            <span>Mic: {state.privacyState.micMode}</span>
            <span>Eyes: {state.privacyState.eyesMode}</span>
            <span>DND: {state.privacyState.dndMode ? 'ON' : 'OFF'}</span>
            <button
              type="button"
              className="ashy-btn danger"
              data-testid="btn-stage-barge-in"
              onClick={() => state.triggerBargeIn(600)}
            >
              Barge-In
            </button>
          </div>

          {/* Quick Chat Input */}
          <form
            onSubmit={handleSendChat}
            style={{ width: '100%', display: 'flex', gap: '8px' }}
          >
            <input
              type="text"
              className="ashy-input"
              data-testid="stage-chat-input"
              style={{ flex: 1 }}
              placeholder="Fale com a Ashy no overlay..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button
              type="submit"
              className="ashy-btn primary"
              data-testid="btn-stage-send"
            >
              Enviar
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Mode B: Companion Hub
  const tabs: ReadonlyArray<{ id: HubTabId; label: string; testId: string }> = [
    { id: 'studio', label: '1. Live Cortex & Stage Studio', testId: 'tab-studio' },
    { id: 'story', label: '2. Our Story Timeline', testId: 'tab-story' },
    { id: 'memories', label: '3. Memory & Inside Jokes', testId: 'tab-memories' },
    { id: 'personality', label: '4. Personality & Dream', testId: 'tab-personality' },
    { id: 'agency', label: "5. Ashy's Room & MCP Consent", testId: 'tab-agency' },
  ]

  return (
    <div className="ashy-shell" data-testid="companion-hub">
      {/* Top Bar */}
      <header className="ashy-topbar">
        <div className="ashy-brand">
          <div className="ashy-brand-orb">A</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '16px', letterSpacing: '-0.01em' }}>
              Ashy — Soul-First Desktop Companion
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              4-Layer Affect • FSRS-6 Hybrid Memory • Inside-Joke Cooldown • 2D Stage • MCP Gatekeeper
            </div>
          </div>
        </div>

        <nav className="ashy-tabs" aria-label="Companion Hub Navigation">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={t.testId}
              className={`ashy-tab-btn ${state.activeTab === t.id ? 'active' : ''}`}
              onClick={() => state.setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            className={`ashy-badge ${
              state.lastPrompt.seriousness.isSeriousOrDelicate ? 'amber' : 'emerald'
            }`}
            data-testid="seriousness-gate-badge"
          >
            {state.lastPrompt.seriousness.isSeriousOrDelicate
              ? 'Seriousness Gate: ACTIVE'
              : 'Seriousness Gate: Standby'}
          </span>
          <button
            type="button"
            className="ashy-btn"
            data-testid="btn-switch-stage"
            onClick={() => state.setViewMode('stage')}
          >
            Floating Stage Overlay
          </button>
        </div>
      </header>

      {/* Main Two-Column Workspace: Left Permanent Stage Dock + Right Active Tab */}
      <div className="ashy-workspace">
        {/* Left Permanent Stage Dock */}
        <aside className="ashy-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="ashy-card-title">
            <span>2D Procedural Stage Dock</span>
            <span className="ashy-badge violet" data-testid="dock-emotion-badge">
              {state.stageEmotion}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              background:
                'radial-gradient(circle at 50% 35%, oklch(0.22 0.06 330 / 0.28), oklch(0.11 0.015 275))',
              borderRadius: '14px',
              border: '1px solid var(--border-subtle)',
              padding: '6px',
            }}
          >
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
              width={360}
              height={430}
            />
          </div>

          {/* Stage Controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Render Pipeline:</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  data-testid="btn-mode-tachie"
                  className={`ashy-btn ${state.stageMode === 'tachie' ? 'primary' : ''}`}
                  onClick={() => state.setStageMode('tachie')}
                >
                  Layered Tachie
                </button>
                <button
                  type="button"
                  data-testid="btn-mode-live2d"
                  className={`ashy-btn ${state.stageMode === 'live2d' ? 'primary' : ''}`}
                  onClick={() => state.setStageMode('live2d')}
                >
                  Live2D Cubism
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="select-stage-emotion">Emotion Preset (13):</label>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span>Ambient Luminance (RetinalLightSquint):</span>
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
                data-testid="btn-toggle-lipsync"
                className={`ashy-btn ${state.isSpeaking ? 'primary' : ''}`}
                style={{ flex: 1 }}
                onClick={() => state.toggleSimulatedSpeech()}
              >
                {state.isSpeaking ? 'Speaking (A/E/I/O/U ON)' : 'Simulate Lip-Sync Speech'}
              </button>
              <button
                type="button"
                data-testid="btn-barge-in"
                className="ashy-btn danger"
                onClick={() => state.triggerBargeIn(600)}
              >
                Barge-In (Interrupt)
              </button>
            </div>
          </div>
        </aside>

        {/* Right Tab Content Area */}
        <main style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {state.activeTab === 'studio' && (
            <>
              {/* Live Chat + Scenario Triggers */}
              <section className="ashy-card">
                <div className="ashy-card-title">
                  <span>Live Cortex & Realtime Voice Conversation</span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ashy-btn"
                      data-testid="btn-scenario-joke"
                      onClick={() =>
                        state.sendUserMessage(
                          'O servidor caiu sem nenhum log no backend, vamos chamar um padre no npm?',
                        )
                      }
                    >
                      Testar Provocação + Piada Interna
                    </button>
                    <button
                      type="button"
                      className="ashy-btn"
                      data-testid="btn-scenario-serious"
                      onClick={() =>
                        state.sendUserMessage(
                          'Estou exausto, deu tudo errado hoje e tô me sentindo um lixo.',
                        )
                      }
                    >
                      Testar Seriousness Gate (Desabafo Sério)
                    </button>
                    <button
                      type="button"
                      className="ashy-btn danger"
                      data-testid="btn-scenario-barge-in"
                      onClick={async () => {
                        await state.sendUserMessage(
                          'Me explica toda a nossa arquitetura e conta uma piada longa!',
                        )
                        state.triggerBargeIn(600)
                      }}
                    >
                      Testar Barge-In no Meio da Fala
                    </button>
                  </div>
                </div>

                {/* Chat Transcript */}
                <div
                  data-testid="chat-transcript"
                  style={{
                    maxHeight: '270px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    padding: '10px',
                    borderRadius: '12px',
                    background: 'oklch(0.11 0.015 275)',
                    border: '1px solid var(--border-subtle)',
                    marginBottom: '12px',
                  }}
                >
                  {state.chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '82%',
                        padding: '10px 14px',
                        borderRadius: '12px',
                        background:
                          msg.role === 'user'
                            ? 'oklch(0.24 0.05 290)'
                            : 'oklch(0.17 0.025 278)',
                        border:
                          msg.role === 'user'
                            ? '1px solid oklch(0.74 0.16 295 / 0.4)'
                            : '1px solid oklch(0.72 0.19 345 / 0.35)',
                        fontSize: '13px',
                        lineHeight: 1.5,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          marginBottom: '4px',
                          fontSize: '11px',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <strong>{msg.role === 'user' ? 'Você' : 'Ashy'}</strong>
                        {msg.emotion ? (
                          <span className="ashy-badge rose">{msg.emotion}</span>
                        ) : null}
                        {msg.invokedMotifId ? (
                          <span className="ashy-badge violet">
                            Callback: {msg.invokedMotifId}
                          </span>
                        ) : null}
                        {msg.seriousnessTriggered ? (
                          <span className="ashy-badge amber">Seriousness Gate</span>
                        ) : null}
                      </div>
                      <div>{msg.content}</div>
                    </div>
                  ))}
                </div>

                {/* Chat Input Form */}
                <form onSubmit={handleSendChat} style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="ashy-input"
                    data-testid="studio-chat-input"
                    style={{ flex: 1 }}
                    placeholder="Converse com a Ashy (experimente falar de um bug no backend ou um desabafo sério)..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="ashy-btn primary"
                    data-testid="btn-studio-send"
                  >
                    Enviar Mensagem
                  </button>
                </form>

                {/* PlaybackReceipt Inspector when Barge-In occurs */}
                {state.lastPlaybackReceipt && (
                  <div
                    data-testid="playback-receipt-card"
                    style={{
                      marginTop: '12px',
                      padding: '12px',
                      borderRadius: '12px',
                      background: 'oklch(0.66 0.21 25 / 0.12)',
                      border: '1px solid oklch(0.66 0.21 25 / 0.45)',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: '6px', color: 'var(--status-red)' }}>
                      Realtime Barge-In PlaybackReceipt (throughMs={state.lastPlaybackReceipt.throughMs}ms)
                    </div>
                    <div>
                      <strong>Heard by User:</strong> "{state.lastPlaybackReceipt.heardText}"
                    </div>
                    <div>
                      <strong>Unheard (Truncated):</strong> "{state.lastPlaybackReceipt.unheardText}"
                    </div>
                    <div style={{ marginTop: '4px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                      {state.lastPlaybackReceipt.controlNote}
                    </div>
                  </div>
                )}
              </section>

              {/* 4-Tier Affect Telemetry & Soul Portability Switcher */}
              <div className="ashy-grid-2">
                <section className="ashy-card">
                  <div className="ashy-card-title">
                    <span>4-Layer Affective State Telemetry</span>
                    <span className="ashy-badge emerald">Half-Life Decay: 25m</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Layer 1 Pulse Emotion:</span>
                        <strong>{state.stageEmotion}</strong>
                      </div>
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Layer 2 Mood Vector [Valence, Arousal, Playfulness]:</span>
                        <strong data-testid="mood-vector-readout">
                          [{state.mood.valence.toFixed(2)}, {state.mood.arousal.toFixed(2)},{' '}
                          {state.mood.playfulness.toFixed(2)}]
                        </strong>
                      </div>
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Layer 3 Seriousness Gate Max Playfulness:</span>
                        <strong>
                          {state.lastPrompt.seriousness.maxPlayfulnessAllowed.toFixed(2)}
                        </strong>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="ashy-card">
                  <div className="ashy-card-title">
                    <span>Soul Portability — LLM Provider Switcher</span>
                    <span className="ashy-badge violet">KV-Cache Warm</span>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '8px',
                    }}
                  >
                    {SUPPORTED_MODELS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        data-testid={`model-btn-${m.id}`}
                        className={`ashy-btn ${state.activeModelId === m.id ? 'primary' : ''}`}
                        onClick={() => state.setActiveModelId(m.id)}
                      >
                        <div>{m.label}</div>
                        <div style={{ fontSize: '10px', opacity: 0.8 }}>{m.provider}</div>
                      </button>
                    ))}
                  </div>
                </section>
              </div>

              {/* Compiled Soul Prompt Preview */}
              <section className="ashy-card">
                <div className="ashy-card-title">
                  <span>
                    Live Compiled Turn Prompt ({state.lastPrompt.modelId}) — Static Soul + Plain Markdown [Context]
                  </span>
                  <button
                    type="button"
                    className="ashy-btn"
                    onClick={() => setShowCompiledPrompt(!showCompiledPrompt)}
                  >
                    {showCompiledPrompt ? 'Hide Prompt' : 'Show Prompt'}
                  </button>
                </div>
                {showCompiledPrompt && (
                  <div
                    data-testid="compiled-prompt-preview"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '12px',
                      fontSize: '11px',
                      fontFamily: 'monospace',
                    }}
                  >
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px',
                        borderRadius: '10px',
                        background: 'oklch(0.11 0.015 275)',
                        border: '1px solid var(--border-subtle)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: '220px',
                        overflowY: 'auto',
                      }}
                    >
                      {state.lastPrompt.systemPrompt}
                    </pre>
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px',
                        borderRadius: '10px',
                        background: 'oklch(0.11 0.015 275)',
                        border: '1px solid var(--border-subtle)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: '220px',
                        overflowY: 'auto',
                      }}
                    >
                      {state.lastPrompt.userTurnContent}
                    </pre>
                  </div>
                )}
              </section>
            </>
          )}

          {state.activeTab === 'story' && (
            <section className="ashy-card" data-testid="panel-story">
              <div className="ashy-card-title">
                <span>Our Story — Autobiographical Shared Timeline</span>
                <span className="ashy-badge rose">{state.milestones.length} Milestones</span>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  marginBottom: '16px',
                }}
              >
                {state.milestones.map((ms) => (
                  <div
                    key={ms.id}
                    data-testid={`milestone-card-${ms.id}`}
                    style={{
                      padding: '14px',
                      borderRadius: '12px',
                      background: 'oklch(0.11 0.015 275)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '6px',
                      }}
                    >
                      <strong style={{ fontSize: '14px' }}>{ms.title}</strong>
                      <span className="ashy-badge violet">{ms.category}</span>
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      {ms.narrative}
                    </div>
                  </div>
                ))}
              </div>

              {/* Add Milestone Form */}
              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  flexWrap: 'wrap',
                  paddingTop: '12px',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <input
                  type="text"
                  className="ashy-input"
                  placeholder="Milestone title..."
                  value={msTitle}
                  onChange={(e) => setMsTitle(e.target.value)}
                />
                <input
                  type="text"
                  className="ashy-input"
                  style={{ flex: 1 }}
                  placeholder="Narrative summary..."
                  value={msNarrative}
                  onChange={(e) => setMsNarrative(e.target.value)}
                />
                <select
                  className="ashy-select"
                  value={msCategory}
                  onChange={(e) => setMsCategory(e.target.value as MilestoneCategory)}
                >
                  {MILESTONE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ashy-btn primary"
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
                  Record Milestone
                </button>
              </div>
            </section>
          )}

          {state.activeTab === 'memories' && (
            <>
              {/* Relational Motifs (Inside-Joke Engine) */}
              <section className="ashy-card" data-testid="panel-inside-jokes">
                <div className="ashy-card-title">
                  <span>Inside-Joke Engine (Relational Motifs & Anti-Saturation Cooldown)</span>
                  <span className="ashy-badge violet">{state.relationalMotifs.length} Motifs</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {state.relationalMotifs.map((motif) => {
                    const cooldown = state.getMotifCooldownInfo(motif.id)
                    return (
                      <div
                        key={motif.id}
                        data-testid={`motif-card-${motif.id}`}
                        style={{
                          padding: '12px',
                          borderRadius: '12px',
                          background: 'oklch(0.11 0.015 275)',
                          border: '1px solid var(--border-subtle)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '12px',
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <strong>"{motif.motif}"</strong>
                            <span className="ashy-badge rose">{motif.stage}</span>
                            <span className="ashy-badge violet">hits: {motif.timesUsed}</span>
                            <span
                              className={`ashy-badge ${
                                cooldown.isCooldownLocked ? 'amber' : 'emerald'
                              }`}
                              data-testid={`motif-cooldown-${motif.id}`}
                            >
                              {cooldown.isCooldownLocked
                                ? `Cooldown Locked (${cooldown.remainingCooldownHours.toFixed(1)}h)`
                                : 'Ready'}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: '12px',
                              color: 'var(--text-secondary)',
                              marginTop: '4px',
                            }}
                          >
                            {motif.originSummary}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            type="button"
                            className="ashy-btn"
                            data-testid={`btn-invoke-motif-${motif.id}`}
                            onClick={() => state.invokeMotifManually(motif.id)}
                          >
                            Invoke Callback
                          </button>
                          <button
                            type="button"
                            className="ashy-btn"
                            data-testid={`btn-reset-motif-${motif.id}`}
                            onClick={() => state.resetMotifCooldown(motif.id)}
                          >
                            Reset Cooldown
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>

              {/* Episodic Memories (FSRS-6 + Flashbulb) */}
              <section className="ashy-card" data-testid="panel-episodic-memories">
                <div className="ashy-card-title">
                  <span>Episodic Memories (FSRS-6 Forgetting Curve + Flashbulb Floor)</span>
                  <input
                    type="text"
                    className="ashy-input"
                    data-testid="input-memory-search"
                    placeholder="Hybrid BM25 + Vector search..."
                    value={state.memorySearchQuery}
                    onChange={(e) => state.searchMemories(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {state.rankedMemories.map((item) => (
                    <div
                      key={item.memory.id}
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        background: 'oklch(0.11 0.015 275)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <strong>{item.memory.title}</strong>
                          {item.memory.isFlashbulb && (
                            <span className="ashy-badge rose">Flashbulb (R &gt;= 0.70 Floor)</span>
                          )}
                          <span className="ashy-badge emerald">
                            R={Math.round(item.effectiveRetrievability * 100)}% (S=
                            {item.memory.stability.toFixed(1)}d)
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          {(['again', 'hard', 'good', 'easy'] as FsrsReviewRating[]).map((r) => (
                            <button
                              key={r}
                              type="button"
                              className="ashy-btn"
                              onClick={() => state.reviewEpisodicMemoryById(item.memory.id, r)}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {item.memory.summary}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Semantic Facts & User Habits / Prospective Intents */}
              <div className="ashy-grid-2">
                <section className="ashy-card">
                  <div className="ashy-card-title">
                    <span>Bi-Temporal Semantic Facts</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      marginBottom: '12px',
                      fontSize: '12px',
                    }}
                  >
                    {state.semanticFacts.map((fact) => (
                      <div
                        key={fact.id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'oklch(0.11 0.015 275)',
                          opacity: fact.invalidAt ? 0.6 : 1,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span>
                          [{fact.category}] {fact.subject} {fact.predicate} <strong>{fact.object}</strong>
                        </span>
                        <span className={`ashy-badge ${fact.invalidAt ? 'amber' : 'emerald'}`}>
                          {fact.invalidAt ? 'Invalidated History' : 'Active'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <select
                      className="ashy-select"
                      value={factCategory}
                      onChange={(e) => setFactCategory(e.target.value as SemanticFactCategory)}
                    >
                      {SEMANTIC_FACT_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className="ashy-input"
                      style={{ width: '90px' }}
                      value={factSubject}
                      onChange={(e) => setFactSubject(e.target.value)}
                    />
                    <input
                      type="text"
                      className="ashy-input"
                      style={{ width: '130px' }}
                      value={factPredicate}
                      onChange={(e) => setFactPredicate(e.target.value)}
                    />
                    <input
                      type="text"
                      className="ashy-input"
                      style={{ flex: 1 }}
                      placeholder="New object value..."
                      value={factObject}
                      onChange={(e) => setFactObject(e.target.value)}
                    />
                    <button
                      type="button"
                      className="ashy-btn primary"
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
                      Upsert Fact
                    </button>
                  </div>
                </section>

                <section className="ashy-card">
                  <div className="ashy-card-title">
                    <span>User Habits & Prospective Intents</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                    {state.userHabits.map((h) => (
                      <div
                        key={h.id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'oklch(0.11 0.015 275)',
                        }}
                      >
                        <strong>Habit ({h.patternKey}):</strong> {h.description}
                      </div>
                    ))}
                    {state.prospectiveIntents.map((intent) => (
                      <div
                        key={intent.id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'oklch(0.11 0.015 275)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span>
                          <strong>Intent:</strong> {intent.topic} ({intent.status})
                        </span>
                        {intent.status !== 'completed' && (
                          <button
                            type="button"
                            className="ashy-btn"
                            onClick={() => state.completeProspectiveIntent(intent.id)}
                          >
                            Mark Completed
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}

          {state.activeTab === 'personality' && (
            <section className="ashy-card" data-testid="panel-personality">
              <div className="ashy-card-title">
                <span>Layer 4 Auditable & Reversible Personality Evolution + Dream Center</span>
                <button
                  type="button"
                  className="ashy-btn primary"
                  data-testid="btn-trigger-dream"
                  onClick={() => state.runDreamConsolidation()}
                >
                  Run Dream & Reflection Consolidation
                </button>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  marginBottom: '20px',
                }}
              >
                {TRAIT_META.map((tm) => {
                  const val = state.traits[tm.key]
                  return (
                    <div key={tm.key}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '13px',
                          marginBottom: '4px',
                        }}
                      >
                        <span>
                          {tm.label} (<code>{tm.key}</code> / <code>{tm.shortAlias}</code>)
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

              <div className="ashy-card-title">
                <span>Personality Evolution Log (Bounded |Δ| &lt;= 0.08 + 1-Click Revert)</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                {state.personalityEvolutionLog.length === 0 ? (
                  <div style={{ color: 'var(--text-secondary)' }}>
                    No trait evolutions logged yet. Click "Run Dream & Reflection Consolidation" to trigger one.
                  </div>
                ) : (
                  state.personalityEvolutionLog.map((rec) => (
                    <div
                      key={rec.id}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '10px',
                        background: 'oklch(0.11 0.015 275)',
                        border: '1px solid var(--border-subtle)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <div>
                          <strong>{rec.trait}:</strong> {rec.oldValue.toFixed(2)} →{' '}
                          {rec.newValue.toFixed(2)}
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>{rec.explanation}</div>
                      </div>
                      {rec.revertedAt ? (
                        <span className="ashy-badge amber">Reverted</span>
                      ) : (
                        <button
                          type="button"
                          className="ashy-btn danger"
                          data-testid={`btn-revert-evolution-${rec.id}`}
                          onClick={() => state.revertTraitEvolution(rec.id)}
                        >
                          Revert
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {state.activeTab === 'agency' && (
            <>
              {/* Ashy's 2D Interactive Room & Unlocked Trophies */}
              <section className="ashy-card" data-testid="panel-room">
                <div className="ashy-card-title">
                  <span>Ashy's 2D Interactive Room — Unlocked Milestone Relics</span>
                  <span className="ashy-badge violet">Ambient Night Studio</span>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '12px',
                  }}
                >
                  {state.roomTrophies.map((trophy) => (
                    <div
                      key={trophy.id}
                      data-testid={`room-trophy-${trophy.id}`}
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        background: 'oklch(0.11 0.015 275)',
                        border: '1px solid oklch(0.72 0.19 345 / 0.4)',
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>
                        🏆 {trophy.title}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        {trophy.subtitle}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Privacy Shield Controls */}
              <section className="ashy-card" data-testid="panel-privacy-shield">
                <div className="ashy-card-title">
                  <span>Explicit Privacy Shield Controls</span>
                  <button
                    type="button"
                    className="ashy-btn danger"
                    data-testid="btn-activate-privacy-shield"
                    onClick={() => state.activateFullPrivacyShield()}
                  >
                    1-Click Activate Full Privacy Shield
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px' }}>
                  <div>
                    <span>MicMode: </span>
                    {(['muted', 'continuous', 'ptt'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`ashy-btn ${state.privacyState.micMode === m ? 'primary' : ''}`}
                        style={{ marginLeft: '4px' }}
                        onClick={() => state.setMicMode(m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <div>
                    <span>EyesMode: </span>
                    {(['off', 'window', 'screen'] as const).map((em) => (
                      <button
                        key={em}
                        type="button"
                        className={`ashy-btn ${state.privacyState.eyesMode === em ? 'primary' : ''}`}
                        style={{ marginLeft: '4px' }}
                        onClick={() => state.setEyesMode(em)}
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                  <div>
                    <button
                      type="button"
                      className={`ashy-btn ${state.privacyState.dndMode ? 'danger' : ''}`}
                      onClick={() => state.setDndMode(!state.privacyState.dndMode)}
                    >
                      DND Mode: {state.privacyState.dndMode ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>
              </section>

              {/* Progressive MCP Discovery & 3-Tier Action Gatekeeper */}
              <section className="ashy-card" data-testid="panel-mcp-gatekeeper">
                <div className="ashy-card-title">
                  <span>
                    Progressive MCP Discovery (search_mcp_tools: {state.exposedMetaToolsCount} Meta-Tools Exposed /{' '}
                    {state.registeredMcpToolsCount} Registered)
                  </span>
                  <input
                    type="text"
                    className="ashy-input"
                    placeholder="search_mcp_tools query..."
                    value={state.mcpSearchQuery}
                    onChange={(e) => state.searchMcpTools(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
                  <button
                    type="button"
                    className="ashy-btn"
                    data-testid="btn-mcp-observe"
                    onClick={() =>
                      state.triggerMcpTool('get_active_window_title', {
                        windowTitle: 'VS Code — Ashy Workspace',
                      })
                    }
                  >
                    Observe Window (observe-only)
                  </button>
                  <button
                    type="button"
                    className="ashy-btn primary"
                    data-testid="btn-mcp-safe-note"
                    onClick={() =>
                      state.triggerMcpTool('write_project_note', {
                        title: 'Ashy Architecture Note',
                        content: 'Verified 3-tier MCP gatekeeper.',
                      })
                    }
                  >
                    Stage Safe Action (write_project_note)
                  </button>
                  <button
                    type="button"
                    className="ashy-btn danger"
                    data-testid="btn-mcp-blast"
                    onClick={() =>
                      state.triggerMcpTool('run_cleanup_command', {
                        command: 'rm -rf /tmp/build',
                      })
                    }
                  >
                    Stage High-Blast Action (rm -rf /tmp/build)
                  </button>
                  <button
                    type="button"
                    className="ashy-btn danger"
                    data-testid="btn-mcp-traversal"
                    onClick={() =>
                      state.triggerMcpTool('read_workspace_file', {
                        path: '../../etc/passwd',
                      })
                    }
                  >
                    Test Path Traversal Attack (../../etc/passwd)
                  </button>
                </div>

                {/* Pending Action Approval Cards */}
                {state.pendingActions.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      marginBottom: '14px',
                    }}
                  >
                    {state.pendingActions.map((card) => (
                      <div
                        key={card.id}
                        data-testid={`pending-action-${card.id}`}
                        style={{
                          padding: '12px',
                          borderRadius: '12px',
                          background: card.blastRadiusWarning
                            ? 'oklch(0.66 0.21 25 / 0.15)'
                            : 'oklch(0.11 0.015 275)',
                          border: card.blastRadiusWarning
                            ? '1px solid oklch(0.66 0.21 25 / 0.55)'
                            : '1px solid var(--border-accent)',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong>{card.summary}</strong>
                          <span className="ashy-badge amber">{card.riskTier}</span>
                        </div>
                        <div
                          style={{
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            margin: '4px 0',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          Args: {card.argsPreview}
                        </div>
                        {card.blastRadiusWarning && (
                          <div
                            style={{
                              fontSize: '12px',
                              fontWeight: 700,
                              color: 'var(--status-red)',
                              marginBottom: '6px',
                            }}
                          >
                            ⚠️ {card.blastRadiusWarning}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                          <button
                            type="button"
                            className="ashy-btn primary"
                            data-testid={`btn-approve-once-${card.id}`}
                            onClick={() => state.approvePendingAction(card.id, 'once')}
                          >
                            Approve Once
                          </button>
                          <button
                            type="button"
                            className="ashy-btn"
                            data-testid={`btn-approve-session-${card.id}`}
                            onClick={() => state.approvePendingAction(card.id, 'session')}
                          >
                            Approve Session
                          </button>
                          <button
                            type="button"
                            className="ashy-btn danger"
                            data-testid={`btn-deny-${card.id}`}
                            onClick={() => state.denyPendingAction(card.id)}
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Immutable Audit Log */}
                <div className="ashy-card-title">
                  <span>Immutable Action Audit Log ({state.auditLog.length} Entries)</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                  {state.auditLog.map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        background: 'oklch(0.11 0.015 275)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>
                        <strong>{entry.toolName}</strong> ({entry.riskTier}) —{' '}
                        <code>{entry.argsPreview}</code>
                        {entry.blastRadiusWarning ? ` [${entry.blastRadiusWarning}]` : ''}
                      </span>
                      <span
                        className={`ashy-badge ${
                          entry.decision === 'approved' || entry.decision === 'allowed'
                            ? 'emerald'
                            : entry.decision === 'staged'
                              ? 'amber'
                              : 'red'
                        }`}
                      >
                        {entry.decision}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
