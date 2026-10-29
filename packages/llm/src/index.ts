export const PACKAGE_NAME = '@ashy/llm'

export * from './marker-parser'
export * from './categorizer'
export * from './anti-slop'
export {
  detectAssistantSlop,
  stripLeadingAssistantSlop,
  detectBondManipulation,
  stripBondManipulation,
  HEALTHY_BOND_FALLBACK_PT_BR,
  type AssistantSlopDetection,
  type BondManipulationCategory,
  type BondManipulationDetection,
} from './anti-slop'
export * from './stream-text'
export * from './adapters'
export * from './embeddings'
