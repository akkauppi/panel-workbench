/** Only this boolean preference belongs in localStorage; project snapshots use
 * the separate IndexedDB recovery store. Changing this key's value format
 * requires a new version rather than reinterpreting an existing user's choice.
 */
export const LOCAL_SAVE_PREFERENCE_KEY = 'panel-workbench:local-save:v1';

const failure = (code, message) => Object.assign(new Error(message), { name: 'LocalSavePreferenceError', code });

/** Read once, then retain the current session's choice even if persistence
 * fails. No startup write or probe is performed. A missing key is the durable
 * default (on); persisted=false reports an unreadable/invalid preference or a
 * failed change, not whether IndexedDB project saving itself is available.
 */
export function createLocalSavePreference(options = {}) {
  let enabled = true, persisted = false, error = null;
  const storage = () => Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
  const status = () => ({ enabled, persisted, error });
  try {
    // Access to localStorage itself can throw, before getItem is called.
    const target = storage();
    if (!target || typeof target.getItem !== 'function') throw new Error('Storage unavailable.');
    const value = target.getItem(LOCAL_SAVE_PREFERENCE_KEY);
    if (value === null || value === 'true' || value === 'false') {
      enabled = value !== 'false'; persisted = true;
    } else error = failure('invalid-value', 'The saved local-saving preference is invalid. Local saving is on for this session; choose the setting again to replace it.');
  } catch {
    error = failure('unavailable', 'Local saving is on for this session, but this browser\'s saved preference could not be read. The setting may change after reload.');
  }
  return {
    get: status,
    set(value) {
      if (typeof value !== 'boolean') throw new TypeError('The local-saving preference must be true or false.');
      enabled = value; persisted = false; error = null;
      try {
        const target = storage(), text = String(value);
        if (!target || typeof target.setItem !== 'function' || typeof target.getItem !== 'function') throw new Error('Storage unavailable.');
        target.setItem(LOCAL_SAVE_PREFERENCE_KEY, text);
        // Also detect a denied/silently ignored write without reverting the
        // user's current-session choice to an older persisted value.
        if (target.getItem(LOCAL_SAVE_PREFERENCE_KEY) !== text) throw new Error('Preference was not retained.');
        persisted = true;
      } catch {
        error = failure('write-failed', `Local saving is ${enabled ? 'on' : 'off'} for this session. This browser could not remember the preference; it may change after reload.`);
      }
      return status();
    },
  };
}
