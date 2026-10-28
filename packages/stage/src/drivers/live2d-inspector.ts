import { ASHY_EMOTIONS } from '@ashy/shared'

export interface Live2DMotionGroupInfo {
  name: string
  count: number
}

export interface Live2DModelControls {
  version: number
  expressions: string[]
  motionGroups: Live2DMotionGroupInfo[]
  hitAreas: string[]
}

const FORBIDDEN_CONTROL_TOKENS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
])

function sanitizeControlToken(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    .replace(/[\u0000-\u001F<>|"`\\{}[\]]/g, '')
    .trim()
    .slice(0, 64)
  if (FORBIDDEN_CONTROL_TOKENS.has(cleaned)) return ''
  return cleaned
}

/**
 * Safely inspects a Live2D Cubism `.model3.json` manifest and extracts available
 * expression names, motion groups (with clip counts), and hit areas.
 */
export function inspectLive2DModelJson(model3Json: unknown): Live2DModelControls {
  if (typeof model3Json !== 'object' || model3Json === null || Array.isArray(model3Json)) {
    return {
      version: 3,
      expressions: [],
      motionGroups: [],
      hitAreas: [],
    }
  }

  const root = model3Json as Record<string, unknown>
  const version =
    typeof root.Version === 'number' && Number.isFinite(root.Version) ? root.Version : 3

  const expressions: string[] = []
  const seenExpressions = new Set<string>()

  const motionGroups: Live2DMotionGroupInfo[] = []
  const seenMotions = new Set<string>()

  const hitAreas: string[] = []
  const seenHitAreas = new Set<string>()

  const fileRefs =
    typeof root.FileReferences === 'object' &&
    root.FileReferences !== null &&
    !Array.isArray(root.FileReferences)
      ? (root.FileReferences as Record<string, unknown>)
      : null

  if (fileRefs) {
    if (Array.isArray(fileRefs.Expressions)) {
      for (const item of fileRefs.Expressions) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>
          const rawName =
            typeof rec.Name === 'string'
              ? rec.Name
              : typeof rec.File === 'string'
                ? rec.File.replace(/^.*\//, '').replace(/\.exp3\.json$/i, '')
                : ''
          const clean = sanitizeControlToken(rawName)
          if (clean.length > 0 && !seenExpressions.has(clean)) {
            seenExpressions.add(clean)
            expressions.push(clean)
          }
        }
      }
    }

    if (
      typeof fileRefs.Motions === 'object' &&
      fileRefs.Motions !== null &&
      !Array.isArray(fileRefs.Motions)
    ) {
      const motionsRecord = fileRefs.Motions as Record<string, unknown>
      for (const [rawGroup, groupItems] of Object.entries(motionsRecord)) {
        const cleanGroup = sanitizeControlToken(rawGroup)
        if (!cleanGroup || seenMotions.has(cleanGroup)) continue
        const count = Array.isArray(groupItems) ? groupItems.length : 0
        if (count > 0) {
          seenMotions.add(cleanGroup)
          motionGroups.push({ name: cleanGroup, count })
        }
      }
    }
  }

  if (Array.isArray(root.HitAreas)) {
    for (const area of root.HitAreas) {
      if (typeof area === 'object' && area !== null && !Array.isArray(area)) {
        const rec = area as Record<string, unknown>
        const clean = sanitizeControlToken(rec.Name ?? rec.Id)
        if (clean.length > 0 && !seenHitAreas.has(clean)) {
          seenHitAreas.add(clean)
          hitAreas.push(clean)
        }
      }
    }
  }

  return {
    version,
    expressions,
    motionGroups,
    hitAreas,
  }
}

/**
 * Formats instructions for the LLM system prompt describing how to emit inline
 * `<|ACT {"emotion":"...","intensity":0.8,"motion":"..."}|>` control tags.
 */
export function formatLive2DControlPrompt(controls: Live2DModelControls): string {
  const canonicalEmotions = ASHY_EMOTIONS.join(', ')
  const modelExpressions =
    controls.expressions.length > 0 ? controls.expressions.join(', ') : 'none (using procedural Tachie)'
  const motionSummary =
    controls.motionGroups.length > 0
      ? controls.motionGroups.map((g) => `${g.name} (${g.count})`).join(', ')
      : 'Idle (procedural)'

  return [
    '### Ashy 2D Stage Expression & Motion Control (`<|ACT ...|>`)',
    'Emit inline action tags to drive your avatar facial expression and body motion in real time:',
    'Format: `<|ACT {"emotion":"<emotion>","intensity":0.8,"motion":"<motionGroup>"}|>`',
    `- Canonical Emotions (13): ${canonicalEmotions}`,
    `- Model Expressions Loaded: ${modelExpressions}`,
    `- Available Motion Groups: ${motionSummary}`,
  ].join('\n')
}
