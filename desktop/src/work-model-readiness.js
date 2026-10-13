'use strict';

// Read-only provider evidence. This neither admits a mission nor proves an outcome.
async function workModelReadiness(transport, selectedModel) {
  if (typeof selectedModel !== 'string' || !/^ollama:[^\x00-\x1f\x7f]{1,249}$/.test(selectedModel)) {
    return { ready: false, message: 'Choose an available Ollama model for Work.' };
  }
  const model = selectedModel.slice(7);
  try {
    const response = await transport.request('POST', '/api/show', { model }, 10000);
    const ready = response.status === 200 && Array.isArray(response.json?.capabilities) && response.json.capabilities.includes('tools');
    return { ready, model: selectedModel, source: '/api/show', checked_at: new Date().toISOString(),
      message: ready ? 'The provider reports tool support. Build and sample outcomes still require committed evidence.' : 'Tool support could not be verified. Choose a model that reports tools support, then retry. Your form is unchanged.' };
  } catch {
    return { ready: false, model: selectedModel, message: 'The model service did not answer the readiness check. Check the connection and retry. Your form is unchanged.' };
  }
}
module.exports = { workModelReadiness };
