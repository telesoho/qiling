const MAX_SELECTION_CODE_POINTS = 8_000
const MAX_EXPLANATION_CODE_POINTS = 400

function readSelection(editor) {
  if (!editor || !editor.selection || editor.selection.isEmpty) {
    const error = new Error('selection_unavailable')
    error.code = 'selection_unavailable'
    throw error
  }
  const text = editor.document.getText(editor.selection)
  if (!text.trim()) {
    const error = new Error('selection_unavailable')
    error.code = 'selection_unavailable'
    throw error
  }
  if (Array.from(text).length > MAX_SELECTION_CODE_POINTS) {
    const error = new Error('selection_too_large')
    error.code = 'selection_too_large'
    throw error
  }
  return text
}

function validateExplanation(text) {
  const result = text.trim()
  if (!result || Array.from(result).length > MAX_EXPLANATION_CODE_POINTS) {
    const error = new Error('response_too_large')
    error.code = 'response_too_large'
    throw error
  }
  return result
}

function findRememberedChatModel(models, modelId) {
  if (typeof modelId !== 'string' || !modelId) return undefined
  return models.find((model) => model.id === modelId)
}

async function chooseChatModel({
  models,
  rememberedModelId,
  forcePicker = false,
  pickModel,
  saveModelId,
}) {
  let model = forcePicker
    ? undefined
    : findRememberedChatModel(models, rememberedModelId)
  if (!model && !forcePicker && !rememberedModelId && models.length === 1) {
    model = models[0]
  }
  if (!model) model = await pickModel(models)
  if (!model) return undefined
  if (rememberedModelId !== model.id) await saveModelId(model.id)
  return model
}

module.exports = {
  MAX_SELECTION_CODE_POINTS,
  readSelection,
  validateExplanation,
  findRememberedChatModel,
  chooseChatModel,
}
