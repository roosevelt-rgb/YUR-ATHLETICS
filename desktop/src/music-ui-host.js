'use strict';
const { randomUUID, createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
// A bounded native form submission to the existing Music owner. Each document
// and job is committed by Music. This adapter has no scheduler or durable store.
function createMusicUiHost({ services, getConfiguration, getWindow, confirm, deny, getSettings }) {
  const busy = new Set();
  async function invoke(owner, action, supplied) {
    let active = true, acquired = false;
    const id = randomUUID(), identity = { request_id: id, mission_id: id.replaceAll('-', ''), action_id: id.replaceAll('-', ''), owner,
      isActive: () => active && !owner.isDestroyed() && getWindow()?.webContents === owner && !getWindow()?.isDestroyed() };
    const mutation = !['music_state', 'music_catalog', 'music_status', 'services_status'].includes(action);
    const saved = {};
    try {
      if (!identity.isActive()) throw new Error('The Music window is unavailable.');
      if (!plain(supplied) || Buffer.byteLength(JSON.stringify(supplied)) > 65536) throw new Error('Music form exceeds its input budget.');
      const payload = JSON.parse(JSON.stringify(supplied));
      if (mutation && busy.has(owner)) throw new Error('Wait for the current Music action to finish.');
      if (mutation) { busy.add(owner); acquired = true; }
      const configuration = hash(getConfiguration());
      const check = () => {
        if (!identity.isActive() || configuration !== hash(getConfiguration())) throw new Error('The Music window or connection changed. Review the action again.');
        const reason = deny('franklin:service', [{ action: action === 'generate_song' ? 'music_generate' : action, payload }], getSettings());
        if (reason) throw new Error(reason);
      };
      check();
      async function approve(actionName, reviewPayload, review) {
        const fingerprint = hash({ action: actionName, payload: reviewPayload, review, operation: identity.action_id });
        const approved = await confirm({ action: actionName, payload: reviewPayload, review, fingerprint, request_id: identity.request_id,
          mission_id: identity.mission_id, source: 'music-ui' }, identity);
        check();
        if (fingerprint !== hash({ action: actionName, payload: reviewPayload, review, operation: identity.action_id })) throw new Error('The reviewed Music form changed.');
        return approved === true;
      }
      if (action === 'generate_song') {
        if (Object.keys(payload).sort().join(',') !== 'lyrics,request,title' || typeof payload.title !== 'string' || !payload.title.trim()
            || [...payload.title].length > 160 || typeof payload.lyrics !== 'string' || [...payload.lyrics].length > 20000
            || /\0/.test(payload.title + payload.lyrics) || !plain(payload.request) || 'composition_id' in payload.request || 'lyrics_id' in payload.request)
          throw new Error('Supply a title, lyrics and the selected sound settings.');
        const child = name => ({ ...identity, action_id: hash([identity.action_id, name]).slice(0, 32) });
        const preview = { request: { ...payload.request, composition_id: 'a'.repeat(32), lyrics_id: 'b'.repeat(32) } };
        services.validate('music_generate', preview, child('preflight'));
        const review = services.confirmationRequirements('music_generate', preview);
        if (!await approve('generate_song', payload, review)) return { ok: true, result: { cancelled: true, executed: false } };
        const confirmation = { confirmed: true, rights_attested: true, external_approved: Boolean(review.external_approved) };
        check();
        const composition = await services.execute('music_document', { kind: 'composition', data: { title: payload.title } }, child('composition'), confirmation);
        saved.composition_id = composition.document.id;
        check();
        const lyrics = await services.execute('music_document', { kind: 'lyrics', data: { composition_id: saved.composition_id, text: payload.lyrics } }, child('lyrics'), confirmation);
        saved.lyrics_id = lyrics.document.id;
        check();
        const result = await services.execute('music_generate', { request: { ...payload.request, ...saved } }, child('generate'), confirmation);
        return { ok: true, result: { ...result, ...saved } };
      }
      if (!['services_status', 'music_state', 'music_catalog', 'music_status', 'music_cancel', 'music_resume', 'music_export'].includes(action))
        throw new Error('This Music screen action is not available.');
      services.validate(action, payload, identity);
      const review = services.confirmationRequirements(action, payload);
      if (review.required && !await approve(action, payload, review)) return { ok: true, result: { cancelled: true, executed: false } };
      check();
      return { ok: true, result: await services.execute(action, payload, identity, review.required ? {
        confirmed: true, rights_attested: Boolean(review.rights_attested), external_approved: Boolean(review.external_approved),
      } : {}) };
    } catch (error) {
      return { ok: false, error: { code: error.code || 'MUSIC_ACTION_FAILED', message: String(error.message || 'Music action failed').slice(0, 1000), recovery: saved },
        ...(Object.keys(saved).length ? { saved, notice: 'Saved documents remain in Music. Inspect jobs before submitting again if generation outcome is uncertain.' } : {}) };
    } finally { active = false; if (acquired) busy.delete(owner); }
  }
  return { invoke };
}
module.exports = { createMusicUiHost };
