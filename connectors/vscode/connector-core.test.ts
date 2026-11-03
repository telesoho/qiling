import { describe, expect, it, vi } from 'vitest'
import {
  chooseChatModel,
  MAX_SELECTION_CODE_POINTS,
  readSelection,
  validateExplanation,
} from './connector-core.cjs'

describe('VS Code selection connector', () => {
  it('reads only a bounded nonempty selection from the active editor', () => {
    const selection = { isEmpty: false }
    const editor = {
      selection,
      document: {
        getText: (range: unknown) => {
          expect(range).toBe(selection)
          return 'const answer = 42;'
        },
      },
    }

    expect(readSelection(editor)).toBe('const answer = 42;')
  })

  it('rejects a missing editor, an empty selection, and oversized text', () => {
    expect(() => readSelection(undefined)).toThrow('selection_unavailable')
    expect(() =>
      readSelection({
        selection: { isEmpty: true },
        document: { getText: () => 'ignored' },
      }),
    ).toThrow('selection_unavailable')
    expect(() =>
      readSelection({
        selection: { isEmpty: false },
        document: { getText: () => 'a'.repeat(MAX_SELECTION_CODE_POINTS + 1) },
      }),
    ).toThrow('selection_too_large')
  })

  it('counts Unicode code points when enforcing the selection limit', () => {
    const selection = '😀'.repeat(MAX_SELECTION_CODE_POINTS)
    expect(
      readSelection({
        selection: { isEmpty: false },
        document: { getText: () => selection },
      }),
    ).toBe(selection)
    expect(() =>
      readSelection({
        selection: { isEmpty: false },
        document: { getText: () => `${selection}😀` },
      }),
    ).toThrow('selection_too_large')
  })

  it('accepts a bounded model explanation and rejects empty or oversized results', () => {
    expect(validateExplanation('  This declares a constant.  ')).toBe(
      'This declares a constant.',
    )
    expect(() => validateExplanation(' \n ')).toThrow('response_too_large')
    expect(() => validateExplanation('a'.repeat(401))).toThrow('response_too_large')
  })

  it('remembers the first model choice and reuses it on later explanations', async () => {
    const models = [
      { id: 'vendor.model-a', name: 'Model A' },
      { id: 'vendor.model-b', name: 'Model B' },
    ]
    const savedIds: string[] = []
    let pickerCalls = 0
    const pickModel = async (available: typeof models) => {
      pickerCalls += 1
      return available[1]
    }
    const saveModelId = async (id: string) => {
      savedIds.push(id)
    }

    const selected = await chooseChatModel({
      models,
      rememberedModelId: undefined,
      pickModel,
      saveModelId,
    })
    const reused = await chooseChatModel({
      models,
      rememberedModelId: savedIds[0],
      pickModel,
      saveModelId,
    })

    expect(selected).toBe(models[1])
    expect(reused).toBe(models[1])
    expect(pickerCalls).toBe(1)
    expect(savedIds).toEqual(['vendor.model-b'])
  })

  it('asks for a replacement when the remembered model is unavailable', async () => {
    const models = [{ id: 'vendor.model-a', name: 'Model A' }]
    const saveModelId = vi.fn(async () => {})
    const pickModel = vi.fn(async (available: typeof models) => available[0])

    const selected = await chooseChatModel({
      models,
      rememberedModelId: 'vendor.removed-model',
      pickModel,
      saveModelId,
    })

    expect(selected).toBe(models[0])
    expect(pickModel).toHaveBeenCalledOnce()
    expect(saveModelId).toHaveBeenCalledWith('vendor.model-a')
  })

  it('automatically remembers the only available model', async () => {
    const models = [{ id: 'vendor.only-model', name: 'Only Model' }]
    const pickModel = vi.fn()
    const saveModelId = vi.fn(async () => {})

    const selected = await chooseChatModel({
      models,
      rememberedModelId: undefined,
      pickModel,
      saveModelId,
    })

    expect(selected).toBe(models[0])
    expect(pickModel).not.toHaveBeenCalled()
    expect(saveModelId).toHaveBeenCalledWith('vendor.only-model')
  })
})
