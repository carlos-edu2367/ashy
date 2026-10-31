import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  ASHY_HOST_RPC_METHODS,
  AshyHostRpcMethodSchema,
  ASHY_SOUL_ARCHIVE_MAGIC,
  CURRENT_SOUL_SCHEMA_VERSION,
  FORBIDDEN_PROTO_KEYS,
  canonicalizeJson,
  safeJsonParseWithoutProto,
  CompleteOnboardingInputSchema,
  CortexSoulSnapshotSchema,
  AshySoulBundlePayloadSchema,
  AshySoulArchiveSchema,
  ExportSoulInputSchema,
  ImportSoulInputSchema,
  EncryptionAtRestStatusSchema,
  SetEncryptionAtRestInputSchema,
  DEFAULT_STAGE_SHORTCUTS,
  StageShortcutBindingsSchema,
  AutoUpdaterStateSchema,
  AshyHostStreamEventSchema,
  HostBootstrapSnapshotSchema,
  DEFAULT_PERSISTED_STAGE_PREFERENCES,
  type AshyHostBridge,
} from '../index'

describe('Phase 9 Shared Protocol Contracts, canonicalizeJson & Security Reviver', () => {
  it('canonicalizes JSON deterministically regardless of key order and rejects non-finite numbers or forbidden keys', () => {
    expect(FORBIDDEN_PROTO_KEYS.has('__proto__')).toBe(true)
    expect(FORBIDDEN_PROTO_KEYS.has('constructor')).toBe(true)
    expect(FORBIDDEN_PROTO_KEYS.has('prototype')).toBe(true)

    const objA = {
      z: 1,
      a: {
        d: 'hello',
        b: [3, undefined, { y: false, x: null }],
        undefProp: undefined,
      },
      m: true,
    }
    const objB = {
      m: true,
      a: {
        b: [3, null, { x: null, y: false }],
        d: 'hello',
      },
      z: 1,
    }

    const canonA = canonicalizeJson(objA)
    const canonB = canonicalizeJson(objB)
    expect(canonA).toBe(canonB)
    expect(canonA).toBe('{"a":{"b":[3,null,{"x":null,"y":false}],"d":"hello"},"m":true,"z":1}')

    expect(() => canonicalizeJson(Number.NaN)).toThrow(/non-finite/i)
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i)
    expect(() => canonicalizeJson(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/i)

    const protoObj = Object.defineProperty({}, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    })
    expect(() => canonicalizeJson(protoObj)).toThrow('Forbidden key in JSON payload: __proto__')

    const constructorObj = { constructor: 'evil' }
    expect(() => canonicalizeJson(constructorObj)).toThrow(
      'Forbidden key in JSON payload: constructor',
    )

    const prototypeObj = { nested: { prototype: 'evil' } }
    expect(() => canonicalizeJson(prototypeObj)).toThrow(
      'Forbidden key in JSON payload: prototype',
    )
  })

  it('parses JSON safely via safeJsonParseWithoutProto while rejecting __proto__, constructor, and prototype pollution', () => {
    const clean = safeJsonParseWithoutProto<{ name: string; items: number[] }>(
      '{"name":"Ashy","items":[1,2,3]}',
    )
    expect(clean).toEqual({ name: 'Ashy', items: [1, 2, 3] })

    expect(() =>
      safeJsonParseWithoutProto('{"__proto__":{"isAdmin":true}}'),
    ).toThrow('Forbidden key in JSON payload: __proto__')

    expect(() =>
      safeJsonParseWithoutProto('{"nested":{"constructor":{"prototype":{"polluted":1}}}}'),
    ).toThrow(/Forbidden key in JSON payload: (prototype|constructor)/)

    expect(() =>
      safeJsonParseWithoutProto('[{"prototype":"bad"}]'),
    ).toThrow('Forbidden key in JSON payload: prototype')
  })

  it('validates expanded CompleteOnboardingInputSchema with optional Phase 9 fields while preserving backward compatibility', () => {
    const legacyMinimal = v.safeParse(CompleteOnboardingInputSchema, {
      userName: 'Carlos',
    })
    expect(legacyMinimal.success).toBe(true)
    if (legacyMinimal.success) {
      expect(legacyMinimal.output.seedFirstGreeting).toBeUndefined()
    }

    const fullPhase9 = v.safeParse(CompleteOnboardingInputSchema, {
      userName: 'Carlos',
      userPronouns: 'ele/dele',
      architectureMode: 'local-omni',
      providerConfig: {
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'lfm3-omni:2b',
        isOmniModel: true,
        omniExecutionMode: 'native-omni',
      },
      voiceSettings: {
        unifiedOmniMode: true,
        directOmniAudio: true,
        autoSpeakReplies: true,
      },
      agencyConsent: {
        eyesMode: 'window',
        micMode: 'ptt',
        dndMode: false,
        approvalPolicy: 'ask',
      },
      initiativePolicy: {
        enabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
      },
      stagePreferences: {
        stageMode: 'live2d',
        live2dPresetId: 'hiyori',
      },
      seedFirstGreeting: true,
    })
    expect(fullPhase9.success).toBe(true)
    if (fullPhase9.success) {
      expect(fullPhase9.output.architectureMode).toBe('local-omni')
      expect(fullPhase9.output.seedFirstGreeting).toBe(true)
      expect(fullPhase9.output.agencyConsent?.micMode).toBe('ptt')
    }

    expect(
      v.safeParse(CompleteOnboardingInputSchema, {
        userName: 'Carlos',
        architectureMode: 'invalid-arch',
      }).success,
    ).toBe(false)
  })

  it('validates ASHY_SOUL_V1 portability schemas and EncryptionAtRest schemas strictly', () => {
    expect(ASHY_SOUL_ARCHIVE_MAGIC).toBe('ASHY_SOUL_V1')
    expect(CURRENT_SOUL_SCHEMA_VERSION).toBe(5)

    const validCortexSnapshot = {
      episodicMemories: [],
      semanticFacts: [],
      relationalMotifs: [],
      milestones: [],
      userHabits: [],
      prospectiveIntents: [],
      personalityEvolution: [],
      chatSessions: [],
      chatMessages: [],
      dreamJournalEntries: [],
    }
    expect(v.safeParse(CortexSoulSnapshotSchema, validCortexSnapshot).success).toBe(true)

    const validPayload = {
      formatVersion: 1 as const,
      schemaVersion: 5,
      exportedAt: '2026-10-31T12:00:00.000Z',
      appVersion: '1.0.0',
      cortex: validCortexSnapshot,
      voiceIdentityMarkdown: '# Ashy Soul',
      stagePreferences: DEFAULT_PERSISTED_STAGE_PREFERENCES,
      voicePreferences: { activeSttProviderId: 'deterministic-wav-stt' },
    }
    expect(v.safeParse(AshySoulBundlePayloadSchema, validPayload).success).toBe(true)

    const validArchive = {
      magic: 'ASHY_SOUL_V1' as const,
      checksumSha256: 'a'.repeat(64),
      payload: validPayload,
    }
    expect(v.safeParse(AshySoulArchiveSchema, validArchive).success).toBe(true)

    // Rejects bad magic, bad checksum, or out-of-range schemaVersion
    expect(
      v.safeParse(AshySoulArchiveSchema, {
        ...validArchive,
        magic: 'ASHY_SOUL_V0',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(AshySoulArchiveSchema, {
        ...validArchive,
        checksumSha256: 'not-a-sha256',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(AshySoulArchiveSchema, {
        ...validArchive,
        payload: { ...validPayload, schemaVersion: 99 },
      }).success,
    ).toBe(false)

    expect(v.safeParse(ExportSoulInputSchema, undefined).success).toBe(true)
    expect(
      v.safeParse(ExportSoulInputSchema, {
        includeChatHistory: true,
        includeAuditLog: false,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(ImportSoulInputSchema, {
        archive: JSON.stringify(validArchive),
      }).success,
    ).toBe(true)
    expect(
      v.safeParse(ImportSoulInputSchema, {
        archive: validArchive,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(EncryptionAtRestStatusSchema, {
        enabled: true,
        algorithm: 'AES-256-GCM',
        keyBackend: 'electron-safe-storage',
        updatedAt: '2026-10-31T12:00:00.000Z',
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(EncryptionAtRestStatusSchema, {
        enabled: false,
        algorithm: 'AES-256-GCM',
        keyBackend: 'node-aes-master-key',
        updatedAt: null,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(EncryptionAtRestStatusSchema, {
        enabled: true,
        algorithm: 'AES-128-CBC',
        keyBackend: 'node-aes-master-key',
        updatedAt: null,
      }).success,
    ).toBe(false)

    expect(v.safeParse(SetEncryptionAtRestInputSchema, { enabled: true }).success).toBe(true)
    expect(v.safeParse(SetEncryptionAtRestInputSchema, { enabled: 'yes' }).success).toBe(false)
  })

  it('validates Global Shortcuts (PTT & Privacy Shield), AutoUpdaterStateSchema, Stream Events, HostBootstrapSnapshotSchema, and RPC methods', () => {
    expect(DEFAULT_STAGE_SHORTCUTS.electronGlobalPtt).toBe('CommandOrControl+Shift+Space')
    expect(DEFAULT_STAGE_SHORTCUTS.electronGlobalPrivacyShield).toBe('CommandOrControl+Shift+K')

    const parsedShortcuts = v.safeParse(StageShortcutBindingsSchema, {})
    expect(parsedShortcuts.success).toBe(true)
    if (parsedShortcuts.success) {
      expect(parsedShortcuts.output.electronGlobalPtt).toBe('CommandOrControl+Shift+Space')
      expect(parsedShortcuts.output.electronGlobalPrivacyShield).toBe('CommandOrControl+Shift+K')
    }

    expect(
      v.safeParse(StageShortcutBindingsSchema, {
        electronGlobalPtt: '',
      }).success,
    ).toBe(false)

    const validUpdaterState = {
      status: 'available' as const,
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      progressPercent: null,
      errorMessage: null,
      checkedAt: '2026-10-31T12:00:00.000Z',
      autoDownload: false,
    }
    expect(v.safeParse(AutoUpdaterStateSchema, validUpdaterState).success).toBe(true)
    expect(
      v.safeParse(AutoUpdaterStateSchema, {
        ...validUpdaterState,
        status: 'invalid-status',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(AshyHostStreamEventSchema, {
        type: 'shortcut:triggered',
        action: 'togglePtt',
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(AshyHostStreamEventSchema, {
        type: 'shortcut:triggered',
        action: 'activatePrivacyShield',
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(AshyHostStreamEventSchema, {
        type: 'updater:status',
        state: validUpdaterState,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(HostBootstrapSnapshotSchema, {
        needsOnboarding: false,
        encryptionAtRest: {
          enabled: true,
          algorithm: 'AES-256-GCM',
          keyBackend: 'node-aes-master-key',
          updatedAt: '2026-10-31T12:00:00.000Z',
        },
        updaterState: validUpdaterState,
      }).success,
    ).toBe(true)

    const expectedPhase9Methods = [
      'exportSoul',
      'importSoul',
      'wipeAllData',
      'setEncryptionAtRest',
      'getEncryptionAtRestStatus',
      'activatePrivacyShield',
      'getUpdateState',
      'checkForUpdates',
      'downloadUpdate',
      'quitAndInstallUpdate',
    ] as const

    for (const method of expectedPhase9Methods) {
      expect(ASHY_HOST_RPC_METHODS).toContain(method)
      expect(v.safeParse(AshyHostRpcMethodSchema, method).success).toBe(true)
    }

    // Type-level check that AshyHostBridge supports the optional Phase 9 methods
    const partialBridge: Partial<AshyHostBridge> = {}
    expect(partialBridge.exportSoul).toBeUndefined()
  })
})
