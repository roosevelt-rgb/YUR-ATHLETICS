'use strict';
// Explicit local-model acceptance; reads only the supplied test screenshot.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createGenerationTransport } = require('../src/generation-transport');
const [model, screenshot, receipt] = process.argv.slice(2);
if (!model || !screenshot || !receipt) throw new Error('Usage: node scripts/verify_live_vision.cjs MODEL SCREENSHOT RECEIPT');
const bytes = fs.readFileSync(screenshot);
const report = { type: 'live-local-vision-outcome', model, source_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), started_at: new Date().toISOString() };
const transport = createGenerationTransport({ timeoutMs: 120000 });
(async () => {
  try {
    const result = await transport.start({ request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), provider: 'ollama', model,
      messages: [{ role: 'user', content: 'Read this desktop screenshot. Quote the large central headline exactly and list three visible sidebar items. Keep your answer under 80 words.', images: [bytes.toString('base64')] }] });
    report.response = result;
    report.passed = result.ok && /what would you like to build/i.test(result.result.answer) && /agents/i.test(result.result.answer) && /studio|projects|capabilities|workflows/i.test(result.result.answer);
  } catch (error) { report.passed = false; report.error = error.message; }
  finally {
    transport.dispose(); report.completed_at = new Date().toISOString();
    fs.writeFileSync(receipt, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.passed ? 0 : 1;
  }
})();
