# Bundled models

## `silero_vad.onnx` — Silero VAD v5

- Source: https://github.com/snakers4/silero-vad (`src/silero_vad/data/silero_vad.onnx`, branch `master`, downloaded 2026-11-01)
- License: MIT (Copyright (c) 2020-present Silero Team)
- Size: 2,327,524 bytes
- SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`
- Inputs: `input` float32 `[1, 576]` (64 context + 512 samples @ 16 kHz), `state` float32 `[2, 1, 128]`, `sr` int64; outputs: `output`, `stateN`.
- Used by `packages/voice/src/call/turn-detector.ts` (loaded by URL `/models/silero_vad.onnx` via onnxruntime-web; falls back to the DSP VAD if loading fails).
