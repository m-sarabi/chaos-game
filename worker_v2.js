// --- Global state for the worker ---
let settings = {};
let vertices = [];
let mainVertices = [];
let currentPoint = null;
let center = null;
let radius = null;
let imageMatrix = null;
let allowedMoves = null;
let pixelData = null;
let imageDataBuffer = null;
let maxValue = 1;
let prevIndex = [];
let bgColor = {r: 0, g: 0, b: 0};
let fgColor = {r: 255, g: 255, b: 255};

let offscreenCanvas = null;
let ctx = null;

let iterations = 0;
let stabilityCounter = 0;
let newPixelsSinceLastCheck = 0;
let newPixelsEma = 0;
let filledPixels = 0;
const emaAlpha = 0.2;

// Pre-computation arrays
let cosAngles = [];
let sinAngles = [];
let runTime = null;

let isRunning = false;
let animationFrameId = null;

// Constants from the original script
const TIME_BUDGET = 50; // ms to run before yielding for messages
const DEFAULT_BATCH_SIZE = 10000;
const DEFAULT_BURN_IN_COUNT = 300;
const DEFAULT_UPDATE_DELAY = 100;
const DEFAULT_STABILITY_INTERVAL = 1000000;
const STABILITY_WINDOW = 10;

// --- Helper Functions ---
function colorToRGB(color) {
    if (color.startsWith('#')) {
        let hex = color.slice(1);
        if (hex.length === 3 || hex.length === 4) {
            hex = hex.split('').map(ch => ch + ch).join('');
        }
        const num = parseInt(hex.slice(0, 6), 16);
        return {r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff};
    } else {
        const rgb = color.match(/\d+/g).map(Number);
        return {r: rgb[0], g: rgb[1], b: rgb[2]};
    }
}

function lerp(a, b, t) {
    return Math.round(a + t * (b - a));
}

/**
 * Calculates the 32-bit integer value for a pixel based on its density.
 * Handles both solid background and transparent background modes.
 * @param {number} val The normalized density value (0 to 1).
 * @returns {number} The 32-bit RGBA pixel value.
 */
function calculatePixelValue(val) {
    if (!settings.solidBg) {
        // When the background is transparent, 'val' controls the alpha channel.
        // The color is always the foreground color.
        const alpha = lerp(0, 255, val);
        return (alpha << 24) | (fgColor.b << 16) | (fgColor.g << 8) | fgColor.r;
    } else {
        // When the background is solid, interpolate RGB and use full alpha.
        const r = lerp(bgColor.r, fgColor.r, val);
        const g = lerp(bgColor.g, fgColor.g, val);
        const b = lerp(bgColor.b, fgColor.b, val);
        return (0xFF << 24) | (b << 16) | (g << 8) | r;
    }
}

/**
 * Normalizes a raw pixel hit count to a 0-1 range using a two-step
 * log-then-gamma pipeline.
 * @param {number} rawValue The hit count from the imageMatrix.
 * @param {number} logMax The pre-calculated log(1 + maxValue).
 * @returns {number} The normalized value between 0 and 1.
 */
function normalizeValue(rawValue, logMax) {
    if (logMax <= 0) return 0; // Avoid division by zero

    // Step 1: Logarithmic scaling to compress the range into a linear 0-1 space.
    const logValue = Math.log(1 + rawValue) / logMax;

    // Step 2: Apply gamma correction to the result for curve/contrast control.
    return logValue ** settings.gammaExponent;
}

function updateColors() {
    fgColor = colorToRGB(settings.fgColor);
    bgColor = colorToRGB(settings.bgColor);
}

function preDraw() {
    vertices.length = 0;
    cosAngles.length = 0;
    sinAngles.length = 0;
    let angle = -Math.PI / 2;

    for (let i = 0; i < settings.sides; i++) {
        vertices.push({
            x: Math.cos(angle) * radius + center.x,
            y: Math.sin(angle) * radius + center.y,
        });

        // Pre-compute rotation values
        const rotationAngle = (2 * Math.PI / settings.sides) * i;
        cosAngles.push(Math.cos(rotationAngle));
        sinAngles.push(Math.sin(rotationAngle));

        angle += 2 * Math.PI / settings.sides;
    }

    mainVertices = [...vertices];

    if (settings.midpointVertex) {
        const midpoints = [];
        for (let i = 0; i < vertices.length; i++) {
            let i2 = (i + 1) % settings.sides;
            midpoints.push({
                x: (vertices[i].x + vertices[i2].x) / 2,
                y: (vertices[i].y + vertices[i2].y) / 2,
            });
        }
        for (let i = 0; i < midpoints.length; i++) {
            vertices.splice(2 * i + 1, 0, midpoints[i]);
        }
    }
    if (settings.centerVertex) vertices.push(center);

    buildRestrictions();
    currentPoint = getRandomPointInShape();
    burnIn();
}

function buildRestrictions() {
    const sides = settings.midpointVertex ? settings.sides * 2 : settings.sides;
    allowedMoves = [];

    for (let i = 0; i < vertices.length; i++) {
        let allowed = [];

        if (['no-repeat', 'no-double-repeat', 'no-return'].includes(settings.restriction)) {
            for (let j = 0; j < vertices.length; j++) {
                if (j !== i) allowed.push(j);
            }
        } else if (['no-neighbor', 'no-neighbor-after-repeat'].includes(settings.restriction)) {
            const left = (i - 1 + sides) % sides;
            const right = (i + 1) % sides;
            for (let j = 0; j < vertices.length; j++) {
                if (i >= sides || (j !== left && j !== right)) allowed.push(j);
            }
        } else {
            allowed = Array.from({length: vertices.length}, (_, j) => j);
        }

        allowedMoves[i] = allowed;
    }
}

function getRandomPointInShape() {
    const numberOfSides = vertices.length;
    const triangleIndex = Math.floor(Math.random() * numberOfSides);
    const v1 = center;
    const v2 = vertices[triangleIndex];
    const v3 = vertices[(triangleIndex + 1) % numberOfSides];
    const r1 = Math.random();
    const r2 = Math.random();
    const x = (1 - Math.sqrt(r1)) * v1.x + Math.sqrt(r1) * (1 - r2) * v2.x + Math.sqrt(r1) * r2 * v3.x;
    const y = (1 - Math.sqrt(r1)) * v1.y + Math.sqrt(r1) * (1 - r2) * v2.y + Math.sqrt(r1) * r2 * v3.y;
    return {x, y};
}

function burnIn() {
    for (let i = 0; i < DEFAULT_BURN_IN_COUNT; i++) {
        updateCurrentPoint();
    }
}

function updateCurrentPoint() {
    let currentIndex;

    if (
        prevIndex.length === 0 ||
        (settings.restriction === 'no-return' && prevIndex.length < 2) ||
        (['no-neighbor-after-repeat', 'no-double-repeat'].includes(settings.restriction) &&
            (prevIndex.length < 2 || prevIndex.at(-1) !== prevIndex.at(-2)))
    ) {
        currentIndex = Math.floor(Math.random() * vertices.length);
    } else {
        const i = settings.restriction === 'no-return' ? -2 : -1;
        const allowed = allowedMoves[prevIndex.at(i)];
        currentIndex = allowed[Math.floor(Math.random() * allowed.length)];
    }

    prevIndex.push(currentIndex);
    if (prevIndex.length > 10) prevIndex.shift();

    const randomVertex = vertices[currentIndex];
    currentPoint.x += (randomVertex.x - currentPoint.x) * settings.jumpDistance;
    currentPoint.y += (randomVertex.y - currentPoint.y) * settings.jumpDistance;
}

function updateMatrix() {
    updateCurrentPoint();

    const rotatePoint = (x, y, cos, sin) => {
        const dx = x - center.x;
        const dy = y - center.y;
        return {
            x: dx * cos - dy * sin + center.x,
            y: dx * sin + dy * cos + center.y,
        };
    };

    const symmetricalPoints = () => {
        const points = [];
        for (let i = 0; i < settings.sides; i++) {
            points.push(rotatePoint(currentPoint.x, currentPoint.y, cosAngles[i], sinAngles[i]));
            points.push(rotatePoint(2 * center.x - currentPoint.x, currentPoint.y, cosAngles[i], sinAngles[i]));
        }
        return points;
    };

    const points = settings.symmetrical ? symmetricalPoints() : [currentPoint];

    for (const point of points) {
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        const index = y * settings.canvasSize + x;

        if (imageMatrix[index] === 0) {
            newPixelsSinceLastCheck++;
        }

        imageMatrix[index]++;
        let val = imageMatrix[index];

        if (val > maxValue) maxValue = val;

        const logMax = Math.log(1 + maxValue);
        const normalizedVal = normalizeValue(val, logMax);

        pixelData[index] = calculatePixelValue(normalizedVal);
    }
}

function rescaleAll() {
    const logMax = Math.log(1 + maxValue);

    for (let i = 0; i < imageMatrix.length; i++) {
        if (imageMatrix[i] >= 0) {
            const normalizedVal = normalizeValue(imageMatrix[i], logMax);
            pixelData[i] = calculatePixelValue(normalizedVal);
        }
    }
}

function erase() {
    if (!ctx) return;
    imageMatrix.fill(0);
    maxValue = 1;
    prevIndex.length = 0;
    iterations = 0;
    stabilityCounter = 0;
    newPixelsSinceLastCheck = 0;
    newPixelsEma = 0;
    filledPixels = 0;

    if (!settings.solidBg) {
        pixelData.fill(0);
    } else {
        const bg32 = (0xFF << 24) | (bgColor.b << 16) | (bgColor.g << 8) | bgColor.r;
        pixelData.fill(bg32);
    }
    ctx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
    if (settings.solidBg) {
        ctx.fillStyle = settings.bgColor;
        ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
    }
    drawLines();
}

function drawCircle() {
    if (!center) return;
    ctx.strokeStyle = settings.fgColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2, true);
    ctx.stroke();

}

function drawPolygon() {
    if (!vertices || vertices.length === 0) return;
    ctx.strokeStyle = settings.fgColor;
    ctx.beginPath();
    // Use the mainVertices passed from preDraw for the outline
    ctx.moveTo(mainVertices[0].x, mainVertices[0].y);
    for (let i = 1; i <= mainVertices.length; i++) {
        ctx.lineTo(mainVertices[i % mainVertices.length].x, mainVertices[i % mainVertices.length].y);
    }
    ctx.stroke();
}

function drawLines() {
    if (settings.drawCircle) drawCircle();
    if (settings.drawPolygon) drawPolygon();
}

function renderCanvas() {
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(imageDataBuffer), settings.canvasSize, settings.canvasSize), 0, 0);
    drawLines();
}

function renderFrame() {
    renderCanvas();
    const imageBitmap = offscreenCanvas.transferToImageBitmap();
    self.postMessage({type: 'render', data: {imageBitmap}}, [imageBitmap]);
}

function checkStability() {
    iterations = 0;
    newPixelsEma = emaAlpha * newPixelsSinceLastCheck + (1 - emaAlpha) * newPixelsEma;
    filledPixels += newPixelsSinceLastCheck;
    const newFillRatio = Math.max(0, 1 - newPixelsSinceLastCheck / filledPixels) * 100;
    newPixelsSinceLastCheck = 0;

    self.postMessage({type: 'stabilityCheck', data: {newPixelsEma, newFillRatio}});

    if (newPixelsEma < (settings.stabilityNewPixelsThreshold || 1.0)) {
        stabilityCounter++;
        if (stabilityCounter >= STABILITY_WINDOW) {
            return true;
        }
    } else {
        stabilityCounter = 0;
    }
    return false;
}

let lastUpdateTime = 0;

function drawLoop(timestamp) {
    if (!isRunning) return;

    const startTime = performance.now();
    while (performance.now() - startTime < TIME_BUDGET) {
        for (let i = 0; i < DEFAULT_BATCH_SIZE; i++) {
            updateMatrix();
        }
        const pointsPerBatch = settings.symmetrical ? settings.sides * 2 : 1;
        iterations += DEFAULT_BATCH_SIZE * pointsPerBatch;

        if (settings.autoStop && iterations >= DEFAULT_STABILITY_INTERVAL) {
            if (checkStability()) {
                self.postMessage({type: 'finish', data: {time: performance.now() - runTime}});
                stop();
                return;
            }
        }
    }

    if (timestamp - lastUpdateTime > DEFAULT_UPDATE_DELAY) {
        if (settings.liveRendering) {
            renderFrame();
        }
        lastUpdateTime = timestamp;
    }

    animationFrameId = self.requestAnimationFrame(drawLoop);
}


// --- Control Functions ---
function play() {
    if (isRunning) return;
    isRunning = true;
    runTime = performance.now();
    lastUpdateTime = performance.now();
    animationFrameId = self.requestAnimationFrame(drawLoop);
}

function stop() {
    if (!isRunning) return;
    runTime = null;
    isRunning = false;
    if (animationFrameId) {
        self.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    rescaleAll();
    renderFrame();
}

// --- Worker Message Handler ---
self.onmessage = (e) => {
    const {type, key, value, canvas, settings: newSettings} = e.data;
    switch (type) {
        case 'initCanvas':
            offscreenCanvas = canvas;
            ctx = offscreenCanvas.getContext('2d');
            break;
        case 'init':
            settings = newSettings;
            center = {x: settings.canvasSize / 2, y: settings.canvasSize / 2};
            radius = settings.canvasSize / 2 - settings.padding;
            imageMatrix = new Float32Array(settings.canvasSize ** 2);
            imageDataBuffer = new ArrayBuffer(settings.canvasSize * settings.canvasSize * 4);
            pixelData = new Uint32Array(imageDataBuffer);
            updateColors();
            preDraw();
            erase();
            renderFrame(); // Initial render
            break;
        case 'reset':
            settings = newSettings;
            stop();
            // Re-run the initialization logic
            center = {x: settings.canvasSize / 2, y: settings.canvasSize / 2};
            radius = settings.canvasSize / 2 - settings.padding;
            if (offscreenCanvas.width !== settings.canvasSize) {
                offscreenCanvas.width = settings.canvasSize;
                offscreenCanvas.height = settings.canvasSize;
            }
            imageMatrix = new Float32Array(settings.canvasSize ** 2);
            imageDataBuffer = new ArrayBuffer(settings.canvasSize * settings.canvasSize * 4);
            pixelData = new Uint32Array(imageDataBuffer);
            updateColors();
            preDraw();
            erase();
            renderFrame();
            break;
        case 'play':
            play();
            break;
        case 'stop':
            stop();
            break;
        case 'updateSetting':
            settings[key] = value;
            let needsRender;
            if (['bgColor', 'fgColor', 'solidBg'].includes(key)) {
                updateColors();
                rescaleAll();
                needsRender = true;
            } else if (key === 'gammaExponent') {
                rescaleAll();
                needsRender = true;
            } else if (['drawCircle', 'drawPolygon'].includes(key)) {
                needsRender = true;
            } else if (key === 'liveRendering' && value === true) {
                // User just re-enabled rendering, send the current frame immediately
                needsRender = true;
            }
            if (needsRender && (!isRunning || settings.liveRendering)) {
                renderFrame();
            }
            break;
        case 'getBlob':
            rescaleAll();
            renderCanvas();
            offscreenCanvas.convertToBlob({type: 'image/png'}).then(blob => {
                console.log(blob);
                self.postMessage({type: 'blobReady', data: {blob}});
            });
            break;
    }
};