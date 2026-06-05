/* ============================================
   CuffnCode — Blood Pressure Analysis Engine
   ============================================
   
   Oscillometric Method Implementation:
   1. Cuff pressure is recorded during controlled deflation
   2. High-pass filter extracts oscillation component
   3. Envelope of oscillations (MAO) is computed
   4. MAP = pressure at maximum oscillation amplitude
   5. SYS = pressure on ascending side where amplitude = SYS_RATIO × MAO
   6. DIA = pressure on descending side where amplitude = DIA_RATIO × MAO
   7. Heart rate = derived from oscillation peak intervals
*/

// ============ State ============
const state = {
  rawData: null,           // { time: [], pressure: [] }
  filteredOsc: null,       // oscillation component
  envelope: null,          // oscillation envelope
  envelopePressures: null, // corresponding cuff pressures for envelope
  results: null,           // { sys, dia, map, bpm, classification }
  measurements: [],        // history log
  zoomLevel: 1,
  panOffset: 0,
  inputMode: 'demo',      // 'demo' | 'csv' | 'manual'
  isAnalyzing: false,

  // Algorithm parameters
  params: {
    sysRatio: 0.55,
    diaRatio: 0.85,
    hpCutoff: 0.5,
    sampleRate: 500,
  }
};

// ============ DOM References ============
const dom = {};

function cacheDom() {
  // Tabs
  dom.tabs = document.querySelectorAll('.nav-tab');
  dom.tabContents = document.querySelectorAll('.tab-content');

  // Input
  dom.btnDemo = document.getElementById('btn-demo-data');
  dom.btnUpload = document.getElementById('btn-upload-csv');
  dom.btnManual = document.getElementById('btn-manual-input');
  dom.csvInput = document.getElementById('csv-file-input');
  dom.manualForm = document.getElementById('manual-entry-form');
  dom.btnApplyManual = document.getElementById('btn-apply-manual');
  dom.manualSys = document.getElementById('manual-sys');
  dom.manualDia = document.getElementById('manual-dia');
  dom.manualBpm = document.getElementById('manual-bpm');
  dom.btnRun = document.getElementById('btn-run-analysis');

  // Progress
  dom.progressContainer = document.getElementById('progress-container');
  dom.progressFill = document.getElementById('progress-fill');
  dom.progressText = document.getElementById('progress-text');

  // Vitals
  dom.valSys = document.getElementById('val-systolic');
  dom.valDia = document.getElementById('val-diastolic');
  dom.valMap = document.getElementById('val-map');
  dom.valBpm = document.getElementById('val-bpm');

  // Canvases
  dom.waveformCanvas = document.getElementById('waveform-canvas');
  dom.envelopeCanvas = document.getElementById('envelope-canvas');
  dom.rawSignalCanvas = document.getElementById('raw-signal-canvas');
  dom.filteredSignalCanvas = document.getElementById('filtered-signal-canvas');
  dom.envelopeDetailCanvas = document.getElementById('envelope-detail-canvas');

  // Overlays
  dom.canvasOverlay = document.getElementById('canvas-overlay');
  dom.envelopeOverlay = document.getElementById('envelope-overlay');
  dom.rawSignalOverlay = document.getElementById('raw-signal-overlay');
  dom.filteredSignalOverlay = document.getElementById('filtered-signal-overlay');
  dom.envelopeDetailOverlay = document.getElementById('envelope-detail-overlay');

  // Classification
  dom.gaugePointer = document.getElementById('gauge-pointer');
  dom.classificationResult = document.getElementById('classification-result');

  // Status
  dom.statusDot = document.querySelector('.status-dot');
  dom.statusText = document.querySelector('.status-text');

  // Log
  dom.logTbody = document.getElementById('log-tbody');
  dom.btnClearLog = document.getElementById('btn-clear-log');

  // Zoom
  dom.btnZoomIn = document.getElementById('btn-zoom-in');
  dom.btnZoomOut = document.getElementById('btn-zoom-out');
  dom.btnResetZoom = document.getElementById('btn-reset-zoom');

  // Params
  dom.paramSysRatio = document.getElementById('param-sys-ratio');
  dom.paramDiaRatio = document.getElementById('param-dia-ratio');
  dom.paramHpCutoff = document.getElementById('param-hp-cutoff');
  dom.paramSampleRate = document.getElementById('param-sample-rate');
  dom.paramSysRatioVal = document.getElementById('param-sys-ratio-val');
  dom.paramDiaRatioVal = document.getElementById('param-dia-ratio-val');
  dom.paramHpCutoffVal = document.getElementById('param-hp-cutoff-val');
  dom.paramSampleRateVal = document.getElementById('param-sample-rate-val');
  dom.btnReanalyze = document.getElementById('btn-reanalyze');
}


// ============ Signal Generation (Demo Data) ============
function generateDemoData() {
  const fs = state.params.sampleRate;
  const duration = 30;   // seconds — full inflation + deflation cycle
  const N = fs * duration;
  const time = [];
  const pressure = [];

  // Simulate oscillometric measurement cycle:
  // Phase 1: Inflate (0–6s) from 0 to ~180 mmHg
  // Phase 2: Deflate (6–28s) linearly from 180 to ~40 mmHg
  // Phase 3: Rapid release (28–30s) to 0

  const inflateEnd = 6;
  const deflateEnd = 28;
  const maxPressure = 180;
  const minPressure = 40;

  // Ground truth BP
  const trueSys = 122;
  const trueDia = 78;
  const trueMap = trueDia + (trueSys - trueDia) / 3;
  const heartRate = 72; // BPM
  const heartPeriod = 60 / heartRate;

  for (let i = 0; i < N; i++) {
    const t = i / fs;
    time.push(t);

    let cuffPressure;
    if (t < inflateEnd) {
      // Inflate: smooth ramp up
      const frac = t / inflateEnd;
      cuffPressure = maxPressure * (3 * frac * frac - 2 * frac * frac * frac); // smoothstep
    } else if (t < deflateEnd) {
      // Deflate: linear
      const frac = (t - inflateEnd) / (deflateEnd - inflateEnd);
      cuffPressure = maxPressure - (maxPressure - minPressure) * frac;
    } else {
      // Rapid release
      const frac = (t - deflateEnd) / (duration - deflateEnd);
      cuffPressure = minPressure * (1 - frac * frac);
    }

    // Add oscillation component (mimics arterial pulsation)
    // Real oscillometric oscillations are typically 1-5 mmHg peak-to-peak
    // Amplitude follows a Gaussian envelope centered on MAP
    let oscAmplitude = 0;
    if (t >= inflateEnd && t < deflateEnd) {
      const sigma = 20; // width of the envelope in mmHg
      const diff = cuffPressure - trueMap;

      // Asymmetric Gaussian: wider on systolic side (higher pressure)
      const effectiveSigma = cuffPressure > trueMap ? sigma * 1.3 : sigma;
      oscAmplitude = 4.0 * Math.exp(-(diff * diff) / (2 * effectiveSigma * effectiveSigma));
    }

    // Heart beat oscillation — sharper pulse-like waveform
    const heartPhase = ((2 * Math.PI * t) / heartPeriod) % (2 * Math.PI);
    // Create a more pulse-like waveform (sharp systolic peak)
    const beat = Math.sin(heartPhase) * 0.55 
              + Math.sin(2 * heartPhase) * 0.3
              + Math.sin(3 * heartPhase) * 0.15;
    const oscillation = oscAmplitude * beat;

    // Small noise (much less than oscillation amplitude)
    const noise = (Math.random() - 0.5) * 0.08;

    pressure.push(cuffPressure + oscillation + noise);
  }

  return { time, pressure };
}


// ============ Signal Processing ============

/**
 * High-pass filter (cascaded 2nd order IIR) to extract oscillation from cuff pressure.
 * Two passes of 1st-order HP filter for better slope rejection.
 * y[n] = alpha * (y[n-1] + x[n] - x[n-1])
 */
function highPassFilter(signal, cutoffHz, sampleRate) {
  const dt = 1 / sampleRate;
  const RC = 1 / (2 * Math.PI * cutoffHz);
  const alpha = RC / (RC + dt);

  // First pass
  const pass1 = new Float64Array(signal.length);
  pass1[0] = 0;
  for (let i = 1; i < signal.length; i++) {
    pass1[i] = alpha * (pass1[i - 1] + signal[i] - signal[i - 1]);
  }

  // Second pass for sharper rolloff (2nd order)
  const pass2 = new Float64Array(signal.length);
  pass2[0] = 0;
  for (let i = 1; i < signal.length; i++) {
    pass2[i] = alpha * (pass2[i - 1] + pass1[i] - pass1[i - 1]);
  }

  return pass2;
}

/**
 * Simple low-pass filter for smoothing envelope
 */
function lowPassFilter(signal, cutoffHz, sampleRate) {
  const dt = 1 / sampleRate;
  const RC = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (RC + dt);
  const filtered = new Float64Array(signal.length);
  filtered[0] = signal[0];
  for (let i = 1; i < signal.length; i++) {
    filtered[i] = filtered[i - 1] + alpha * (signal[i] - filtered[i - 1]);
  }
  return filtered;
}

/**
 * Compute envelope using peak detection + interpolation.
 * Only analyzes the DEFLATION phase to avoid high-pass filter transients
 * from the inflation ramp.
 */
function computeEnvelope(oscillations, cuffPressures, timeArr, sampleRate) {
  // Detect deflation phase: find the time of max cuff pressure
  let maxPressIdx = 0;
  let maxPress = 0;
  for (let i = 0; i < cuffPressures.length; i++) {
    if (cuffPressures[i] > maxPress) {
      maxPress = cuffPressures[i];
      maxPressIdx = i;
    }
  }

  // Skip a settling period after the inflation peak (1 second)
  // to let the HP filter transient die out
  const settleOffset = Math.floor(sampleRate * 1.0);
  const deflateStart = maxPressIdx + settleOffset;

  // End of deflation: where pressure drops below a threshold or rapid release begins
  // Detect rapid release as a sudden large pressure drop
  let deflateEnd = oscillations.length - Math.floor(sampleRate * 0.5);
  for (let i = deflateStart + Math.floor(sampleRate); i < oscillations.length - 1; i++) {
    const dpdt = (cuffPressures[i + 1] - cuffPressures[i]) * sampleRate;
    // If deflation rate suddenly exceeds -30 mmHg/s, it's rapid release
    if (dpdt < -30) {
      deflateEnd = i;
      break;
    }
  }

  // Find POSITIVE peaks only (local maxima, not absolute value)
  // This gives one peak per heartbeat and avoids doubling BPM
  const peaks = [];
  const minDist = Math.floor(sampleRate * 0.35); // minimum 0.35s between peaks (~170 BPM max)

  // Find the max oscillation amplitude to set adaptive threshold
  let maxOscAmp = 0;
  for (let i = deflateStart; i < deflateEnd; i++) {
    if (oscillations[i] > maxOscAmp) maxOscAmp = oscillations[i];
  }
  const ampThreshold = maxOscAmp * 0.02; // 2% of max amplitude

  console.log(`[CuffnCode] Deflation range: idx ${deflateStart}-${deflateEnd}, max osc amplitude: ${maxOscAmp.toFixed(4)}, threshold: ${ampThreshold.toFixed(4)}`);

  for (let i = deflateStart + 2; i < deflateEnd - 2; i++) {
    if (oscillations[i] > oscillations[i - 1] && oscillations[i] > oscillations[i + 1] &&
        oscillations[i] > oscillations[i - 2] && oscillations[i] > oscillations[i + 2] &&
        oscillations[i] > 0) {
      // Check minimum distance from last peak
      if (peaks.length === 0 || (i - peaks[peaks.length - 1].index) >= minDist) {
        if (oscillations[i] > ampThreshold) {
          peaks.push({
            index: i,
            time: timeArr[i],
            amplitude: oscillations[i],
            pressure: cuffPressures[i]
          });
        }
      }
    }
  }

  console.log(`[CuffnCode] Found ${peaks.length} peaks in deflation phase`);
  return peaks;
}

/**
 * Core oscillometric algorithm:
 * - Find the Maximum Amplitude Oscillation (MAO) → MAP
 * - SYS = pressure where ascending envelope crosses SYS_RATIO × MAO
 * - DIA = pressure where descending envelope crosses DIA_RATIO × MAO
 *
 * During deflation, peaks are ordered chronologically:
 *   - Early peaks (indices 0..maxIdx) have HIGH cuff pressure → ascending side → SYS
 *   - Late peaks (indices maxIdx..end) have LOW cuff pressure → descending side → DIA
 *
 * SYS is found on the ascending side (high pressure) where amplitude first rises
 * above sysThreshold. We scan from the start toward maxIdx.
 * DIA is found on the descending side (low pressure) where amplitude last stays
 * above diaThreshold. We scan from the end toward maxIdx.
 */
function oscillometricAnalysis(peaks, sysRatio, diaRatio) {
  if (peaks.length < 5) {
    return null;
  }

  // Find MAO (Maximum Amplitude Oscillation)
  let maxIdx = 0;
  let maxAmp = 0;
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i].amplitude > maxAmp) {
      maxAmp = peaks[i].amplitude;
      maxIdx = i;
    }
  }

  const MAP = peaks[maxIdx].pressure;
  const sysThreshold = sysRatio * maxAmp;
  const diaThreshold = diaRatio * maxAmp;

  // SYS: ascending side — scan from start toward MAO peak.
  // During deflation, early peaks = high cuff pressure.
  // The first peak whose amplitude crosses sysThreshold marks the systolic region.
  let SYS = peaks[0].pressure; // fallback to highest pressure
  for (let i = 0; i < maxIdx; i++) {
    if (peaks[i].amplitude >= sysThreshold) {
      // Interpolate between this and previous peak for more accuracy
      if (i > 0 && peaks[i - 1].amplitude < sysThreshold) {
        const frac = (sysThreshold - peaks[i - 1].amplitude) / (peaks[i].amplitude - peaks[i - 1].amplitude);
        SYS = peaks[i - 1].pressure + frac * (peaks[i].pressure - peaks[i - 1].pressure);
      } else {
        SYS = peaks[i].pressure;
      }
      break;
    }
  }

  // DIA: descending side — scan from end toward MAO peak.
  // Late peaks = low cuff pressure.
  // The last peak whose amplitude is still above diaThreshold marks the diastolic region.
  let DIA = peaks[peaks.length - 1].pressure; // fallback to lowest pressure
  for (let i = peaks.length - 1; i > maxIdx; i--) {
    if (peaks[i].amplitude >= diaThreshold) {
      // Interpolate between this and the next (lower pressure) peak
      if (i < peaks.length - 1 && peaks[i + 1].amplitude < diaThreshold) {
        const frac = (diaThreshold - peaks[i + 1].amplitude) / (peaks[i].amplitude - peaks[i + 1].amplitude);
        DIA = peaks[i + 1].pressure + frac * (peaks[i].pressure - peaks[i + 1].pressure);
      } else {
        DIA = peaks[i].pressure;
      }
      break;
    }
  }

  // Sanity check: SYS must be > DIA
  if (SYS <= DIA) {
    // If somehow inverted, use MAP-based estimation
    SYS = MAP + (MAP - DIA);
  }
  if (DIA >= MAP) {
    DIA = MAP - (SYS - MAP) * 0.5;
  }

  // Heart rate from peak intervals (using only deflation-phase peaks)
  let totalInterval = 0;
  let intervalCount = 0;
  for (let i = 1; i < peaks.length; i++) {
    const dt = peaks[i].time - peaks[i - 1].time;
    if (dt > 0.4 && dt < 2.0) { // valid range: 30-150 BPM
      totalInterval += dt;
      intervalCount++;
    }
  }
  const avgInterval = intervalCount > 0 ? totalInterval / intervalCount : 0.833;
  const BPM = Math.round(60 / avgInterval);

  return {
    sys: Math.round(SYS),
    dia: Math.round(DIA),
    map: Math.round(MAP),
    bpm: BPM,
  };
}


// ============ BP Classification (AHA/ACC 2017) ============
function classifyBP(sys, dia) {
  if (sys < 120 && dia < 80) return { label: 'Optimal', class: 'optimal', gaugePos: 0.08 };
  if (sys < 130 && dia < 80) return { label: 'Normal', class: 'normal', gaugePos: 0.25 };
  if ((sys >= 130 && sys <= 139) || (dia >= 80 && dia <= 89)) return { label: 'Elevated', class: 'elevated', gaugePos: 0.42 };
  if ((sys >= 140 && sys <= 159) || (dia >= 90 && dia <= 99)) return { label: 'Stage 1 Hypertension', class: 'stage1', gaugePos: 0.58 };
  if ((sys >= 160 && sys <= 179) || (dia >= 100 && dia <= 109)) return { label: 'Stage 2 Hypertension', class: 'stage2', gaugePos: 0.75 };
  return { label: 'Hypertensive Crisis', class: 'crisis', gaugePos: 0.92 };
}


// ============ Canvas Rendering ============

function setupCanvas(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, width: rect.width, height: rect.height };
}

function drawGrid(ctx, width, height, xLabels, yLabels, xTitle, yTitle) {
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;

  const pad = { top: 20, right: 20, bottom: 36, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Horizontal grid lines
  const ySteps = yLabels ? yLabels.length : 5;
  for (let i = 0; i <= ySteps; i++) {
    const y = pad.top + (plotH / ySteps) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  // Vertical grid lines
  const xSteps = xLabels ? xLabels.length : 6;
  for (let i = 0; i <= xSteps; i++) {
    const x = pad.left + (plotW / xSteps) * i;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
  }

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, height - pad.bottom);
  ctx.lineTo(width - pad.right, height - pad.bottom);
  ctx.stroke();

  // Y labels
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  if (yLabels) {
    for (let i = 0; i < yLabels.length; i++) {
      const y = pad.top + (plotH / (yLabels.length - 1)) * i;
      ctx.fillText(yLabels[i], pad.left - 6, y);
    }
  }

  // X labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (xLabels) {
    for (let i = 0; i < xLabels.length; i++) {
      const x = pad.left + (plotW / (xLabels.length - 1)) * i;
      ctx.fillText(xLabels[i], x, height - pad.bottom + 6);
    }
  }

  // Axis titles
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '10px Inter, sans-serif';
  if (xTitle) {
    ctx.textAlign = 'center';
    ctx.fillText(xTitle, pad.left + plotW / 2, height - 4);
  }
  if (yTitle) {
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(yTitle, 0, 0);
    ctx.restore();
  }

  return pad;
}

function plotLine(ctx, data, pad, width, height, xRange, yRange, color, lineWidth = 1.5) {
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';

  let started = false;
  for (let i = 0; i < data.x.length; i++) {
    const px = pad.left + ((data.x[i] - xRange[0]) / (xRange[1] - xRange[0])) * plotW;
    const py = pad.top + ((yRange[1] - data.y[i]) / (yRange[1] - yRange[0])) * plotH;

    if (px < pad.left || px > width - pad.right) continue;

    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

function drawVerticalLine(ctx, x, pad, width, height, xRange, yRange, color, label) {
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const px = pad.left + ((x - xRange[0]) / (xRange[1] - xRange[0])) * plotW;

  if (px < pad.left || px > width - pad.right) return;

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, pad.top);
  ctx.lineTo(px, height - pad.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  if (label) {
    ctx.fillStyle = color;
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, px, pad.top - 6);
  }
}

function drawHorizontalLine(ctx, y, pad, width, height, xRange, yRange, color, label) {
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const py = pad.top + ((yRange[1] - y) / (yRange[1] - yRange[0])) * plotH;

  if (py < pad.top || py > height - pad.bottom) return;

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, py);
  ctx.lineTo(width - pad.right, py);
  ctx.stroke();
  ctx.setLineDash([]);

  if (label) {
    ctx.fillStyle = color;
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, width - pad.right + 4, py + 3);
  }
}

function drawDots(ctx, points, pad, width, height, xRange, yRange, color, radius = 3) {
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.fillStyle = color;
  for (const pt of points) {
    const px = pad.left + ((pt.x - xRange[0]) / (xRange[1] - xRange[0])) * plotW;
    const py = pad.top + ((yRange[1] - pt.y) / (yRange[1] - yRange[0])) * plotH;
    if (px < pad.left || px > width - pad.right) continue;

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}


// ============ Render All Charts ============

function renderWaveformChart() {
  if (!state.rawData) return;

  const { ctx, width, height } = setupCanvas(dom.waveformCanvas);
  ctx.clearRect(0, 0, width, height);

  const { time, pressure } = state.rawData;
  const tMin = time[0];
  const tMax = time[time.length - 1];

  // Apply zoom
  const visibleRange = (tMax - tMin) / state.zoomLevel;
  const xMin = tMin + state.panOffset;
  const xMax = xMin + visibleRange;

  const pMin = -5;
  const pMax = 200;

  // Create labels
  const numXLabels = 7;
  const xLabels = [];
  for (let i = 0; i < numXLabels; i++) {
    xLabels.push((xMin + (xMax - xMin) * (i / (numXLabels - 1))).toFixed(1) + 's');
  }
  const yLabels = ['200', '150', '100', '50', '0'];

  const pad = drawGrid(ctx, width, height, xLabels, yLabels, 'Time (s)', 'Pressure (mmHg)');

  // Draw cuff pressure
  // Downsample for performance
  const step = Math.max(1, Math.floor(time.length / 2000));
  const cuffData = { x: [], y: [] };
  for (let i = 0; i < time.length; i += step) {
    if (time[i] >= xMin && time[i] <= xMax) {
      cuffData.x.push(time[i]);
      cuffData.y.push(pressure[i]);
    }
  }
  plotLine(ctx, cuffData, pad, width, height, [xMin, xMax], [pMin, pMax], '#4e8cff', 2);

  // Draw oscillation (amplified for visibility)
  if (state.filteredOsc) {
    const oscData = { x: [], y: [] };
    for (let i = 0; i < time.length; i += step) {
      if (time[i] >= xMin && time[i] <= xMax) {
        oscData.x.push(time[i]);
        // Offset oscillations to show near middle, amplified
        const basePressure = pressure[i]; // approximate cuff pressure
        oscData.y.push(basePressure + state.filteredOsc[i] * 8);
      }
    }
    plotLine(ctx, oscData, pad, width, height, [xMin, xMax], [pMin, pMax], 'rgba(0,201,167,0.6)', 1);
  }

  // Draw result lines
  if (state.results) {
    drawHorizontalLine(ctx, state.results.sys, pad, width, height, [xMin, xMax], [pMin, pMax], '#ef4444', `SYS ${state.results.sys}`);
    drawHorizontalLine(ctx, state.results.dia, pad, width, height, [xMin, xMax], [pMin, pMax], '#fbbf24', `DIA ${state.results.dia}`);
    drawHorizontalLine(ctx, state.results.map, pad, width, height, [xMin, xMax], [pMin, pMax], '#a78bfa', `MAP ${state.results.map}`);
  }
}

function renderEnvelopeChart(canvas, overlay, detailed = false) {
  if (!state.envelope || state.envelope.length === 0) return;

  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  if (overlay) overlay.classList.add('hidden');

  const peaks = state.envelope;
  const pressures = peaks.map(p => p.pressure);
  const amplitudes = peaks.map(p => p.amplitude);

  const pMin = Math.min(...pressures) - 5;
  const pMax = Math.max(...pressures) + 5;
  const aMax = Math.max(...amplitudes) * 1.2;

  const numXLabels = 6;
  const xLabels = [];
  for (let i = 0; i < numXLabels; i++) {
    xLabels.push(Math.round(pMax - (pMax - pMin) * (i / (numXLabels - 1))).toString());
  }
  const yLabels = [aMax.toFixed(1), (aMax * 0.5).toFixed(1), '0'];

  const pad = drawGrid(ctx, width, height, xLabels, yLabels,
    'Cuff Pressure (mmHg)', detailed ? 'Oscillation Amplitude' : 'Amplitude');

  // Plot envelope curve (pressure decreasing left to right during deflation)
  const envData = { x: [], y: [] };
  // Sort by descending pressure for natural left-to-right
  const sorted = peaks.slice().sort((a, b) => b.pressure - a.pressure);
  for (const p of sorted) {
    envData.x.push(p.pressure);
    envData.y.push(p.amplitude);
  }

  // Flip x-axis: high pressure on left
  plotLine(ctx, envData, pad, width, height, [pMax, pMin], [0, aMax], '#00c9a7', 2.5);

  // Draw peak dots
  const dots = sorted.map(p => ({ x: p.pressure, y: p.amplitude }));
  drawDots(ctx, dots, pad, width, height, [pMax, pMin], [0, aMax], '#00c9a7', 3);

  // Draw threshold lines and BP markers
  if (state.results) {
    const maxAmp = Math.max(...amplitudes);
    const sysThresh = state.params.sysRatio * maxAmp;
    const diaThresh = state.params.diaRatio * maxAmp;

    drawHorizontalLine(ctx, sysThresh, pad, width, height, [pMax, pMin], [0, aMax], 'rgba(239,68,68,0.6)', `SYS thresh`);
    drawHorizontalLine(ctx, diaThresh, pad, width, height, [pMax, pMin], [0, aMax], 'rgba(251,191,36,0.6)', `DIA thresh`);

    drawVerticalLine(ctx, state.results.sys, pad, width, height, [pMax, pMin], [0, aMax], '#ef4444', `SYS ${state.results.sys}`);
    drawVerticalLine(ctx, state.results.dia, pad, width, height, [pMax, pMin], [0, aMax], '#fbbf24', `DIA ${state.results.dia}`);
    drawVerticalLine(ctx, state.results.map, pad, width, height, [pMax, pMin], [0, aMax], '#a78bfa', `MAP ${state.results.map}`);
  }
}

function renderRawSignalChart() {
  if (!state.rawData) return;

  const { ctx, width, height } = setupCanvas(dom.rawSignalCanvas);
  ctx.clearRect(0, 0, width, height);
  dom.rawSignalOverlay.classList.add('hidden');

  const { time, pressure } = state.rawData;
  const tMin = time[0];
  const tMax = time[time.length - 1];
  const pMin = Math.min(...pressure) - 5;
  const pMax = Math.max(...pressure) + 10;

  const numXLabels = 7;
  const xLabels = [];
  for (let i = 0; i < numXLabels; i++) {
    xLabels.push((tMin + (tMax - tMin) * (i / (numXLabels - 1))).toFixed(0) + 's');
  }
  const yLabels = [Math.round(pMax).toString(), Math.round((pMax + pMin) / 2).toString(), Math.round(pMin).toString()];

  const pad = drawGrid(ctx, width, height, xLabels, yLabels, 'Time (s)', 'Pressure (mmHg)');

  const step = Math.max(1, Math.floor(time.length / 3000));
  const data = { x: [], y: [] };
  for (let i = 0; i < time.length; i += step) {
    data.x.push(time[i]);
    data.y.push(pressure[i]);
  }

  plotLine(ctx, data, pad, width, height, [tMin, tMax], [pMin, pMax], '#4e8cff', 1.5);
}

function renderFilteredSignalChart() {
  if (!state.filteredOsc) return;

  const { ctx, width, height } = setupCanvas(dom.filteredSignalCanvas);
  ctx.clearRect(0, 0, width, height);
  dom.filteredSignalOverlay.classList.add('hidden');

  const time = state.rawData.time;
  const osc = state.filteredOsc;
  const tMin = time[0];
  const tMax = time[time.length - 1];

  let oscMax = 0;
  for (let i = 0; i < osc.length; i++) {
    if (Math.abs(osc[i]) > oscMax) oscMax = Math.abs(osc[i]);
  }
  oscMax = oscMax * 1.3;

  const numXLabels = 7;
  const xLabels = [];
  for (let i = 0; i < numXLabels; i++) {
    xLabels.push((tMin + (tMax - tMin) * (i / (numXLabels - 1))).toFixed(0) + 's');
  }
  const yLabels = [oscMax.toFixed(1), '0', (-oscMax).toFixed(1)];

  const pad = drawGrid(ctx, width, height, xLabels, yLabels, 'Time (s)', 'Oscillation (mmHg)');

  const step = Math.max(1, Math.floor(time.length / 3000));
  const data = { x: [], y: [] };
  for (let i = 0; i < time.length; i += step) {
    data.x.push(time[i]);
    data.y.push(osc[i]);
  }

  plotLine(ctx, data, pad, width, height, [tMin, tMax], [-oscMax, oscMax], '#00c9a7', 1.2);

  // Draw envelope peaks
  if (state.envelope) {
    const peakDots = state.envelope.map(p => ({ x: p.time, y: p.amplitude }));
    const negDots = state.envelope.map(p => ({ x: p.time, y: -p.amplitude }));
    drawDots(ctx, peakDots, pad, width, height, [tMin, tMax], [-oscMax, oscMax], 'rgba(251,191,36,0.8)', 3);
    drawDots(ctx, negDots, pad, width, height, [tMin, tMax], [-oscMax, oscMax], 'rgba(251,191,36,0.4)', 2);
  }
}

function renderAllCharts() {
  renderWaveformChart();
  renderEnvelopeChart(dom.envelopeCanvas, dom.envelopeOverlay);
  renderRawSignalChart();
  renderFilteredSignalChart();
  renderEnvelopeChart(dom.envelopeDetailCanvas, dom.envelopeDetailOverlay, true);
}


// ============ Update UI ============

function updateVitals(sys, dia, map, bpm, animate = true) {
  const targets = [
    { el: dom.valSys, value: sys },
    { el: dom.valDia, value: dia },
    { el: dom.valMap, value: map },
    { el: dom.valBpm, value: bpm },
  ];

  targets.forEach(({ el, value }, idx) => {
    if (animate) {
      setTimeout(() => {
        animateNumber(el, 0, value, 800);
        el.classList.add('pop');
        setTimeout(() => el.classList.remove('pop'), 600);
      }, idx * 150);
    } else {
      el.textContent = value;
    }
  });
}

function animateNumber(element, from, to, duration) {
  const startTime = performance.now();
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(from + (to - from) * eased);
    element.textContent = current;
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  requestAnimationFrame(update);
}

function updateClassification(sys, dia) {
  const cl = classifyBP(sys, dia);

  const label = dom.classificationResult.querySelector('.classification-label');
  label.textContent = `${cl.label} (${sys}/${dia})`;
  label.className = 'classification-label ' + cl.class;

  dom.gaugePointer.style.display = 'block';
  dom.gaugePointer.style.left = (cl.gaugePos * 100) + '%';

  return cl;
}

function setStatus(text, analyzing = false) {
  dom.statusText.textContent = text;
  if (analyzing) {
    dom.statusDot.classList.add('analyzing');
  } else {
    dom.statusDot.classList.remove('analyzing');
  }
}

function addToLog(result, source) {
  const idx = state.measurements.length + 1;
  const now = new Date();
  const timeStr = now.toLocaleTimeString();
  const cl = classifyBP(result.sys, result.dia);

  state.measurements.push({ ...result, time: timeStr, classification: cl.label, source });

  // Remove empty row
  const emptyRow = dom.logTbody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${idx}</td>
    <td>${timeStr}</td>
    <td style="color:#ef4444;font-weight:600">${result.sys}</td>
    <td style="color:#4e8cff;font-weight:600">${result.dia}</td>
    <td style="color:#a78bfa;font-weight:600">${result.map}</td>
    <td style="color:#00c9a7;font-weight:600">${result.bpm}</td>
    <td class="classification-cell ${cl.class}">${cl.label}</td>
    <td>${source}</td>
  `;
  tr.style.animation = 'fadeIn 0.3s ease';
  dom.logTbody.insertBefore(tr, dom.logTbody.firstChild);
}


// ============ Real-Time Waveform Animation ============

/**
 * Renders a partial waveform up to the given time index, creating
 * a real-time "recording" effect like a live BP monitor.
 */
function renderWaveformAnimated(upToSample) {
  if (!state.rawData) return;

  const { ctx, width, height } = setupCanvas(dom.waveformCanvas);
  ctx.clearRect(0, 0, width, height);

  const { time, pressure } = state.rawData;
  const tMin = time[0];
  const tMax = time[time.length - 1];

  const pMin = -5;
  const pMax = 200;

  // Create labels
  const numXLabels = 7;
  const xLabels = [];
  for (let i = 0; i < numXLabels; i++) {
    xLabels.push((tMin + (tMax - tMin) * (i / (numXLabels - 1))).toFixed(0) + 's');
  }
  const yLabels = ['200', '150', '100', '50', '0'];

  const pad = drawGrid(ctx, width, height, xLabels, yLabels, 'Time (s)', 'Pressure (mmHg)');

  // Draw only the portion of data we've "recorded" so far
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const step = Math.max(1, Math.floor(upToSample / 2000));

  // Cuff pressure line
  ctx.beginPath();
  ctx.strokeStyle = '#4e8cff';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';

  let lastPx = 0, lastPy = 0;
  let started = false;
  for (let i = 0; i <= upToSample; i += step) {
    const px = pad.left + ((time[i] - tMin) / (tMax - tMin)) * plotW;
    const py = pad.top + ((pMax - pressure[i]) / (pMax - pMin)) * plotH;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
    lastPx = px;
    lastPy = py;
  }
  ctx.stroke();

  // Draw oscillation overlay (green, amplified) if we have filtered data
  if (state.filteredOsc && upToSample > 0) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 201, 167, 0.5)';
    ctx.lineWidth = 1;
    let oscStarted = false;
    for (let i = 0; i <= upToSample; i += step) {
      const px = pad.left + ((time[i] - tMin) / (tMax - tMin)) * plotW;
      const oscVal = pressure[i] + state.filteredOsc[i] * 8;
      const py = pad.top + ((pMax - oscVal) / (pMax - pMin)) * plotH;
      if (!oscStarted) {
        ctx.moveTo(px, py);
        oscStarted = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  // Draw the glowing cursor at the current position
  if (started) {
    // Outer glow
    const gradient = ctx.createRadialGradient(lastPx, lastPy, 0, lastPx, lastPy, 14);
    gradient.addColorStop(0, 'rgba(0, 212, 255, 0.6)');
    gradient.addColorStop(1, 'rgba(0, 212, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(lastPx, lastPy, 14, 0, Math.PI * 2);
    ctx.fill();

    // Inner dot
    ctx.fillStyle = '#00d4ff';
    ctx.beginPath();
    ctx.arc(lastPx, lastPy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Current pressure readout near cursor
    const currentPressure = pressure[Math.min(upToSample, pressure.length - 1)];
    const currentTime = time[Math.min(upToSample, time.length - 1)];
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    const labelX = Math.min(lastPx + 16, width - pad.right - 80);
    const labelY = Math.max(lastPy - 8, pad.top + 16);
    
    // Background pill for readout
    const text = `${Math.round(currentPressure)} mmHg`;
    const metrics = ctx.measureText(text);
    ctx.fillStyle = 'rgba(10, 14, 26, 0.8)';
    ctx.beginPath();
    ctx.roundRect(labelX - 6, labelY - 10, metrics.width + 12, 20, 4);
    ctx.fill();
    ctx.fillStyle = '#00d4ff';
    ctx.fillText(text, labelX, labelY + 4);

    // Phase label at top
    let phase = '';
    if (currentTime < 6) phase = '▲ INFLATING';
    else if (currentTime < 28) phase = '▼ DEFLATING — Measuring';
    else phase = '⏏ RELEASING';

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(phase, pad.left + plotW / 2, pad.top + 14);

    // Elapsed time
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${currentTime.toFixed(1)}s / ${tMax.toFixed(0)}s`, width - pad.right, pad.top + 14);
  }
}


// ============ Analysis Pipeline ============

async function runAnalysis() {
  if (state.isAnalyzing) return;
  state.isAnalyzing = true;

  setStatus('Recording...', true);
  dom.progressContainer.style.display = 'block';
  dom.btnRun.disabled = true;

  // Reset zoom for animation
  state.zoomLevel = 1;
  state.panOffset = 0;

  try {
    // Step 1: Generate/load data
    updateProgress(5, 'Generating signal data...');
    await sleep(200);

    if (state.inputMode === 'demo') {
      state.rawData = generateDemoData();
    }
    // CSV data is already loaded at this point

    if (!state.rawData) {
      throw new Error('No data loaded');
    }

    // Pre-compute the filtered oscillation so we can show it during animation
    const osc = highPassFilter(
      state.rawData.pressure,
      state.params.hpCutoff,
      state.params.sampleRate
    );
    state.filteredOsc = Array.from(osc);

    // Hide overlay to show canvas
    dom.canvasOverlay.classList.add('hidden');

    // Step 2: Animate the waveform in real-time
    const { time, pressure } = state.rawData;
    const totalSamples = time.length;
    const totalDuration = time[totalSamples - 1] - time[0]; // ~30 seconds
    const playbackSpeed = 3.0; // 3x speed — 30s signal plays in ~10s
    const animDuration = (totalDuration / playbackSpeed) * 1000; // in ms

    updateProgress(10, 'Recording cuff pressure...');

    await new Promise((resolve) => {
      const startTime = performance.now();

      function animateFrame(now) {
        if (!state.isAnalyzing) { resolve(); return; } // cancelled

        const elapsed = now - startTime;
        const progress = Math.min(elapsed / animDuration, 1.0);
        const sampleIdx = Math.floor(progress * (totalSamples - 1));

        // Update progress bar
        const progressPct = 10 + progress * 60; // 10% to 70%
        const currentTime = time[sampleIdx];
        let phaseText;
        if (currentTime < 6) phaseText = 'Inflating cuff...';
        else if (currentTime < 28) phaseText = 'Deflating — Measuring oscillations...';
        else phaseText = 'Releasing cuff pressure...';
        updateProgress(progressPct, phaseText);

        // Render the waveform up to current sample
        renderWaveformAnimated(sampleIdx);

        if (progress < 1.0) {
          requestAnimationFrame(animateFrame);
        } else {
          resolve();
        }
      }

      requestAnimationFrame(animateFrame);
    });

    // Step 3: Analysis phase
    setStatus('Analyzing...', true);
    updateProgress(75, 'Applying high-pass filter...');
    await sleep(300);

    // Step 4: Compute low-pass version for cuff baseline
    updateProgress(80, 'Extracting oscillation envelope...');
    await sleep(200);

    const smoothPressure = Array.from(lowPassFilter(
      state.rawData.pressure,
      state.params.hpCutoff * 0.5,
      state.params.sampleRate
    ));

    // Step 5: Find peaks / compute envelope
    updateProgress(85, 'Computing MAO envelope...');
    await sleep(200);

    const peaks = computeEnvelope(
      state.filteredOsc,
      smoothPressure,
      state.rawData.time,
      state.params.sampleRate
    );
    state.envelope = peaks;

    // Step 6: Oscillometric analysis
    updateProgress(90, 'Determining SYS/DIA/MAP...');
    await sleep(300);

    const result = oscillometricAnalysis(peaks, state.params.sysRatio, state.params.diaRatio);
    if (!result) {
      throw new Error('Insufficient oscillation peaks detected. Try different data or parameters.');
    }

    state.results = result;

    // Step 7: Final render with results overlaid
    updateProgress(100, 'Complete!');
    await sleep(200);

    // Hide overlays
    dom.envelopeOverlay.classList.add('hidden');

    // Render final static charts (with SYS/DIA/MAP lines)
    renderAllCharts();
    updateVitals(result.sys, result.dia, result.map, result.bpm);
    updateClassification(result.sys, result.dia);
    addToLog(result, 'Demo / Oscillometric');

    setStatus('Analysis Complete', false);

  } catch (err) {
    console.error('Analysis error:', err);
    setStatus('Error: ' + err.message, false);
    dom.progressText.textContent = 'Error: ' + err.message;
  } finally {
    state.isAnalyzing = false;
    dom.btnRun.disabled = false;
    setTimeout(() => {
      dom.progressContainer.style.display = 'none';
    }, 2000);
  }
}

function updateProgress(pct, text) {
  dom.progressFill.style.width = pct + '%';
  dom.progressText.textContent = text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============ CSV Parser ============
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const time = [];
  const pressure = [];

  // Try to detect delimiter and header
  const firstLine = lines[0];
  const hasHeader = isNaN(parseFloat(firstLine.split(/[,;\t]/)[0]));
  const startIdx = hasHeader ? 1 : 0;
  const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.includes(';') ? ';' : ',');

  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(delimiter).map(s => parseFloat(s.trim()));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      time.push(parts[0]);
      pressure.push(parts[1]);
    }
  }

  if (time.length < 100) {
    throw new Error(`Only ${time.length} valid data points found. Need at least 100.`);
  }

  // Detect sample rate from data
  const avgDt = (time[time.length - 1] - time[0]) / (time.length - 1);
  state.params.sampleRate = Math.round(1 / avgDt);

  return { time, pressure };
}


// ============ Event Handlers ============

function bindEvents() {
  // Tab switching
  dom.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      dom.tabs.forEach(t => t.classList.remove('active'));
      dom.tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('content-' + targetTab).classList.add('active');

      // Resize canvases when switching tabs
      requestAnimationFrame(() => renderAllCharts());
    });
  });

  // Input mode buttons
  dom.btnDemo.addEventListener('click', () => {
    setInputMode('demo');
  });

  dom.btnUpload.addEventListener('click', () => {
    setInputMode('csv');
    dom.csvInput.click();
  });

  dom.btnManual.addEventListener('click', () => {
    setInputMode('manual');
  });

  // CSV file input
  dom.csvInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        state.rawData = parseCSV(ev.target.result);
        setStatus('CSV loaded: ' + file.name, false);
        dom.btnUpload.querySelector('small').textContent = file.name;
      } catch (err) {
        alert('CSV Parse Error: ' + err.message);
        setStatus('CSV error', false);
      }
    };
    reader.readAsText(file);
  });

  // Manual entry
  dom.btnApplyManual.addEventListener('click', () => {
    const sys = parseInt(dom.manualSys.value);
    const dia = parseInt(dom.manualDia.value);
    const bpm = parseInt(dom.manualBpm.value);
    const map = Math.round(dia + (sys - dia) / 3);

    const result = { sys, dia, map, bpm };
    state.results = result;

    updateVitals(sys, dia, map, bpm);
    updateClassification(sys, dia);
    addToLog(result, 'Manual Entry');
    setStatus('Manual values applied', false);

    // Generate synthetic waveform for visualization
    state.rawData = generateDemoData();
    const osc = highPassFilter(state.rawData.pressure, state.params.hpCutoff, state.params.sampleRate);
    state.filteredOsc = Array.from(osc);
    const smoothP = Array.from(lowPassFilter(state.rawData.pressure, state.params.hpCutoff * 0.5, state.params.sampleRate));
    state.envelope = computeEnvelope(state.filteredOsc, smoothP, state.rawData.time, state.params.sampleRate);

    dom.canvasOverlay.classList.add('hidden');
    dom.envelopeOverlay.classList.add('hidden');
    renderAllCharts();
  });

  // Run Analysis
  dom.btnRun.addEventListener('click', runAnalysis);

  // Clear log
  dom.btnClearLog.addEventListener('click', () => {
    state.measurements = [];
    dom.logTbody.innerHTML = '<tr class="empty-row"><td colspan="8">No measurements recorded yet</td></tr>';
  });

  // Zoom controls
  dom.btnZoomIn.addEventListener('click', () => {
    state.zoomLevel = Math.min(state.zoomLevel * 1.5, 20);
    renderWaveformChart();
  });

  dom.btnZoomOut.addEventListener('click', () => {
    state.zoomLevel = Math.max(state.zoomLevel / 1.5, 1);
    if (state.zoomLevel <= 1) state.panOffset = 0;
    renderWaveformChart();
  });

  dom.btnResetZoom.addEventListener('click', () => {
    state.zoomLevel = 1;
    state.panOffset = 0;
    renderWaveformChart();
  });

  // Pan with mouse wheel on waveform canvas
  dom.waveformCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.rawData) return;

    if (e.ctrlKey) {
      // Zoom
      if (e.deltaY < 0) {
        state.zoomLevel = Math.min(state.zoomLevel * 1.2, 20);
      } else {
        state.zoomLevel = Math.max(state.zoomLevel / 1.2, 1);
      }
    } else {
      // Pan
      const { time } = state.rawData;
      const totalRange = time[time.length - 1] - time[0];
      const visibleRange = totalRange / state.zoomLevel;
      const panStep = visibleRange * 0.1;

      state.panOffset += e.deltaY > 0 ? panStep : -panStep;
      state.panOffset = Math.max(0, Math.min(state.panOffset, totalRange - visibleRange));
    }
    renderWaveformChart();
  });

  // Parameter sliders
  const sliders = [
    { slider: dom.paramSysRatio, display: dom.paramSysRatioVal, key: 'sysRatio' },
    { slider: dom.paramDiaRatio, display: dom.paramDiaRatioVal, key: 'diaRatio' },
    { slider: dom.paramHpCutoff, display: dom.paramHpCutoffVal, key: 'hpCutoff' },
    { slider: dom.paramSampleRate, display: dom.paramSampleRateVal, key: 'sampleRate' },
  ];

  sliders.forEach(({ slider, display, key }) => {
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      state.params[key] = val;
      display.textContent = val;
    });
  });

  // Re-analyze button
  dom.btnReanalyze.addEventListener('click', () => {
    if (state.rawData) {
      runAnalysis();
    }
  });

  // Window resize
  window.addEventListener('resize', debounce(() => {
    renderAllCharts();
  }, 250));
}

function setInputMode(mode) {
  state.inputMode = mode;
  document.querySelectorAll('.input-btn').forEach(btn => btn.classList.remove('active'));

  if (mode === 'demo') {
    dom.btnDemo.classList.add('active');
    dom.manualForm.style.display = 'none';
  } else if (mode === 'csv') {
    dom.btnUpload.classList.add('active');
    dom.manualForm.style.display = 'none';
  } else if (mode === 'manual') {
    dom.btnManual.classList.add('active');
    dom.manualForm.style.display = 'block';
  }
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}


// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  bindEvents();
  setStatus('Ready', false);

  // Initial canvas setup (shows grid even without data)
  requestAnimationFrame(() => {
    [dom.waveformCanvas, dom.envelopeCanvas, dom.rawSignalCanvas,
     dom.filteredSignalCanvas, dom.envelopeDetailCanvas].forEach(canvas => {
      if (canvas) setupCanvas(canvas);
    });
  });
});
