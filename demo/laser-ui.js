import { exportLaserSVG, buildLaserPaths, createLaserCoupon } from './laser-export.js';

/** Preview state belongs to this dialog; source edits invalidate every model SVG. */
export function initLaserUI({ download }) {
  const $ = id => document.getElementById(id);
  let current = { ready: false, result: null }, prepared = null, svg = null, previewURL = null;
  let worker = null, sequence = 0, busy = false, settingsKey = null;
  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const key = () => ['laser-scale', 'laser-margin', 'laser-groove', 'laser-scope'].map(id => $(id).value).join('|');
  const status = (message, error = false) => { $('laser-status').textContent = message; $('laser-status').classList.toggle('is-error', error); };
  function availability() {
    $('laser-build').disabled = !current.ready || busy;
    $('laser-build').title = !current.ready ? 'Wait for panel fitting to finish before preparing a laser model.' : '';
    $('laser-download').disabled = !svg || busy || (prepared?.kind !== 'coupon' && (!current.ready || prepared?.source !== current.result || settingsKey !== key()));
  }
  function invalidate(message) {
    sequence++; busy = false; worker?.terminate(); worker = null; svg = null;
    if (prepared) status(message);
    availability();
  }
  function options() {
    const scale = Number($('laser-scale').value), margin = Number($('laser-margin').value), engravingWidth = Number($('laser-groove').value);
    if (!Number.isFinite(scale) || scale < 1 || scale > 10000) throw new Error('Choose a scale denominator from 1 to 10000.');
    if (!Number.isFinite(margin) || margin < 5 || margin > 100) throw new Error('Choose a sheet margin from 5 to 100 mm.');
    if (!Number.isFinite(engravingWidth) || engravingWidth < 0 || engravingWidth > 10) throw new Error('Choose a fold groove width from 0 to 10 mm.');
    return { scale, width: 400, height: 400, margin, engravingWidth, allowPartial: $('laser-scope').value === 'resolved', outwardCenter: current.center, flipDirection: current.flipDirection };
  }
  function renderSheet() {
    svg = null;
    if (!prepared) return availability();
    if (prepared.kind !== 'coupon' && (!current.ready || prepared.source !== current.result || settingsKey !== key())) return availability();
    const sheet = prepared.sheets[Number($('laser-sheet').value) || 0];
    const hasBack = sheet.folds.some(fold => fold.side === 'back');
    $('laser-side').querySelector('[value="back"]').disabled = !hasBack;
    if (!hasBack) $('laser-side').value = 'front';
    const side = $('laser-side').value;
    try {
      const exportOptions = { ...prepared.options, name: prepared.name, side, labels: true };
      const paths = buildLaserPaths(sheet, exportOptions);
      svg = exportLaserSVG(sheet, exportOptions);
      if (previewURL) URL.revokeObjectURL(previewURL);
      // Thicken display strokes only; downloaded toolpaths keep their original geometry.
      const previewSVG = svg.replaceAll('stroke-width="0.1"', 'stroke-width="0.65"');
      previewURL = URL.createObjectURL(new Blob([previewSVG], { type: 'image/svg+xml' }));
      $('laser-preview').src = previewURL;
      $('laser-legend').replaceChildren(...paths.layers.filter(layer => layer.paths.length).map(layer => {
        const li = document.createElement('li'); li.style.borderColor = layer.color; li.textContent = layer.name; return li;
      }));
      const folds = sheet.folds.filter(fold => fold.side === side);
      $('laser-sheet-note').textContent = side === 'back'
        ? `${folds.length} back fold guides. Mirror is already applied. Register the sheet with a flip jig; disable gray alignment output. No cutting paths on this face.`
        : `${count(sheet.panels.length, 'panel')} · ${count(folds.length, 'front fold guide')}. ${hasBack ? 'This sheet needs back engraving first; flip, then engrave the front and cut last.' : 'Engrave this face before cutting.'} Disable gray alignment output. Check the imported dimensions in LightBurn.`;
      $('laser-output').hidden = false;
      status(prepared.summary);
    } catch (error) { $('laser-output').hidden = true; status(`SVG not ready: ${error.message}`, true); }
    availability();
  }
  function showPrepared(value) {
    prepared = value; settingsKey = key();
    $('laser-sheet').replaceChildren(...value.sheets.map((sheet, index) => {
      const option = document.createElement('option'); option.value = index; option.textContent = `Sheet ${index + 1} of ${value.sheets.length}`; return option;
    }));
    $('laser-side').value = 'front'; renderSheet();
  }
  $('open-laser').addEventListener('click', () => { $('laser-dialog').showModal(); availability(); });
  $('close-laser').addEventListener('click', () => $('laser-dialog').close());
  $('laser-build').addEventListener('click', () => {
    if (!current.ready || busy) return;
    let settings;
    try { settings = options(); } catch (error) { status(error.message, true); return; }
    invalidate('Preparing sheets…');
    const id = ++sequence, source = current.result, name = current.name;
    busy = true; status('Unfolding panels and arranging sheets…'); availability();
    worker = new Worker('./laser-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.id !== sequence || source !== current.result || !current.ready) return;
      busy = false; worker?.terminate(); worker = null;
      if (data.error) { status(`Sheets not ready: ${data.error}`, true); availability(); return; }
      const result = data.result;
      const omitted = result.excludedPanelIds.map(id => `P${String(id + 1).padStart(3, '0')}`);
      const warnings = result.diagnostics.filter(d => d.severity === 'warning' && d.code !== 'partial').map(d => d.message).join(' ');
      showPrepared({ kind: 'model', source, name, options: { ...settings, excludedPanelIds: result.excludedPanelIds }, sheets: result.sheets,
        summary: `${count(result.panels.length, 'panel')} · ${count(result.nets.length, 'connected piece')} · ${count(result.sheets.length, 'sheet')} at 1:${settings.scale}.${omitted.length ? ` INCOMPLETE — omitted ${omitted.join(', ')}.` : ''}${warnings ? ` ${warnings}` : ''}` });
    };
    worker.onerror = error => { if (id !== sequence) return; busy = false; worker?.terminate(); worker = null; status(`Sheets not ready: ${error.message}`, true); availability(); };
    worker.postMessage({ id, cells: source.cells, options: settings });
  });
  $('laser-coupon').addEventListener('click', () => {
    invalidate('Preparing hinge coupon…');
    try {
      const settings = { width: 400, height: 400, margin: 10, engravingWidth: 0 };
      showPrepared({ kind: 'coupon', name: 'plywood-hinge-coupon', options: settings, sheets: [createLaserCoupon(settings)],
        summary: 'Hinge coupon · 0, 1, 2 and 3 mm groove widths · 50 mm scale check. Blue uses Line mode; cyan uses Fill mode. Tune laser settings on scrap plywood first.' });
    } catch (error) { status(`Coupon not ready: ${error.message}`, true); availability(); }
  });
  for (const id of ['laser-scale', 'laser-margin', 'laser-groove', 'laser-scope']) $(id).addEventListener('input', () => {
    if (prepared?.kind !== 'coupon' || busy) invalidate('Settings changed. Prepare sheets again before downloading.');
  });
  for (const id of ['laser-sheet', 'laser-side']) $(id).addEventListener('change', renderSheet);
  $('laser-download').addEventListener('click', () => {
    if ($('laser-download').disabled || !svg) return;
    const sheet = Number($('laser-sheet').value) + 1, side = $('laser-side').value;
    const name = prepared.name.replace(/[^\p{L}\p{N}._-]+/gu, '-');
    const incomplete = prepared.options.excludedPanelIds?.length ? '-partial' : '';
    download(`${name}${incomplete}-${prepared.kind === 'coupon' ? 'test' : `laser-1to${prepared.options.scale}`}-sheet${sheet}-${side}.svg`, svg, 'image/svg+xml');
  });
  return {
    update(next) {
      const changed = next.result !== current.result || !next.ready && current.ready;
      current = next;
      if (changed && (busy || prepared?.kind === 'model')) invalidate('The layout changed. Prepare new sheets before downloading.');
      availability();
    }
  };
}
