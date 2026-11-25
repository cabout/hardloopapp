'use strict';

/* =====================================================
   DEFAULTS & CONSTANTS
   ===================================================== */

const DEFAULT_SCHEMA = {
  name: 'Week 1',
  warmup: 300,
  blocks: [
    { type: 'run',  duration: 60  },
    { type: 'walk', duration: 120 },
    { type: 'run',  duration: 60  },
    { type: 'walk', duration: 120 },
    { type: 'run',  duration: 60  },
    { type: 'walk', duration: 120 },
  ],
  cooldown: 300,
  announceSeconds: 10
};

const STORAGE_KEY = 'hardloop-schemas';

/* =====================================================
   APP STATE
   ===================================================== */

let schemas     = [];
let advMode     = false;

// Workout
let phases      = [];
let phaseIdx    = 0;
let phaseStart  = 0;    // Date.now() when current phase (re)started
let phaseAccum  = 0;    // seconds already elapsed before last pause
let isRunning   = false;
let isPaused    = false;
let announced10      = false;
let announceSeconds  = 0;  // copied from schema at start
let isSpeechPending  = false; // true while transition announcement plays
let speechGen        = 0;     // bumped each call to detect cancelled utterances
let wakeLock    = null;
let wakeLockVis = null;
let rafId       = null;

// GPS
let geoWatchId     = null;
let lastCoords     = null;
let distanceMeters = 0;

// Stappen (bewegingssensor)
let stepCount      = 0;
let stepSensorSeen = false; // true zodra er bewegingsdata binnenkomt
let stepTimes      = [];    // tijdstippen van recente stappen (voor cadans)
let stepState      = null;  // filterstatus van de stapdetectie

// Voice
const VOICE_KEY   = 'hardloop-voice';
const HISTORY_KEY = 'hardloop-history';
let selectedVoice = null;
let prefVoiceName = '';

/* =====================================================
   DOM REFS (assigned in init)
   ===================================================== */

let $schemaSelect, $schemaName,
    $warmupMin, $warmupSec,
    $runMin, $runSec,
    $walkMin, $walkSec,
    $reps,
    $advToggle, $simpleMode, $advMode,
    $blocksList,
    $cooldownMin, $cooldownSec,
    $annSecs, $voiceSelect,
    $totalDur,
    $btnStart,
    $phaseName, $phaseType,
    $blockTime, $runTotalTime,
    $phaseCounter, $progressFill,
    $runDistance, $runSteps,
    $btnPause, $btnStop,
    $resultTime, $resultDistance, $resultDistBlock, $resultTitle, $resultSchemaName,
    $resultSteps, $resultStepsBlock,
    $toast;

/* =====================================================
   UTILITIES
   ===================================================== */

function fmt(secs) {
  secs = Math.max(0, Math.ceil(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function totalSecs(schema) {
  return (schema.warmup || 0)
    + (schema.blocks || []).reduce((a, b) => a + (b.duration || 0), 0)
    + (schema.cooldown || 0);
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  setTimeout(() => $toast.classList.remove('show'), 2200);
}

/* =====================================================
   SPEECH
   ===================================================== */

function speak(...texts) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  texts.forEach(text => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = 'nl-NL';
    u.rate  = 0.95;
    u.pitch = 1.0;
    if (selectedVoice) u.voice = selectedVoice;
    speechSynthesis.speak(u);
  });
}

// Dutch duration for speech: "2 minuten", "1 minuut en 30 seconden", "45 seconden"
function fmtSpeech(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0 && s > 0) return `${m} ${m === 1 ? 'minuut' : 'minuten'} en ${s} seconden`;
  if (m > 0)          return `${m} ${m === 1 ? 'minuut' : 'minuten'}`;
  return `${s} seconden`;
}

// What to say when entering phase at index i
function phaseAnnouncement(i) {
  const phase = phases[i];
  const dur   = fmtSpeech(phase.duration);
  const act   = phase.type === 'run' ? 'rennen' : 'wandelen';

  if (i === 0) {
    if (phase.isWarmup)       return [`Start met de warming-up, begin met ${dur} wandelen`];
    if (phase.type === 'run') return [`Begin met ${dur} rennen`];
    return [`Begin met ${dur} wandelen`];
  }

  if (phase.isCooldown) return [`Begin met ${dur} uitlopen`];

  return [`Begin met ${dur} ${act}`];
}

// Speak transition texts, then call beginPhase() when the last utterance ends
function speakThenStart(texts) {
  isSpeechPending = true;
  updateRunDisplay(phases[phaseIdx].duration); // frozen at full phase time

  if (!window.speechSynthesis || !texts.length) { beginPhase(); return; }

  speechSynthesis.cancel();
  const gen = ++speechGen;

  texts.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = 'nl-NL';
    u.rate  = 0.95;
    u.pitch = 1.0;
    if (selectedVoice) u.voice = selectedVoice;
    if (i === texts.length - 1) {
      const done = () => { if (isRunning && gen === speechGen) beginPhase(); };
      u.onend  = done;
      u.onerror = done; // fallback if speech fails
    }
    speechSynthesis.speak(u);
  });
}

function beginPhase() {
  isSpeechPending = false;
  if (isPaused) return; // resumeWorkout() will start RAF when user resumes
  phaseStart = Date.now();
  rafId = requestAnimationFrame(tick);
}

/* =====================================================
   WAKE LOCK
   ===================================================== */

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}

  wakeLockVis = async () => {
    if (isRunning && !isPaused && document.visibilityState === 'visible') {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    }
  };
  document.addEventListener('visibilitychange', wakeLockVis);
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (wakeLockVis) {
    document.removeEventListener('visibilitychange', wakeLockVis);
    wakeLockVis = null;
  }
}

/* =====================================================
   PHASE SEQUENCE BUILDER
   ===================================================== */

function buildPhases(schema) {
  const result = [];

  if ((schema.warmup || 0) > 0) {
    result.push({
      type: 'walk', name: 'Warming-up',
      duration: schema.warmup, isWarmup: true
    });
  }

  (schema.blocks || []).forEach(b => {
    result.push({
      type: b.type,
      name: b.type === 'run' ? 'Rennen' : 'Wandelen',
      duration: b.duration
    });
  });

  if ((schema.cooldown || 0) > 0) {
    result.push({
      type: 'walk', name: 'Cooling-down',
      duration: schema.cooldown, isCooldown: true
    });
  }

  return result;
}

/* =====================================================
   TIMER LOOP
   ===================================================== */

function startWorkout() {
  const schema = readForm();

  if (totalSecs(schema) === 0) {
    alert('Schema heeft een totale duur van 0 seconden. Voeg warmup, intervallen of cooling-down toe.');
    return;
  }

  // Eerst: op iOS moet de toestemming direct binnen de klik worden gevraagd
  startStepCounting();

  phases      = buildPhases(schema);
  phaseIdx    = 0;
  phaseAccum  = 0;
  phaseStart  = Date.now();
  isRunning   = true;
  isPaused    = false;
  announced10 = false;
  announceSeconds = schema.announceSeconds ?? 0;

  showView('running');
  acquireWakeLock();
  startGeoTracking();
  speakThenStart(phaseAnnouncement(0));
}

function tick() {
  if (!isRunning || isPaused) return;

  const now     = Date.now();
  const elapsed = phaseAccum + (now - phaseStart) / 1000;
  const phase   = phases[phaseIdx];
  const rem     = phase.duration - elapsed;

  // Advance warning (configurable seconds before transition)
  if (announceSeconds > 0 && !announced10
      && phase.duration > announceSeconds + 3
      && rem <= announceSeconds && rem > 0) {
    announced10 = true;
    const activity = phase.isCooldown ? 'uitlopen'
                   : phase.type === 'run' ? 'rennen' : 'wandelen';
    speak(`Nog ${announceSeconds} seconden ${activity}`);
  }

  if (elapsed >= phase.duration) {
    nextPhase(elapsed - phase.duration);
    return;
  }

  updateRunDisplay(rem);
  rafId = requestAnimationFrame(tick);
}

function nextPhase(overshoot) {
  phaseIdx++;

  if (phaseIdx >= phases.length) {
    // Workout complete
    isRunning = false;
    releaseWakeLock();
    speak('Je training is klaar, goed gedaan!');
    showResults(true);
    return;
  }

  phaseAccum  = Math.max(0, overshoot);
  announced10 = false;
  speakThenStart(phaseAnnouncement(phaseIdx));
}

function pauseWorkout() {
  if (!isRunning || isPaused) return;
  isPaused    = true;
  if (!isSpeechPending) phaseAccum += (Date.now() - phaseStart) / 1000;
  cancelAnimationFrame(rafId);
  $btnPause.textContent = 'Hervatten';
  $btnPause.classList.add('resumed');
}

function resumeWorkout() {
  if (!isRunning || !isPaused) return;
  isPaused   = false;
  $btnPause.textContent = 'Pauze';
  $btnPause.classList.remove('resumed');
  if (!isSpeechPending) {
    phaseStart = Date.now();
    rafId = requestAnimationFrame(tick);
  }
}

function stopWorkout() {
  isRunning = false;
  isPaused  = false;
  cancelAnimationFrame(rafId);
  releaseWakeLock();
  speechSynthesis.cancel();
  showResults(false);
}

/* =====================================================
   RUNNING DISPLAY
   ===================================================== */

function updateRunDisplay(blockRem) {
  if (!phases.length || phaseIdx >= phases.length) return;
  const phase = phases[phaseIdx];

  if (blockRem === undefined) {
    blockRem = phase.duration - phaseAccum;
  }

  // Phase labels
  $phaseName.textContent = phase.name;
  $phaseType.textContent =
    phase.isCooldown ? 'Uitlopen' :
    phase.type === 'run' ? 'Rennen' : 'Wandelen';
  $phaseType.className = 'run-phase-type ' + (phase.type === 'run' ? 'run' : 'walk');

  // Block countdown
  $blockTime.textContent = fmt(blockRem);

  // Total remaining
  const doneSecs = phases.slice(0, phaseIdx).reduce((a, p) => a + p.duration, 0)
    + (phase.duration - blockRem);
  const total    = phases.reduce((a, p) => a + p.duration, 0);
  $runTotalTime.textContent = 'Totaal nog: ' + fmt(total - doneSecs);

  // Progress bar
  $progressFill.style.width = Math.min(100, (doneSecs / total) * 100).toFixed(1) + '%';

  // Phase counter (only for interval blocks, not warmup/cooldown)
  const intervalPhases = phases.filter(p => !p.isWarmup && !p.isCooldown);
  if (!phase.isWarmup && !phase.isCooldown && intervalPhases.length > 0) {
    const iNum = phases.slice(0, phaseIdx + 1).filter(p => !p.isWarmup && !p.isCooldown).length;
    $phaseCounter.textContent = `Interval ${iNum} / ${intervalPhases.length}`;
  } else {
    $phaseCounter.textContent = '';
  }

  // GPS distance
  if (distanceMeters > 20) {
    $runDistance.textContent = (distanceMeters / 1000).toFixed(2) + ' km';
  } else {
    $runDistance.textContent = '';
  }

  // Stappen + cadans
  if (stepSensorSeen) {
    const spm = currentCadence();
    $runSteps.textContent = `${stepCount} stappen` + (spm ? ` · ${spm} per min` : '');
  } else {
    $runSteps.textContent = '';
  }
}

function showResults(completed) {
  stopGeoTracking();
  stopStepCounting();

  const elapsed    = getElapsedSeconds();
  const idx        = $schemaSelect.value;
  const schemaName = idx !== '' ? (schemas[parseInt(idx)]?.name || '') : '';

  // Save to history
  saveWorkoutHistory({ completed, elapsed, schemaName });

  // Populate results view
  $resultTitle.textContent      = completed ? 'Training voltooid' : 'Training gestopt';
  document.getElementById('results-icon').textContent = completed ? '✓' : '■';
  $resultTime.textContent       = fmt(elapsed);
  $resultSchemaName.textContent = schemaName ? `Schema: ${schemaName}` : '';

  if (distanceMeters > 20) {
    $resultDistance.textContent = (distanceMeters / 1000).toFixed(2) + ' km';
    $resultDistBlock.hidden     = false;
  } else {
    $resultDistBlock.hidden     = true;
  }

  if (stepSensorSeen) {
    $resultSteps.textContent = String(stepCount);
    $resultStepsBlock.hidden = false;
  } else {
    $resultStepsBlock.hidden = true;
  }

  renderHistory();
  showView('results');
}

/* =====================================================
   VIEWS
   ===================================================== */

function showView(name) {
  document.getElementById('view-setup').hidden   = name !== 'setup';
  document.getElementById('view-running').hidden = name !== 'running';
  document.getElementById('view-results').hidden = name !== 'results';
  window.scrollTo(0, 0);

  if (name === 'running') {
    $btnPause.disabled    = false;
    $btnPause.textContent = 'Pauze';
    $btnPause.classList.remove('resumed');
    $btnStop.textContent  = 'Stop';
    $runDistance.textContent = '';
    $runSteps.textContent    = '';
  }
}

/* =====================================================
   SCHEMA FORM — READ
   ===================================================== */

function readForm() {
  const schema = {
    name:      $schemaName.value.trim() || 'Naamloos',
    warmup:    num($warmupMin)  * 60 + num($warmupSec),
    blocks:    [],
    cooldown:  num($cooldownMin) * 60 + num($cooldownSec),
    announceSeconds: num($annSecs)
  };

  if (advMode) {
    document.querySelectorAll('#blocks-list .block-item').forEach(el => {
      schema.blocks.push({
        type:     el.dataset.type,
        duration: num(el.querySelector('.blk-min')) * 60 + num(el.querySelector('.blk-sec'))
      });
    });
  } else {
    const runD  = num($runMin)  * 60 + num($runSec);
    const walkD = num($walkMin) * 60 + num($walkSec);
    const reps  = num($reps);
    for (let i = 0; i < reps; i++) {
      if (runD  > 0) schema.blocks.push({ type: 'run',  duration: runD  });
      if (walkD > 0) schema.blocks.push({ type: 'walk', duration: walkD });
    }
  }

  return schema;
}

function num(el) {
  return parseInt(el.value, 10) || 0;
}

/* =====================================================
   SCHEMA FORM — POPULATE
   ===================================================== */

function populateForm(schema) {
  $schemaName.value = schema.name || '';
  $warmupMin.value  = Math.floor((schema.warmup   || 0) / 60);
  $warmupSec.value  = (schema.warmup   || 0) % 60;
  $cooldownMin.value = Math.floor((schema.cooldown || 0) / 60);
  $cooldownSec.value = (schema.cooldown || 0) % 60;
  $annSecs.value    = schema.announceSeconds ?? 10;

  const blocks = schema.blocks || [];

  // Detect if schema is "simple" (alternating run/walk, all runs equal, all walks equal)
  const isSimple = isSimpleSchema(blocks);

  if (isSimple && !advMode) {
    setSimpleMode(blocks);
  } else {
    setAdvancedMode(blocks);
  }

  updateTotalDur();
}

function isSimpleSchema(blocks) {
  if (blocks.length === 0) return true;
  const runs  = blocks.filter(b => b.type === 'run');
  const walks = blocks.filter(b => b.type === 'walk');
  if (runs.length === 0 && walks.length === 0) return true;
  const runsEqual  = runs.every(b  => b.duration === runs[0].duration);
  const walksEqual = walks.every(b => b.duration === walks[0].duration);
  const alternates = blocks.every((b, i) => b.type === (i % 2 === 0 ? 'run' : 'walk'));
  return runsEqual && walksEqual && alternates;
}

function setSimpleMode(blocks) {
  advMode             = false;
  $advToggle.checked  = false;
  $simpleMode.hidden  = false;
  $advMode.hidden     = true;

  if (blocks.length > 0) {
    const runBlk  = blocks.find(b => b.type === 'run');
    const walkBlk = blocks.find(b => b.type === 'walk');
    $runMin.value  = runBlk  ? Math.floor(runBlk.duration  / 60) : 1;
    $runSec.value  = runBlk  ? runBlk.duration  % 60 : 0;
    $walkMin.value = walkBlk ? Math.floor(walkBlk.duration / 60) : 2;
    $walkSec.value = walkBlk ? walkBlk.duration % 60 : 0;
    // Count pairs
    const runs = blocks.filter(b => b.type === 'run').length;
    const walks = blocks.filter(b => b.type === 'walk').length;
    $reps.value  = Math.max(runs, walks);
  } else {
    $runMin.value  = 1; $runSec.value  = 0;
    $walkMin.value = 2; $walkSec.value = 0;
    $reps.value    = 6;
  }
}

function setAdvancedMode(blocks) {
  advMode            = true;
  $advToggle.checked = true;
  $simpleMode.hidden = true;
  $advMode.hidden    = false;
  renderBlocks(blocks);
}

function renderBlocks(blocks) {
  $blocksList.innerHTML = '';
  blocks.forEach(b => appendBlock(b.type, b.duration));
}

function appendBlock(type, duration) {
  const mins = Math.floor((duration || 60) / 60);
  const secs = (duration || 60) % 60;

  const el = document.createElement('div');
  el.className  = `block-item ${type}`;
  el.dataset.type = type;
  el.innerHTML  = `
    <span class="block-type-label">${type === 'run' ? 'Rennen' : 'Wandelen'}</span>
    <div class="block-time-row">
      <input type="number" class="blk-min" value="${mins}" min="0" max="99" inputmode="numeric" aria-label="minuten">
      <span class="time-sep-small">:</span>
      <input type="number" class="blk-sec" value="${secs}" min="0" max="59" inputmode="numeric" aria-label="seconden">
    </div>
    <button class="btn-block-remove" aria-label="Verwijder blok">✕</button>
  `;
  el.querySelector('.btn-block-remove').addEventListener('click', () => {
    el.remove();
    updateTotalDur();
  });
  el.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateTotalDur));
  $blocksList.appendChild(el);
  updateTotalDur();
}

/* =====================================================
   TOTAL DURATION DISPLAY
   ===================================================== */

function updateTotalDur() {
  const schema = readForm();
  const total  = totalSecs(schema);
  $totalDur.textContent = total > 0 ? `Totale duur: ${fmt(total)}` : '';
}

/* =====================================================
   SCHEMA STORAGE
   ===================================================== */

function loadSchemas() {
  try {
    schemas = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (_) {
    schemas = [];
  }
  if (schemas.length === 0) {
    schemas = [JSON.parse(JSON.stringify(DEFAULT_SCHEMA))];
    persistSchemas();
  }
  rebuildSelect();
}

function persistSchemas() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(schemas));
}

function rebuildSelect() {
  const prev = $schemaSelect.value;
  $schemaSelect.innerHTML = '<option value="">— Nieuw schema —</option>';
  schemas.forEach((s, i) => {
    const o = document.createElement('option');
    o.value       = String(i);
    o.textContent = s.name || `Schema ${i + 1}`;
    $schemaSelect.appendChild(o);
  });
  $schemaSelect.value = (prev !== '' && parseInt(prev) < schemas.length) ? prev : '0';
}

function saveSchema() {
  const schema = readForm();
  const idx    = $schemaSelect.value;

  if (idx === '' || idx === undefined) {
    schemas.push(schema);
    persistSchemas();
    rebuildSelect();
    $schemaSelect.value = String(schemas.length - 1);
  } else {
    schemas[parseInt(idx)] = schema;
    persistSchemas();
    rebuildSelect();
    $schemaSelect.value = idx;
  }
  toast('Schema opgeslagen!');
}

function deleteSchema() {
  const idx = parseInt($schemaSelect.value);
  if (isNaN(idx)) { toast('Selecteer een schema om te verwijderen.'); return; }
  if (!confirm(`Schema "${schemas[idx].name}" verwijderen?`)) return;

  schemas.splice(idx, 1);
  if (schemas.length === 0) schemas = [JSON.parse(JSON.stringify(DEFAULT_SCHEMA))];
  persistSchemas();
  rebuildSelect();
  $schemaSelect.value = '0';
  populateForm(schemas[0]);
}

/* =====================================================
   EVENT LISTENERS
   ===================================================== */

function bindEvents() {

  // Schema select change
  $schemaSelect.addEventListener('change', () => {
    const idx = $schemaSelect.value;
    populateForm(idx === '' ? JSON.parse(JSON.stringify(DEFAULT_SCHEMA)) : schemas[parseInt(idx)]);
  });

  document.getElementById('btn-save').addEventListener('click', saveSchema);
  document.getElementById('btn-delete').addEventListener('click', deleteSchema);

  // Advanced toggle
  $advToggle.addEventListener('change', () => {
    if ($advToggle.checked) {
      // Simple → Advanced: read simple inputs first, THEN switch mode
      const schema = readForm(); // advMode is still false here
      advMode = true;
      $simpleMode.hidden = true;
      $advMode.hidden    = false;
      renderBlocks(schema.blocks);
    } else {
      // Advanced → Simple
      advMode = false;
      $simpleMode.hidden = false;
      $advMode.hidden    = true;
    }
    updateTotalDur();
  });

  // Add blocks (advanced)
  document.getElementById('btn-add-run').addEventListener('click',  () => appendBlock('run',  60));
  document.getElementById('btn-add-walk').addEventListener('click', () => appendBlock('walk', 120));

  // Live total duration update on simple inputs
  [$warmupMin,$warmupSec,$runMin,$runSec,$walkMin,$walkSec,$reps,$cooldownMin,$cooldownSec]
    .forEach(el => el.addEventListener('input', updateTotalDur));

  // Start workout
  $btnStart.addEventListener('click', startWorkout);

  // Pause / Resume
  $btnPause.addEventListener('click', () => {
    if (!isRunning) return;
    if (isPaused) resumeWorkout(); else pauseWorkout();
  });

  // Stop
  $btnStop.addEventListener('click', () => {
    if (!isRunning) return;
    if (confirm('Training stoppen?')) stopWorkout();
  });

  // Results → terug
  document.getElementById('btn-results-back').addEventListener('click', () => showView('setup'));

  // Voice selector
  $voiceSelect.addEventListener('change', () => {
    prefVoiceName = $voiceSelect.value;
    localStorage.setItem(VOICE_KEY, prefVoiceName);
    const v = speechSynthesis.getVoices().find(v => v.name === prefVoiceName);
    selectedVoice = v || null;
    speak('Dit is de geselecteerde stem');
  });

}

/* =====================================================
   INIT
   ===================================================== */

function init() {
  // Assign DOM refs
  $schemaSelect = document.getElementById('schema-select');
  $schemaName   = document.getElementById('schema-name');
  $warmupMin    = document.getElementById('warmup-min');
  $warmupSec    = document.getElementById('warmup-sec');
  $runMin       = document.getElementById('run-min');
  $runSec       = document.getElementById('run-sec');
  $walkMin      = document.getElementById('walk-min');
  $walkSec      = document.getElementById('walk-sec');
  $reps         = document.getElementById('repetitions');
  $advToggle    = document.getElementById('advanced-toggle');
  $simpleMode   = document.getElementById('simple-mode');
  $advMode      = document.getElementById('advanced-mode');
  $blocksList   = document.getElementById('blocks-list');
  $cooldownMin  = document.getElementById('cooldown-min');
  $cooldownSec  = document.getElementById('cooldown-sec');
  $annSecs           = document.getElementById('announce-secs');
  $voiceSelect       = document.getElementById('voice-select');
  $totalDur          = document.getElementById('total-duration');
  $btnStart          = document.getElementById('btn-start');
  $phaseName         = document.getElementById('phase-name');
  $phaseType         = document.getElementById('phase-type');
  $blockTime         = document.getElementById('block-time');
  $runTotalTime      = document.getElementById('run-total-time');
  $phaseCounter      = document.getElementById('phase-counter');
  $progressFill      = document.getElementById('progress-fill');
  $runDistance       = document.getElementById('run-distance');
  $runSteps          = document.getElementById('run-steps');
  $resultSteps       = document.getElementById('result-steps');
  $resultStepsBlock  = document.getElementById('result-steps-block');
  $btnPause          = document.getElementById('btn-pause');
  $btnStop           = document.getElementById('btn-stop');
  $resultTime        = document.getElementById('result-time');
  $resultDistance    = document.getElementById('result-distance');
  $resultDistBlock   = document.getElementById('result-dist-block');
  $resultTitle       = document.getElementById('results-title');
  $resultSchemaName  = document.getElementById('result-schema-name');
  $toast             = document.getElementById('toast');

  loadSchemas();
  if (schemas.length > 0) {
    $schemaSelect.value = '0';
    populateForm(schemas[0]);
  }

  prefVoiceName = localStorage.getItem(VOICE_KEY) || '';

  // Register BEFORE first call to avoid missing the voiceschanged event
  if (window.speechSynthesis) {
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
    // Fallback: Chrome sometimes fires voiceschanged before addEventListener is called
    setTimeout(loadVoices, 100);
  }
  loadVoices();
  renderHistory();

  bindEvents();
  showView('setup');
}

document.addEventListener('DOMContentLoaded', init);

/* =====================================================
   SERVICE WORKER REGISTRATION
   ===================================================== */

/* =====================================================
   GPS AFSTANDSMETING
   ===================================================== */

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371000; // meters
  const toR  = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function startGeoTracking() {
  if (!navigator.geolocation) return;
  distanceMeters = 0;
  lastCoords     = null;

  geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      if (lastCoords && isRunning && !isPaused) {
        const d = haversine(
          lastCoords.lat, lastCoords.lon,
          pos.coords.latitude, pos.coords.longitude
        );
        if (d < 50) distanceMeters += d; // filter GPS-sprongen
      }
      lastCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    },
    err => console.warn('GPS:', err.message),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function stopGeoTracking() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

/* =====================================================
   STAPPENTELLER (bewegingssensor)
   ===================================================== */

const STEP_THRESHOLD = 1.5;  // m/s² boven het gemiddelde om als stap te tellen
const STEP_MIN_GAP   = 250;  // ms; max. 240 stappen per minuut

function startStepCounting() {
  stepCount      = 0;
  stepSensorSeen = false;
  stepTimes      = [];
  stepState      = { smooth: null, base: null, armed: false, last: 0 };

  if (typeof DeviceMotionEvent === 'undefined') return;

  // iOS 13+: toestemming nodig, moet binnen een klik worden gevraagd
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then(state => {
        if (state === 'granted') window.addEventListener('devicemotion', onDeviceMotion);
        else toast('Geen toegang tot bewegingssensor: stappen worden niet geteld.');
      })
      .catch(() => {});
  } else {
    window.addEventListener('devicemotion', onDeviceMotion);
  }
}

function stopStepCounting() {
  window.removeEventListener('devicemotion', onDeviceMotion);
}

function onDeviceMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  stepSensorSeen = true;
  if (!isRunning || isPaused) return;

  const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const s   = stepState;
  if (s.smooth === null) { s.smooth = mag; s.base = mag; return; }

  s.smooth += 0.3  * (mag - s.smooth);    // ruis eruit
  s.base   += 0.02 * (mag - s.base);      // langzaam gemiddelde (zwaartekracht)
  const diff = s.smooth - s.base;

  if (diff < 0) {
    s.armed = true;                       // eerst onder het gemiddelde geweest
  } else if (s.armed && diff > STEP_THRESHOLD) {
    const now = performance.now();
    if (now - s.last >= STEP_MIN_GAP) {
      stepCount++;
      s.last = now;
      stepTimes.push(now);
      if (stepTimes.length > 30) stepTimes.shift();
    }
    s.armed = false;
  }
}

// Stappen per minuut over de laatste ~15 seconden
function currentCadence() {
  const now    = performance.now();
  const recent = stepTimes.filter(t => now - t < 15000);
  if (recent.length < 5 || now - recent[recent.length - 1] > 3000) return 0;
  const span = recent[recent.length - 1] - recent[0];
  return span > 0 ? Math.round((recent.length - 1) / span * 60000) : 0;
}

/* =====================================================
   VERSTREKEN TIJD
   ===================================================== */

function getElapsedSeconds() {
  if (!phases.length) return 0;
  const done    = phases.slice(0, phaseIdx).reduce((a, p) => a + p.duration, 0);
  const current = isPaused ? phaseAccum : phaseAccum + (Date.now() - phaseStart) / 1000;
  return done + current;
}

/* =====================================================
   GESCHIEDENIS
   ===================================================== */

function saveWorkoutHistory({ completed, elapsed, schemaName }) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) {}

  history.unshift({
    date:            new Date().toISOString(),
    schemaName:      schemaName || '',
    durationSeconds: Math.round(elapsed),
    distanceMeters:  distanceMeters > 20 ? Math.round(distanceMeters) : null,
    steps:           stepSensorSeen ? stepCount : null,
    completed
  });

  if (history.length > 50) history.length = 50;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function renderHistory() {
  const $list = document.getElementById('history-list');
  if (!$list) return;

  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) {}

  if (history.length === 0) {
    $list.innerHTML = '<p class="history-empty">Nog geen trainingen opgeslagen.</p>';
    return;
  }

  $list.innerHTML = history.slice(0, 15).map(e => {
    const d       = new Date(e.date);
    const dateStr = d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const dur     = fmt(e.durationSeconds);
    const dist    = e.distanceMeters
      ? `<span class="history-dist">${(e.distanceMeters / 1000).toFixed(2)} km</span>`
      : '';
    const steps   = e.steps ? ` · ${e.steps} stappen` : '';
    const icon    = e.completed ? '✓' : '■';

    return `<div class="history-item">
      <div class="history-date">${dateStr} · ${timeStr}</div>
      <div class="history-info">
        <span class="history-schema">${e.schemaName || 'Naamloos'}</span>
        <span class="history-stats">${icon} ${dur}${dist ? ' · ' + dist : ''}${steps}</span>
      </div>
    </div>`;
  }).join('');
}

/* =====================================================
   STEMKEUZE
   ===================================================== */

function loadVoices() {
  if (!$voiceSelect) return;

  const voices   = speechSynthesis.getVoices();
  const nlVoices = voices.filter(v => v.lang.startsWith('nl'));

  // Not loaded yet — show placeholder and wait for voiceschanged
  if (voices.length === 0) {
    if (!$voiceSelect.options.length) {
      $voiceSelect.innerHTML = '<option value="">Laden…</option>';
    }
    return;
  }

  // Dutch voices first, then the rest
  const sorted = [
    ...nlVoices,
    ...voices.filter(v => !v.lang.startsWith('nl'))
  ];

  $voiceSelect.innerHTML = '';
  sorted.forEach(v => {
    const o = document.createElement('option');
    o.value       = v.name;
    o.textContent = nlVoices.includes(v)
      ? `${v.name} (${v.lang}) — NL`
      : `${v.name} (${v.lang})`;
    $voiceSelect.appendChild(o);
  });

  // Apply saved preference, auto-select first Dutch voice, or first available
  const saved   = voices.find(v => v.name === prefVoiceName);
  const pick    = saved || nlVoices[0] || voices[0];
  if (pick) {
    selectedVoice        = pick;
    prefVoiceName        = pick.name;
    $voiceSelect.value   = pick.name;
  }
}

/* ===================================================== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}
