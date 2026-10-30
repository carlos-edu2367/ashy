// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null
let originalSearch = ''

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p8-'))
  tempDirs.push(dir)
  return dir
}

function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

beforeEach(() => {
  originalSearch = window.location.search
  window.history.replaceState({}, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  window.history.replaceState({}, '', originalSearch || '/')
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
  setAshyHostBridgeForTesting(null)
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 8 Contextual Initiative & Own World — Our Story, Ashy Room, Dream Journal & Initiative Limits UI', () => {
  it('1. filters and searches Nossa História timeline, displays milestone provenance badge, and edits milestones inline with M3 whitespace guard', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.seedDemoFixtures()

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    // Switch to "Nossa história" tab
    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    expect(getByTestId('panel-story')).toBeTruthy()

    // Add a manual milestone so we have both episode-linked and manual provenance badges
    let manualMsId = ''
    await act(async () => {
      const created = useAshyStore.getState().addMilestone({
        title: 'Deploy do Motor de Atenção Fase 8',
        narrative: 'Subimos o loop de iniciativa contextual com silêncio seletivo.',
        category: 'project_shipped',
      })
      manualMsId = created.id
    })

    // Provenance badges: seeded milestone has episodeId, manual milestone shows 'Capítulo manual'
    expect(getByTestId('milestone-origin-milestone-first-meeting').textContent).toContain(
      'Episódio: ep-padre-npm-origin',
    )
    expect(getByTestId(`milestone-origin-${manualMsId}`).textContent).toContain(
      'Capítulo manual',
    )

    // Filter by category 'project_shipped'
    const catSelect = getByTestId<HTMLSelectElement>('story-category-filter')
    await act(async () => {
      setNativeInputValue(catSelect, 'project_shipped')
    })

    expect(getByTestId(`milestone-card-${manualMsId}`)).toBeTruthy()
    expect(queryByTestId('milestone-card-milestone-first-meeting')).toBeNull()

    // Reset category filter to 'todas' and filter by search query
    await act(async () => {
      setNativeInputValue(catSelect, 'todas')
    })
    expect(getByTestId('milestone-card-milestone-first-meeting')).toBeTruthy()

    const searchInput = getByTestId<HTMLInputElement>('story-search-input')
    await act(async () => {
      setNativeInputValue(searchInput, 'padre')
    })

    expect(getByTestId('milestone-card-milestone-inside-joke-padre')).toBeTruthy()
    expect(queryByTestId(`milestone-card-${manualMsId}`)).toBeNull()

    // Clear search
    await act(async () => {
      setNativeInputValue(searchInput, '')
    })

    // Open inline editor on manual milestone
    await act(async () => {
      clickElement(getByTestId(`btn-edit-milestone-${manualMsId}`))
    })

    const titleInput = getByTestId<HTMLInputElement>(`input-edit-milestone-title-${manualMsId}`)
    const narrativeInput = getByTestId<HTMLInputElement | HTMLTextAreaElement>(
      `input-edit-milestone-narrative-${manualMsId}`,
    )
    const editCatSelect = getByTestId<HTMLSelectElement>(
      `select-edit-milestone-category-${manualMsId}`,
    )

    // M3 Red-Team guard: attempting to save whitespace-only title must not overwrite milestone
    await act(async () => {
      setNativeInputValue(titleInput, '   ')
      clickElement(getByTestId(`btn-save-milestone-${manualMsId}`))
    })

    expect(
      useAshyStore.getState().milestones.find((m) => m.id === manualMsId)?.title,
    ).toBe('Deploy do Motor de Atenção Fase 8')

    // Now provide valid updated title, narrative, and category
    await act(async () => {
      setNativeInputValue(titleInput, 'Marco M4 Concluído no Estúdio')
      setNativeInputValue(
        narrativeInput,
        'Nossa história viva com busca, filtro e edição inline.',
      )
      setNativeInputValue(editCatSelect, 'late_night_debug')
      clickElement(getByTestId(`btn-save-milestone-${manualMsId}`))
    })

    const updatedInStore = useAshyStore
      .getState()
      .milestones.find((m) => m.id === manualMsId)
    expect(updatedInStore?.title).toBe('Marco M4 Concluído no Estúdio')
    expect(updatedInStore?.narrative).toBe(
      'Nossa história viva com busca, filtro e edição inline.',
    )
    expect(updatedInStore?.category).toBe('late_night_debug')
    expect(getByTestId(`milestone-card-${manualMsId}`).textContent).toContain(
      'Marco M4 Concluído no Estúdio',
    )

    // Deleting a milestone while it is being edited inline cleans up the inline editor safely
    await act(async () => {
      clickElement(getByTestId(`btn-edit-milestone-${manualMsId}`))
    })
    expect(queryByTestId(`input-edit-milestone-title-${manualMsId}`)).toBeTruthy()
    await act(async () => {
      clickElement(getByTestId(`btn-delete-milestone-${manualMsId}`))
    })
    expect(queryByTestId(`milestone-card-${manualMsId}`)).toBeNull()
    expect(queryByTestId(`input-edit-milestone-title-${manualMsId}`)).toBeNull()
  })

  it('2. updates Quarto da Ashy (panel-ashy-room) lighting by time-of-day override and unlocks new trophies dynamically when milestones are added', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.seedDemoFixtures()

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    const roomPanel = getByTestId('panel-ashy-room')
    expect(roomPanel).toBeTruthy()

    // Verify seeded trophies are unlocked in Ashy's Room
    expect(getByTestId('ashy-room-trophy-trophy-first-boot-mug').textContent).toContain(
      'First Boot Mug',
    )
    expect(getByTestId('ashy-room-trophy-trophy-padre-npm-relic').textContent).toContain(
      'Padre no NPM Relic',
    )
    expect(getByTestId('ashy-room-trophy-trophy-prod-shield').textContent).toContain(
      '03:14 AM Production Shield',
    )

    // Test time-of-day simulator override
    const timeSelect = getByTestId<HTMLSelectElement>('select-room-time-override')
    await act(async () => {
      setNativeInputValue(timeSelect, '08:30')
    })
    expect(getByTestId('room-time-period-badge').textContent).toContain('morning')
    expect(getByTestId('room-lighting-badge').textContent).toContain('warm_sunrise')

    await act(async () => {
      setNativeInputValue(timeSelect, '15:00')
    })
    expect(getByTestId('room-time-period-badge').textContent).toContain('afternoon')
    expect(getByTestId('room-lighting-badge').textContent).toContain('golden_studio')

    await act(async () => {
      setNativeInputValue(timeSelect, '02:00')
    })
    expect(getByTestId('room-time-period-badge').textContent).toContain('late_night')
    expect(getByTestId('room-lighting-badge').textContent).toContain('midnight_lofi')

    // Adding a new project_shipped milestone unlocks trophy-launch-rocket dynamically
    let newMilestoneId = ''
    await act(async () => {
      const ms = useAshyStore.getState().addMilestone({
        title: 'Lançamento da Fase 8',
        narrative: 'Quarto vivo sincronizado com marcos reais.',
        category: 'project_shipped',
      })
      newMilestoneId = ms.id
    })

    const rocketTrophy = getByTestId('ashy-room-trophy-trophy-launch-rocket')
    expect(rocketTrophy.textContent).toContain('Miniatura de Foguete de Deploy')
    expect(rocketTrophy.textContent).toContain(`Marco: ${newMilestoneId}`)
  })

  it('3. populates Diário de Reflexão (panel-dream-journal) with dreamJournalEntries and crossEpisodeLinks showing episode provenance', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.seedDemoFixtures()

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    const dreamPanel = getByTestId('panel-dream-journal')
    expect(dreamPanel).toBeTruthy()

    // Create a second episode sharing the 'debug' tag with ep-padre-npm-origin so crossEpisodeLinks is populated
    await act(async () => {
      useAshyStore.getState().createMemoryCard({
        title: 'Debug de Madrugada na Fase 8',
        summary: 'Sessão de debug da Fase 8 conectando memórias episódicas distantes.',
        fullStory: 'Sessão de debug da Fase 8 conectando memórias episódicas distantes com o caso do Padre no NPM.',
        filterCategory: 'momentos',
        tags: ['debug', 'phase8'],
      })
    })

    // Trigger dream consolidation directly from Diário de Reflexão
    await act(async () => {
      clickElement(getByTestId('btn-story-run-dream'))
    })

    const entries = useAshyStore.getState().dreamJournalEntries
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const firstEntry = entries[0]!
    const entryEl = getByTestId(`dream-journal-entry-${firstEntry.id}`)
    expect(entryEl.textContent).toContain(firstEntry.summary)
    expect(entryEl.textContent).toContain('Episódios:')
    expect(entryEl.textContent).toContain('ep-padre-npm-origin')

    const links = useAshyStore.getState().crossEpisodeLinks
    expect(links.length).toBeGreaterThanOrEqual(1)
    const firstLink = links[0]!
    const linkTestId = `dream-link-${firstLink.id ?? `${firstLink.fromEpisodeId}-${firstLink.toEpisodeId}`}`
    const linkEl = getByTestId(linkTestId)
    expect(linkEl.textContent).toContain(firstLink.sharedTheme)
    expect(linkEl.textContent).toContain(firstLink.fromEpisodeId)
    expect(linkEl.textContent).toContain(firstLink.toEpisodeId)
  })

  it('4. enforces Limites de Iniciativa (panel-initiative-limits): "Nunca iniciar sozinha" toggle, quiet hours suppression, selective silence, and grounded spoken initiative', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.seedDemoFixtures()

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    const limitsPanel = getByTestId('panel-initiative-limits')
    expect(limitsPanel).toBeTruthy()
    expect(getByTestId('initiative-mode-badge').textContent).toContain(
      'Iniciativa contextual ativa',
    )

    // 1. Toggle "Nunca iniciar sozinha" (disable initiative)
    await act(async () => {
      clickElement(getByTestId('toggle-initiative-enabled'))
    })

    expect(useAshyStore.getState().initiativePolicy.enabled).toBe(false)
    expect(getByTestId('initiative-mode-badge').textContent).toContain(
      'Nunca iniciar sozinha',
    )

    await act(async () => {
      clickElement(getByTestId('btn-evaluate-initiative-now'))
    })

    expect(useAshyStore.getState().initiativeLog[0]?.decision).toBe('suppressed_disabled')
    expect(getByTestId('initiative-audit-log').textContent).toContain('suppressed_disabled')

    // 2. Re-enable initiative and disable habit modulation so 02:30 is strictly inside quiet hours (23:00-08:00)
    await act(async () => {
      clickElement(getByTestId('toggle-initiative-enabled'))
      clickElement(getByTestId('toggle-initiative-habits'))
    })
    expect(useAshyStore.getState().initiativePolicy.enabled).toBe(true)
    expect(useAshyStore.getState().initiativePolicy.modulateByHabits).toBe(false)

    await act(async () => {
      clickElement(getByTestId('btn-evaluate-initiative-quiet-hours'))
    })

    expect(useAshyStore.getState().initiativeLog[0]?.decision).toBe(
      'suppressed_quiet_hours',
    )
    expect(getByTestId('initiative-audit-log').textContent).toContain(
      'suppressed_quiet_hours',
    )

    // 3. Evaluate with selective silence ([SILENCE]) at 14:00
    await act(async () => {
      clickElement(getByTestId('btn-evaluate-initiative-silence'))
    })

    expect(useAshyStore.getState().initiativeLog[0]?.decision).toBe('selective_silence')
    expect(getByTestId('initiative-audit-log').textContent).toContain('selective_silence')

    // 4. Evaluate normal grounded initiative at 14:00 -> speaks and updates bubbleText + chatMessages
    const messagesBefore = useAshyStore.getState().chatMessages.length
    await act(async () => {
      clickElement(getByTestId('btn-evaluate-initiative-now'))
    })

    const spokenRecord = useAshyStore.getState().initiativeLog[0]!
    expect(spokenRecord.decision).toBe('spoken')
    expect(spokenRecord.sourceId).toBeTruthy()
    expect(spokenRecord.replyText).toBeTruthy()
    expect(useAshyStore.getState().bubbleText).toBe(spokenRecord.replyText)
    expect(useAshyStore.getState().chatMessages.length).toBe(messagesBefore + 1)
    expect(getByTestId('initiative-audit-log').textContent).toContain('spoken')
  })
})
