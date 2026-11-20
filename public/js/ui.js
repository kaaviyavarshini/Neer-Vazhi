/**
 * web/js/ui.js
 * Owns the stepper bar, dots, legend, info-panel.
 * Exports: uiInit(cfg), uiSetScene(idx, label), uiSetStats({rain,particles,depth})
 */

const SCENES = [
  { label: '① Google 3D Map — Study Area',           legend: null },
  { label: '② Elevation slab (10× exaggerated)',      legend: { title:'Elevation', low:'Low (marsh)', high:'High (ridge)' } },
  { label: '③ Rain falling & rolling downhill',       legend: null },
  { label: '④ Water pooling in depressions',          legend: { title:'Flood depth', low:'Shallow', high:'Deep' } },
  { label: '⑤ Flood depth draped on 3D city',         legend: { title:'Flood depth (m)', low:'0 m', high:'≥ 1.5 m' } },
];

let _total   = SCENES.length;
let _current = 0;
let _playing = false;
let _playTimer = null;

export function uiInit(cfg) {
  // Build dots
  const dotsEl = document.getElementById('scene-dots');
  SCENES.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'dot' + (i === 0 ? ' active' : '');
    d.dataset.i = i;
    dotsEl.appendChild(d);
  });

  // Wire buttons
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (_current > 0) emitScene(_current - 1);
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if (_current < _total - 1) emitScene(_current + 1);
  });
  document.getElementById('btn-play').addEventListener('click', togglePlay);

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') emitScene(Math.min(_current + 1, _total - 1));
    if (e.key === 'ArrowLeft')  emitScene(Math.max(_current - 1, 0));
    if (e.key === ' ')          togglePlay();
  });

  uiSetScene(0);
}

function emitScene(idx) {
  _current = idx;
  window.__sceneManager?.goTo(idx);
  uiSetScene(idx);
}

export function uiSetScene(idx) {
  _current = idx;
  const s = SCENES[idx];

  // Label
  document.getElementById('step-label').textContent = s.label;

  // Info panel scene counter
  document.getElementById('ip-scene').textContent = `${idx + 1} / ${_total}`;

  // Dots
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });

  // Prev/next buttons
  document.getElementById('btn-prev').disabled = idx === 0;
  document.getElementById('btn-next').disabled = idx === _total - 1;

  // Legend
  const leg = document.getElementById('legend');
  if (s.legend) {
    document.getElementById('legend-title').textContent = s.legend.title;
    document.getElementById('leg-low').textContent      = s.legend.low;
    document.getElementById('leg-high').textContent     = s.legend.high;
    leg.classList.add('visible');
  } else {
    leg.classList.remove('visible');
  }
}

export function uiSetStats({ rain = '—', particles = '—', depth = '—' } = {}) {
  document.getElementById('ip-rain').textContent      = rain;
  document.getElementById('ip-particles').textContent = particles;
  document.getElementById('ip-depth').textContent     = depth;
}

function togglePlay() {
  _playing = !_playing;
  document.getElementById('btn-play').textContent = _playing ? '⏸' : '▶️';
  if (_playing) advancePlay();
  else { clearTimeout(_playTimer); }
}

function advancePlay() {
  if (!_playing) return;
  const next = _current + 1;
  if (next >= _total) {
    _playing = false;
    document.getElementById('btn-play').textContent = '▶️';
    return;
  }
  emitScene(next);
  _playTimer = setTimeout(advancePlay, 7000);
}
