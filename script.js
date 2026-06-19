const TWO_PI = Math.PI * 2;
const MIN_WORD_INTERVAL_MS = 260;
const MAX_WORD_INTERVAL_MS = 6200;
const CONTROL_REST_DELAY_MS = 2800;
const CORPUS_URL = "assets/words-50k.txt";
const startTime = performance.now();

const fallbackWords = [
  "anchor",
  "breathe",
  "brighten",
  "canvas",
  "copper",
  "drift",
  "flower",
  "garden",
  "harbor",
  "horizon",
  "lantern",
  "meadow",
  "mirror",
  "observe",
  "river",
  "shadow",
  "signal",
  "silver",
  "soften",
  "stone",
  "timber",
  "unfold",
  "velvet",
  "window"
];

const typefaces = [
  '"Cormorant Garamond", Georgia, serif',
  '"Instrument Serif", Georgia, serif',
  '"Fraunces", Georgia, serif'
];

const layers = Array.from(document.querySelectorAll("[data-word-layer]"));
const spokenWord = document.querySelector("#spoken-word");
const controls = document.querySelector("#controls");
const playToggle = document.querySelector("#play-toggle");
const skipWord = document.querySelector("#skip-word");
const dtReadout = document.querySelector("#dt-readout");
const tempoControl = document.querySelector("#tempo-control");
const rateControl = document.querySelector("#rate-control");
const styleControl = document.querySelector("#style-control");
const depthControl = document.querySelector("#depth-control");
const canvas = document.querySelector("#atmosphere");
const ctx = canvas.getContext("2d", { alpha: true });
const measureCtx = document.createElement("canvas").getContext("2d");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let activeLayerIndex = 0;
let timerId = 0;
let controlsRestTimerId = 0;
let playing = true;
let currentWord = "";
let drift = Number(depthControl.value) / 100;
let noisePattern;
let lastCanvasTime = 0;
let wordCorpusText = "";
let wordOffsets = new Uint32Array();
const recentWords = [];

function randomFloat() {
  if (window.crypto && window.crypto.getRandomValues) {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return value[0] / 4294967296;
  }

  return Math.random();
}

function randomIndex(max) {
  return Math.floor(randomFloat() * max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(min, max, amount) {
  return min + (max - min) * amount;
}

function controlRatio(control) {
  return Number(control.value) / 100;
}

function secondsSinceStart(now = performance.now()) {
  return (now - startTime) / 1000;
}

function timingWaveFrequencyHz() {
  return lerp(0.012, 0.38, Math.pow(controlRatio(rateControl), 1.3));
}

function styleWaveFrequencyHz() {
  return lerp(0.006, 0.24, Math.pow(controlRatio(styleControl), 1.2));
}

function baseWordIntervalMs() {
  return lerp(3000, 520, Math.pow(controlRatio(tempoControl), 1.05));
}

function waveDepth() {
  return lerp(0.18, 0.88, controlRatio(depthControl));
}

function waveAt(seconds, frequencyHz, phase = 0) {
  return Math.sin(seconds * frequencyHz * TWO_PI + phase);
}

function waveAt01(seconds, frequencyHz, phase = 0) {
  return (waveAt(seconds, frequencyHz, phase) + 1) / 2;
}

function waveIndexAt(seconds, frequencyHz, count, phase = 0) {
  return Math.min(count - 1, Math.floor(waveAt01(seconds, frequencyHz, phase) * count));
}

function currentWordIntervalMs(now = performance.now()) {
  const seconds = secondsSinceStart(now);
  const modulation = waveAt(seconds, timingWaveFrequencyHz(), 0);
  const interval = baseWordIntervalMs() * (1 + modulation * waveDepth());

  return clamp(interval, MIN_WORD_INTERVAL_MS, MAX_WORD_INTERVAL_MS);
}

function buildWordOffsets(text) {
  const offsets = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && index + 1 < text.length) {
      offsets.push(index + 1);
    }
  }

  return Uint32Array.from(offsets);
}

function setWordCorpus(text) {
  const normalizedText = text.toLowerCase().trim().split(/\s+/).filter(Boolean).join("\n");
  if (!normalizedText) {
    return false;
  }

  wordCorpusText = `${normalizedText}\n`;
  wordOffsets = buildWordOffsets(wordCorpusText);
  return wordOffsets.length > 0;
}

function wordAt(index) {
  const start = wordOffsets[index];
  let end = wordCorpusText.indexOf("\n", start);

  if (end === -1) {
    end = wordCorpusText.length;
  }

  return wordCorpusText.slice(start, end);
}

async function loadWordCorpus() {
  try {
    const response = await fetch(CORPUS_URL, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Corpus request failed with ${response.status}`);
    }

    const corpusText = await response.text();
    setWordCorpus(corpusText);
  } catch (error) {
    console.warn("Using fallback word list:", error);
  }
}

function nextWord() {
  let word = wordAt(randomIndex(wordOffsets.length));

  for (let tries = 0; tries < 60 && recentWords.includes(word); tries += 1) {
    word = wordAt(randomIndex(wordOffsets.length));
  }

  recentWords.push(word);
  if (recentWords.length > 24) {
    recentWords.shift();
  }
  return word;
}

function lengthScaleFor(word) {
  if (word.length > 12) {
    return 0.44;
  }

  if (word.length > 10) {
    return 0.52;
  }

  if (word.length > 8) {
    return 0.62;
  }

  if (word.length > 6) {
    return 0.72;
  }

  return 0.86;
}

function colorFor(seconds, frequencyHz, depth) {
  const hue = 18 + waveAt01(seconds, frequencyHz * 0.33, 1.2) * 146;
  const saturation = 22 + waveAt01(seconds, frequencyHz * 0.47, 2.6) * (18 + depth * 12);
  const lightness = 18 + waveAt01(seconds, frequencyHz * 0.61, 4.1) * 14;

  return `hsl(${hue.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}

function motifFor(word, now = performance.now()) {
  const seconds = secondsSinceStart(now);
  const styleHz = styleWaveFrequencyHz();
  const depth = waveDepth();
  const intensity = 0.45 + depth * 0.55;
  const italicness = waveAt01(seconds, styleHz * 1.12, 0.2) * intensity;
  const slant = italicness * 15;
  const weight = 540 + waveAt(seconds, styleHz * 0.82, 1.1) * (125 + depth * 150);

  return {
    family: typefaces[waveIndexAt(seconds, styleHz * 0.22, typefaces.length, 0.5)],
    weight: Math.round(clamp(weight, 300, 760)),
    style: slant > 0.35 ? `oblique ${slant.toFixed(2)}deg` : "normal",
    measureStyle: slant > 7 ? "italic" : "normal",
    scale: (0.88 + waveAt01(seconds, styleHz * 0.71, 2.1) * 0.12 * intensity) * lengthScaleFor(word),
    width: 1.56 + waveAt01(seconds, styleHz * 0.53, word.length * 0.37) * (0.78 + depth * 0.28),
    color: colorFor(seconds, styleHz, depth),
    x: `${(waveAt(seconds, styleHz * 0.43, 0.9) * (0.04 + depth * 0.13)).toFixed(3)}em`,
    y: `${(waveAt(seconds, styleHz * 0.36, 2.4) * (0.03 + depth * 0.07)).toFixed(3)}em`,
    rotation: `${(waveAt(seconds, styleHz * 0.29, 0.4) * (0.12 + depth * 0.42)).toFixed(3)}deg`,
    skew: `${(-slant * 0.32).toFixed(3)}deg`,
    soft: Math.round(16 + waveAt01(seconds, styleHz * 0.94, 1.4) * 84),
    wonk: Number((waveAt01(seconds, styleHz * 0.26, 2.2) * depth).toFixed(3)),
    opsz: Math.round(20 + waveAt01(seconds, styleHz * 0.19, 0.7) * 124)
  };
}

function fitMotifToFrame(word, motif, layer) {
  const frame = layer.parentElement;
  const frameWidth = (frame ? frame.clientWidth : window.innerWidth) * 0.9;
  const fontSize = parseFloat(window.getComputedStyle(layer).fontSize) || 160;

  measureCtx.font = `${motif.measureStyle || motif.style} ${motif.weight} ${fontSize}px ${motif.family}`;

  const measuredWidth = measureCtx.measureText(word).width || 1;
  const requestedWidth = measuredWidth * motif.scale * motif.width;

  if (requestedWidth <= frameWidth) {
    return motif;
  }

  const fittedMotif = { ...motif };
  const maxWideScale = frameWidth / (measuredWidth * fittedMotif.scale);
  fittedMotif.width = Math.max(1.42, Math.min(fittedMotif.width, maxWideScale));

  const fittedWidth = measuredWidth * fittedMotif.scale * fittedMotif.width;
  if (fittedWidth > frameWidth) {
    fittedMotif.scale *= frameWidth / fittedWidth;
  }

  return fittedMotif;
}

function applyMotif(layer, motif) {
  layer.style.setProperty("--word-family", motif.family);
  layer.style.setProperty("--word-weight", motif.weight);
  layer.style.setProperty("--word-style", motif.style);
  layer.style.setProperty("--word-scale", motif.scale);
  layer.style.setProperty("--word-width", motif.width);
  layer.style.setProperty("--word-color", motif.color);
  layer.style.setProperty("--word-x", motif.x);
  layer.style.setProperty("--word-y", motif.y);
  layer.style.setProperty("--word-rotation", motif.rotation);
  layer.style.setProperty("--word-skew", motif.skew);
  layer.style.setProperty("--word-soft", motif.soft);
  layer.style.setProperty("--word-wonk", motif.wonk);
  layer.style.setProperty("--word-opsz", motif.opsz);
}

function updateDtReadout(interval = currentWordIntervalMs()) {
  dtReadout.textContent = `${(interval / 1000).toFixed(2)}s`;
}

function syncControlState() {
  drift = waveDepth();
  document.documentElement.style.setProperty("--drift-opacity", String(0.16 + drift * 0.58));
  updateDtReadout();

  tempoControl.title = `${(baseWordIntervalMs() / 1000).toFixed(2)}s average dt`;
  rateControl.title = `${(timingWaveFrequencyHz() * 60).toFixed(1)} timing cycles per minute`;
  styleControl.title = `${(styleWaveFrequencyHz() * 60).toFixed(1)} style cycles per minute`;
  depthControl.title = `${Math.round(waveDepth() * 100)}% modulation depth`;
}

function animateWordStyle(now = performance.now()) {
  updateDtReadout(currentWordIntervalMs(now));

  if (!prefersReducedMotion && currentWord) {
    const layer = layers[activeLayerIndex];
    const motif = fitMotifToFrame(currentWord, motifFor(currentWord, now), layer);
    applyMotif(layer, motif);
  }

  requestAnimationFrame(animateWordStyle);
}

function restControlsSoon(delay = CONTROL_REST_DELAY_MS) {
  window.clearTimeout(controlsRestTimerId);
  controlsRestTimerId = window.setTimeout(() => {
    if (!controls.matches(":hover") && !controls.matches(":focus-within")) {
      controls.classList.add("is-resting");
    }
  }, delay);
}

function wakeControls() {
  controls.classList.remove("is-resting");
  restControlsSoon();
}

function showWord(forceWord) {
  const now = performance.now();
  const previousLayer = layers[activeLayerIndex];
  activeLayerIndex = (activeLayerIndex + 1) % layers.length;
  const nextLayer = layers[activeLayerIndex];
  const word = forceWord || nextWord();
  const motif = fitMotifToFrame(word, motifFor(word, now), nextLayer);

  currentWord = word;
  nextLayer.textContent = word;
  spokenWord.textContent = word;
  applyMotif(nextLayer, motif);
  previousLayer.classList.add("is-receding");
  previousLayer.classList.remove("is-active");
  nextLayer.classList.remove("is-receding");

  requestAnimationFrame(() => {
    nextLayer.classList.add("is-active");
  });

  window.setTimeout(() => previousLayer.classList.remove("is-receding"), 1100);
}

function scheduleNext() {
  window.clearTimeout(timerId);
  if (!playing) {
    return;
  }

  const interval = currentWordIntervalMs();
  updateDtReadout(interval);
  timerId = window.setTimeout(() => {
    showWord();
    scheduleNext();
  }, interval);
}

function setPlaying(nextPlaying) {
  playing = nextPlaying;
  playToggle.classList.toggle("is-paused", !playing);
  playToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  playToggle.setAttribute("title", playing ? "Pause" : "Play");
  scheduleNext();
}

function resizeCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(window.innerWidth * ratio);
  const height = Math.floor(window.innerHeight * ratio);

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  noisePattern = createNoisePattern();
}

function createNoisePattern() {
  const size = 180;
  const noise = document.createElement("canvas");
  const noiseCtx = noise.getContext("2d");
  noise.width = size;
  noise.height = size;

  const image = noiseCtx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 206 + Math.random() * 45;
    const alpha = 10 + Math.random() * 18;
    image.data[i] = value;
    image.data[i + 1] = value * 0.97;
    image.data[i + 2] = value * 0.9;
    image.data[i + 3] = alpha;
  }

  noiseCtx.putImageData(image, 0, 0);
  return ctx.createPattern(noise, "repeat");
}

function drawAtmosphere(time = 0) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const motion = prefersReducedMotion ? 0 : drift;
  const elapsed = time * 0.000045 * motion;

  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = "multiply";
  ctx.lineCap = "round";

  const bands = [
    { color: "35, 73, 76", alpha: 0.12, y: 0.28, wave: 0.82, width: 1.1 },
    { color: "112, 78, 67", alpha: 0.1, y: 0.49, wave: 0.66, width: 0.9 },
    { color: "62, 88, 55", alpha: 0.09, y: 0.66, wave: 0.92, width: 1.35 },
    { color: "33, 37, 35", alpha: 0.06, y: 0.83, wave: 0.58, width: 0.8 }
  ];

  bands.forEach((band, bandIndex) => {
    ctx.beginPath();
    for (let x = -80; x <= width + 80; x += 18) {
      const phase = elapsed * (1.2 + bandIndex * 0.32) + bandIndex * 1.7;
      const y = height * band.y
        + Math.sin(x * 0.0048 * band.wave + phase) * (height * 0.034)
        + Math.sin(x * 0.0016 + phase * 1.7) * (height * 0.024);

      if (x === -80) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = `rgba(${band.color}, ${band.alpha + motion * 0.08})`;
    ctx.lineWidth = band.width + motion * 0.8;
    ctx.stroke();
  });

  ctx.globalCompositeOperation = "soft-light";
  if (noisePattern) {
    ctx.fillStyle = noisePattern;
    ctx.globalAlpha = 0.22 + motion * 0.1;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  lastCanvasTime = time;
  if (!prefersReducedMotion) {
    requestAnimationFrame(drawAtmosphere);
  }
}

playToggle.addEventListener("click", () => setPlaying(!playing));

skipWord.addEventListener("click", () => {
  showWord();
  scheduleNext();
});

[
  tempoControl,
  rateControl,
  styleControl,
  depthControl
].forEach((control) => {
  control.addEventListener("input", () => {
    syncControlState();
    wakeControls();
    scheduleNext();

    if (prefersReducedMotion) {
      const layer = layers[activeLayerIndex];
      if (currentWord) {
        applyMotif(layer, fitMotifToFrame(currentWord, motifFor(currentWord), layer));
      }
      drawAtmosphere(lastCanvasTime);
    }
  });
});

controls.addEventListener("pointerenter", wakeControls);
controls.addEventListener("pointermove", wakeControls);
controls.addEventListener("pointerdown", wakeControls);
controls.addEventListener("focusin", wakeControls);
controls.addEventListener("pointerleave", () => restControlsSoon(900));

window.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    wakeControls();
  }
});

depthControl.addEventListener("change", () => {
  if (prefersReducedMotion) {
    drawAtmosphere(lastCanvasTime);
  }
});

window.addEventListener("resize", () => {
  resizeCanvas();
  drawAtmosphere(lastCanvasTime);
});

resizeCanvas();
setWordCorpus(fallbackWords.join("\n"));
loadWordCorpus();
syncControlState();
drawAtmosphere();
showWord();
animateWordStyle();
scheduleNext();
restControlsSoon();
