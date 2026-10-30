import { createRecoveryStore } from './project-recovery.js';
import { MAX_STUDY_BYTES } from './project-document.js';
import { serializeStudy } from './study.js';
import { createLocalSavePreference, LOCAL_SAVE_PREFERENCE_KEY } from './local-save-preference.js';

/** getStudy returns an accepted source document, or null for an untouched gallery.
 * openStudy validates and installs a recovered document; the host also protects
 * any work started while a manual restore is being validated.
 * Successful recovery only updates project-status; it is not a downloaded backup.
 */
export function initProjectUI({ getStudy, openStudy, download, setStatus = () => {},
  store = createRecoveryStore(), document: doc = globalThis.document, delay = 700,
  preference = createLocalSavePreference(), now = Date.now,
  timers = { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args) } }) {
  const $ = id => doc.getElementById(id);
  const status = $('project-status'), opener = $('recovery-open'), dialog = $('recovery-dialog');
  const list = $('recovery-list'), closer = $('recovery-close');
  const toggle = $('local-save-enabled'), preferenceNote = $('local-save-note');
  let preferenceState = preference.get(), enabled = preferenceState.enabled;
  let generation = 0, refreshSequence = 0, timer = null, viewTimer = null, pendingSnapshot = null;
  let activeAt = 0, resumeError = '', disposed = false, busy = false;
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
  function cancelViewTimer() { if (viewTimer !== null) timers.clearTimeout(viewTimer); viewTimer = null; }
  function nextActivity() { activeAt = Math.max(activeAt + 1, now()); }
  function showPreference() {
    toggle.checked = enabled;
    if (preferenceNote) {
      preferenceNote.hidden = !preferenceState.error && !resumeError;
      preferenceNote.textContent = [preferenceState.error?.message, resumeError].filter(Boolean).join(' ');
      preferenceNote.classList.toggle('is-error', !!preferenceState.error || !!resumeError);
    } else if (preferenceState.error) report(preferenceState.error);
  }
  function capture() {
    const study = getStudy();
    if (study === null || study === undefined) return null;
    // Capture before the debounce. The caller's later edits cannot mutate this
    // snapshot. getStudy has already validated it, avoiding a second geometry walk.
    const text = JSON.stringify(study);
    if (new Blob([text]).size > MAX_STUDY_BYTES) throw new Error('This project exceeds the 128 MiB recovery limit.');
    if (!study.project?.id || !Number.isSafeInteger(study.project.revision)) throw new Error('This project has no valid recovery identity.');
    return { text, label: study.name || 'Untitled study', revision: study.project.revision, activeAt };
  }
  function setBusy(value) {
    busy = value; opener.disabled = value; dialog.setAttribute('aria-busy', String(value));
    for (const button of actionButtons) button.disabled = value;
  }
  function summary() {
    if (!enabled) return 'Local saving and automatic resume are off. Existing recovery copies are kept. Download a study file to keep your work.';
    return records.length ? `${count(records.length)} available. Browser storage can be cleared; download a study file for a portable backup.`
      : 'No local recovery copies yet. Download a study file for a portable backup.';
  }
  async function save(snapshot, reason, token) {
    if (disposed || !enabled) return false;
    try {
      const record = await store.save({ study: JSON.parse(snapshot.text), label: snapshot.label, reason, activeAt: snapshot.activeAt });
      if (disposed || !enabled || token !== generation) return false;
      const removed = record.prunedCount ? ` ${record.prunedCount} older ${record.prunedCount === 1 ? 'copy removed' : 'copies removed'} to stay within storage limits.` : '';
      projectStatus(`Revision ${snapshot.revision} · Recovery copy saved in this browser.${removed} Download a study file for a portable backup.`);
      await refresh(false);
      return !disposed && token === generation;
    } catch (error) { report(error, token); return false; }
  }
  async function checkpoint() {
    if (disposed) return false;
    if (!enabled) return true;
    const token = ++generation;
    let snapshot;
    try { snapshot = capture() || pendingSnapshot?.snapshot; }
    catch (error) { report(error, token); return false; }
    cancelTimer(); cancelViewTimer(); pendingSnapshot = null;
    if (!snapshot) return true;
    projectStatus(`Revision ${snapshot.revision} · Saving a recovery copy before replacing this project…`);
    return save(snapshot, 'before-replacement', token);
  }
  function runPending() {
    cancelTimer();
    const pending = pendingSnapshot; pendingSnapshot = null;
    return pending ? save(pending.snapshot, 'automatic', pending.token) : Promise.resolve(false);
  }
  function changed({ activity = true } = {}) {
    if (disposed) return;
    if (activity) { nextActivity(); resumeError = ''; showPreference(); }
    if (!enabled) { generation++; projectStatus(summary()); return; }
    let snapshot;
    try { snapshot = capture(); }
    catch (error) { report(error, ++generation); return; }
    // A drag or unfinished slider can temporarily hide getStudy. Keep the last
    // accepted snapshot queued; a background reply must not erase that work.
    if (!snapshot) { if (activity) generation++; return; }
    const token = ++generation;
    cancelTimer(); cancelViewTimer();
    pendingSnapshot = { snapshot, token };
    projectStatus(`Revision ${snapshot.revision} · Local recovery pending…`);
    timer = timers.setTimeout(() => { timer = null; runPending(); }, delay);
  }
  function viewChanged() {
    if (disposed) return;
    nextActivity();
    if (!enabled) return;
    cancelViewTimer();
    viewTimer = timers.setTimeout(() => {
      viewTimer = null;
      changed({ activity: false });
      runPending();
    }, delay);
  }
  function flush() {
    if (disposed || !enabled) return Promise.resolve(false);
    if (viewTimer !== null) { cancelViewTimer(); changed({ activity: false }); }
    return runPending();
  }
  async function restoreLatest({ isCurrent = () => true } = {}) {
    if (disposed || !enabled) return false;
    const token = generation; let hostStarted = false;
    const current = () => !disposed && enabled && token === generation && isCurrent();
    try {
      const latest = [...await store.list()].sort((a, b) => activityTime(b) - activityTime(a) || b.sequence - a.sequence)[0];
      if (!latest || !current()) return false;
      const study = await store.read(latest.id);
      if (!current()) return false;
      if (!study) throw new Error('The latest recovery copy is no longer available.');
      // Installation intentionally calls documentChanged and changes generation.
      // The host rechecks its own document guards after asynchronous validation.
      hostStarted = true;
      const installed = await openStudy(study, { activeAt: activityTime(latest), automatic: true });
      if (installed === true) { resumeError = ''; showPreference(); }
      return installed === true;
    } catch (error) {
      // Opening itself advances the host's import token. A validation failure
      // must still be reported unless our document or preference changed.
      if (hostStarted ? !disposed && enabled && token === generation : current()) {
        resumeError = `The latest local project could not be resumed. Existing copies are kept; use Recovery copies to choose one manually. ${error.message}`;
        showPreference(); report(new Error(resumeError), token);
      }
      return false;
    }
  }
  function activityTime(record) {
    return Number.isFinite(record.activeAt) && record.activeAt >= 0 ? record.activeAt : Date.parse(record.savedAt) || 0;
  }
  function documentChanged({ activeAt: restoredActivity } = {}) {
    if (disposed) return;
    generation++; cancelTimer(); cancelViewTimer(); pendingSnapshot = null;
    if (Number.isFinite(restoredActivity) && restoredActivity >= 0) activeAt = restoredActivity;
    else nextActivity();
  }
  function preferenceChanged() {
    if (disposed) return;
    preferenceState = preference.set(toggle.checked); enabled = preferenceState.enabled;
    generation++; cancelTimer(); cancelViewTimer(); pendingSnapshot = null;
    showPreference();
    if (enabled) changed();
    else projectStatus(summary());
  }
  function externalPreferenceChanged(event) {
    if (disposed || event.key !== LOCAL_SAVE_PREFERENCE_KEY) return;
    try { if (event.storageArea !== doc.defaultView?.localStorage) return; }
    catch { return; }
    if (![null, 'true', 'false'].includes(event.newValue)) {
      preferenceState = { enabled, persisted: false, error: new Error('Another tab wrote an invalid local-saving preference. This tab keeps its current choice; choose the setting again to replace it.') };
      showPreference(); return;
    }
    enabled = event.newValue !== 'false'; preferenceState = { enabled, persisted: true, error: null };
    generation++; cancelTimer(); cancelViewTimer(); pendingSnapshot = null;
    showPreference();
    // Enabling in another tab must not save this older tab's project as new
    // user activity. Future edits/saves retain the existing activity timestamp.
    projectStatus(enabled ? 'Local saving was enabled in another tab. Future changes will be saved in this browser.' : summary());
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
        const installed = await openStudy(study);
        if (installed === false) return;
        if (disposed) return;
        resumeError = ''; showPreference();
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
  toggle.addEventListener('change', preferenceChanged); showPreference();
  doc.defaultView?.addEventListener('storage', externalPreferenceChanged);
  projectStatus('Checking local recovery copies…');
  refresh();
  return {
    changed, checkpoint, refresh, documentChanged, viewChanged, flush, restoreLatest,
    isEnabled: () => enabled,
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true; generation++; refreshSequence++; cancelTimer(); cancelViewTimer(); pendingSnapshot = null;
      opener.removeEventListener('click', open); closer.removeEventListener('click', close);
      toggle.removeEventListener('change', preferenceChanged);
      doc.defaultView?.removeEventListener('storage', externalPreferenceChanged);
      return store.close();
    },
  };
}
