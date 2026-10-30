import { createRecoveryStore } from './project-recovery.js';
import { MAX_STUDY_BYTES } from './project-document.js';
import { serializeStudy } from './study.js';

/** getStudy returns an accepted source document, or null for an untouched gallery.
 * openStudy installs a recovered document without another replacement checkpoint.
 * Successful recovery only updates project-status; it is not a downloaded backup.
 */
export function initProjectUI({ getStudy, openStudy, download, setStatus = () => {},
  store = createRecoveryStore(), document: doc = globalThis.document, delay = 700,
  timers = { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args) } }) {
  const $ = id => doc.getElementById(id);
  const status = $('project-status'), opener = $('recovery-open'), dialog = $('recovery-dialog');
  const list = $('recovery-list'), closer = $('recovery-close');
  let generation = 0, refreshSequence = 0, timer = null, disposed = false, busy = false;
  let records = [], actionButtons = [];
  const count = n => `${n} local recovery ${n === 1 ? 'copy' : 'copies'}`;
  function projectStatus(message, error = false) {
    if (disposed) return;
    status.textContent = message; status.classList.toggle('is-error', error);
  }
  function errorMessage(error) {
    const message = error?.message || 'Local recovery could not be completed.';
    return /download.*study/i.test(message) ? message : `${message} Download a study file to keep your work.`;
  }
  function report(error, token = generation) {
    if (disposed || token !== generation) return;
    const message = errorMessage(error); projectStatus(message, true); setStatus(message, true);
  }
  function cancelTimer() { if (timer !== null) timers.clearTimeout(timer); timer = null; }
  function capture() {
    const study = getStudy();
    if (study === null || study === undefined) return null;
    // Capture before the debounce. The caller's later edits cannot mutate this
    // snapshot. getStudy has already validated it, avoiding a second geometry walk.
    const text = JSON.stringify(study);
    if (new Blob([text]).size > MAX_STUDY_BYTES) throw new Error('This project exceeds the 128 MiB recovery limit.');
    if (!study.project?.id || !Number.isSafeInteger(study.project.revision)) throw new Error('This project has no valid recovery identity.');
    return { text, label: study.name || 'Untitled study', revision: study.project.revision };
  }
  function setBusy(value) {
    busy = value; opener.disabled = value; dialog.setAttribute('aria-busy', String(value));
    for (const button of actionButtons) button.disabled = value;
  }
  function summary() {
    return records.length ? `${count(records.length)} available. Browser storage can be cleared; download a study file for a portable backup.`
      : 'No local recovery copies yet. Download a study file for a portable backup.';
  }
  async function save(snapshot, reason, token) {
    try {
      const record = await store.save({ study: JSON.parse(snapshot.text), label: snapshot.label, reason });
      if (disposed || token !== generation) return false;
      const removed = record.prunedCount ? ` ${record.prunedCount} older ${record.prunedCount === 1 ? 'copy removed' : 'copies removed'} to stay within storage limits.` : '';
      projectStatus(`Revision ${snapshot.revision} · Recovery copy saved in this browser.${removed} Download a study file for a portable backup.`);
      await refresh(false);
      return !disposed && token === generation;
    } catch (error) { report(error, token); return false; }
  }
  async function checkpoint() {
    if (disposed) return false;
    cancelTimer(); const token = ++generation;
    let snapshot;
    try { snapshot = capture(); }
    catch (error) { report(error, token); return false; }
    if (!snapshot) return true;
    projectStatus(`Revision ${snapshot.revision} · Saving a recovery copy before replacing this project…`);
    return save(snapshot, 'before-replacement', token);
  }
  function filename(study) {
    const name = String(study.name || 'project').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 160) || 'project';
    return `${name}-r${study.project.revision}-recovery-study.json`;
  }
  async function perform(operation) {
    if (disposed || busy) return;
    const context = { token: generation };
    setBusy(true);
    try { await operation(context); }
    catch (error) { report(error, context.token); }
    finally { if (!disposed) setBusy(false); }
  }
  function render() {
    opener.textContent = `Recovery copies (${records.length})`;
    actionButtons = [];
    const children = records.map(record => {
      const row = doc.createElement('div'), title = doc.createElement('p'), meta = doc.createElement('p'), actions = doc.createElement('div');
      row.className = 'recovery-entry'; meta.className = 'control-hint'; actions.className = 'recovery-actions';
      title.textContent = record.label;
      const date = new Date(record.savedAt);
      meta.textContent = `Revision ${record.revision} · ${Number.isFinite(date.getTime()) ? date.toLocaleString() : record.savedAt}${record.reason === 'before-replacement' ? ' · Before replacing project' : ''}`;
      function button(label, operation) {
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = busy;
        button.addEventListener('click', () => perform(operation)); actionButtons.push(button); actions.append(button);
      }
      button('Restore', async context => {
        const token = generation;
        const study = await store.read(record.id);
        if (disposed || token !== generation) return;
        if (!study) throw new Error('This recovery copy is no longer available. Choose another copy.');
        if (!await checkpoint()) return;
        if (disposed) return;
        context.token = generation;
        // The host owns import validation and its document-generation guard.
        await openStudy(study);
        if (disposed) return;
        if (context.token === generation) projectStatus(`Recovered ${record.label} · Revision ${record.revision}. Download a study file for a portable backup.`);
        dialog.close(); await refresh(false);
      });
      button('Download', async () => {
        const token = generation;
        const study = await store.read(record.id);
        if (disposed) return;
        if (!study) throw new Error('This recovery copy is no longer available. Choose another copy.');
        download(filename(study), serializeStudy(study), 'application/json');
        if (token === generation) projectStatus(`Recovery download prepared for revision ${study.project.revision}. Check your browser's downloads.`);
      });
      button('Delete', async () => {
        const token = generation;
        await store.remove(record.id);
        await refresh(false);
        if (!disposed && token === generation) projectStatus(`Recovery copy deleted. ${summary()}`);
      });
      row.append(title, meta, actions); return row;
    });
    if (!children.length) {
      const empty = doc.createElement('p'); empty.className = 'control-hint'; empty.textContent = 'No recovery copies are available in this browser.'; children.push(empty);
    }
    list.replaceChildren(...children);
  }
  async function refresh(updateStatus = true) {
    if (disposed) return null;
    const sequence = ++refreshSequence, token = generation;
    try {
      const latest = await store.list();
      if (disposed || sequence !== refreshSequence) return null;
      records = latest; render();
      if (updateStatus && token === generation) projectStatus(summary());
      return records;
    } catch (error) { if (sequence === refreshSequence) report(error, token); return null; }
  }
  function open() { if (!disposed && !busy) { if (!dialog.open) dialog.showModal(); refresh(false); } }
  function close() { dialog.close(); }
  opener.addEventListener('click', open); closer.addEventListener('click', close);
  projectStatus('Checking local recovery copies…');
  refresh();
  return {
    changed() {
      if (disposed) return;
      cancelTimer(); const token = ++generation;
      let snapshot;
      try { snapshot = capture(); }
      catch (error) { report(error, token); return; }
      if (!snapshot) { projectStatus(summary()); return; }
      projectStatus(`Revision ${snapshot.revision} · Local recovery pending…`);
      timer = timers.setTimeout(() => { timer = null; save(snapshot, 'automatic', token); }, delay);
    },
    checkpoint, refresh,
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true; generation++; refreshSequence++; cancelTimer();
      opener.removeEventListener('click', open); closer.removeEventListener('click', close);
      return store.close();
    },
  };
}
