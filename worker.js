// --- Global state for the worker ---
let state = {
    settings: {},
    vertices: [],
    mainVertices: [],
    currentPoint: {x: 0, y: 0},
    center: {x: 0, y: 0},
    radius: 0,
    imageMatrix: null, // Float32Array for raw hit counts
    pixelData: null, // Uint32Array for color data
    imageDataBuffer: null,
    maxValue: 1,
    prevIndex: [],
    bgColor: {r: 0, g: 0, b: 0},
    fgColor: {r: 255, g: 255, b: 255},
    cosAngles: [],
    sinAngles: [],
    iterations: 0,
    stabilityCounter: 0,
    newPixelsSinceLastCheck: 0,
    newPixelsEma: 0,
    filledPixels: 0,
    runTime: null,
    isRunning: false,
    loopId: null,
    lastUpdateTime: 0,
};

let offscreenCanvas = null;
let ctx = null;

// Constants
const TIME_BUDGET = 50; // ms to run before yielding for messages
const DEFAULT_BATCH_SIZE = 10000;
const DEFAULT_BURN_IN_COUNT = 300;
const DEFAULT_UPDATE_DELAY = 100;
const DEFAULT_STABILITY_INTERVAL = 1000000;
const STABILITY_WINDOW = 10;
const EMA_ALPHA = 0.2;

// --- Helper Functions ---
function colorToRGB(color) {
    if (color.startsWith('#')) {
        let hex = color.slice(1);
        if (hex.length === 3 || hex.length === 4) {
            hex = hex.split('').map(ch => ch + ch).join('');
        }
        const num = parseInt(hex.slice(0, 6), 16);
        return {r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff};
    }
    const match = color.match(/\d+/g);
    if (match) {
        const rgb = match.map(Number);
        return {r: rgb[0], g: rgb[1], b: rgb[2]};
    }
    return {r: 0, g: 0, b: 0}; // Fallback
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
    const {settings, fgColor, bgColor} = state;
    if (!settings.solidBg) {
        // When the background is transparent, 'val' controls the alpha channel.
        // The color is always the foreground color.
        const alpha = lerp(0, 255, val);
        // The pixelData buffer is a Uint32Array, so we pack RGBA into a single 32-bit integer.
        // The format is 0xAABBGGRR on little-endian systems.
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
    if (logMax <= 0) return 0;
    const logValue = Math.log(1 + rawValue) / logMax;
    return logValue ** state.settings.gammaExponent;
}

// --- Core Logic ---
/**
 * Initializes or resets the simulation state based on settings.
 */
function setup(newSettings) {
    state.settings = newSettings;
    state.center = {x: state.settings.canvasSize / 2, y: state.settings.canvasSize / 2};
    state.radius = state.settings.canvasSize / 2 - state.settings.padding;

    // Resize canvas only if necessary
    if (offscreenCanvas.width !== state.settings.canvasSize) {
        offscreenCanvas.width = state.settings.canvasSize;
        offscreenCanvas.height = state.settings.canvasSize;
    }

    // Re-create buffers to match new size
    const size = state.settings.canvasSize ** 2;
    state.imageMatrix = new Float32Array(size);
    state.imageDataBuffer = new ArrayBuffer(size * 4);
    state.pixelData = new Uint32Array(state.imageDataBuffer);

    updateColors();
    preDraw();
    erase();
}

function updateColors() {
    state.fgColor = colorToRGB(state.settings.fgColor);
    state.bgColor = colorToRGB(state.settings.bgColor);
}

function preDraw() {
    const {settings, radius, center} = state;
    state.vertices = [];
    state.cosAngles = [];
    state.sinAngles = [];
    let angle = -Math.PI / 2;

    for (let i = 0; i < settings.sides; i++) {
        state.vertices.push({
            x: Math.cos(angle) * radius + center.x,
            y: Math.sin(angle) * radius + center.y,
        });

        const rotationAngle = (2 * Math.PI / settings.sides) * i;
        state.cosAngles.push(Math.cos(rotationAngle));
        state.sinAngles.push(Math.sin(rotationAngle));

        angle += 2 * Math.PI / settings.sides;
    }

    state.mainVertices = [...state.vertices];

    if (settings.midpointVertex) {
        const midpoints = [];
        for (let i = 0; i < state.vertices.length; i++) {
            let i2 = (i + 1) % settings.sides;
            midpoints.push({
                x: (state.vertices[i].x + state.vertices[i2].x) / 2,
                y: (state.vertices[i].y + state.vertices[i2].y) / 2,
            });
        }
        for (let i = 0; i < midpoints.length; i++) {
            state.vertices.splice(2 * i + 1, 0, midpoints[i]);
        }
    }
    if (settings.centerVertex) state.vertices.push(center);

    state.currentPoint = getRandomPointInShape();
    burnIn();
}

function getRandomPointInShape() {
    const {mainVertices, center} = state;
    const numberOfSides = mainVertices.length;
    const triangleIndex = Math.floor(Math.random() * numberOfSides);
    const v1 = center;
    const v2 = mainVertices[triangleIndex];
    const v3 = mainVertices[(triangleIndex + 1) % numberOfSides];
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

/**
 * Selects the next vertex based on the current restriction rule and history,
 * then updates the current point's position.
 */
function updateCurrentPoint() {
    const {settings, vertices, prevIndex} = state;
    const numVertices = vertices.length;

    const lastIndex = prevIndex.at(-1);
    const prevLastIndex = prevIndex.at(-2);

    let currentIndex;
    let isForbidden = true;

    // "Select and Retry" loop. In almost all cases, this will only run once.
    while (isForbidden) {
        currentIndex = Math.floor(Math.random() * numVertices);
        isForbidden = false;

        switch (settings.restriction) {
            case 'no-repeat':
                if (currentIndex === lastIndex) isForbidden = true;
                break;
            case 'no-double-repeat':
                if (currentIndex === lastIndex && currentIndex === prevLastIndex) isForbidden = true;
                break;
            case 'no-return':
                if (currentIndex === prevLastIndex) isForbidden = true;
                break;
            case 'no-neighbor': {
                const sides = settings.midpointVertex ? settings.sides * 2 : settings.sides;
                if (lastIndex !== undefined && lastIndex < sides && currentIndex < sides) {
                    const diff = Math.abs(currentIndex - lastIndex);
                    if (diff === 1 || diff === sides - 1) isForbidden = true;
                }
                break;
            }
            case 'no-neighbor-after-repeat': {
                const sides = settings.midpointVertex ? settings.sides * 2 : settings.sides;
                if (lastIndex !== undefined && lastIndex === prevLastIndex && lastIndex < sides && currentIndex < sides) {
                    const diff = Math.abs(currentIndex - lastIndex);
                    if (diff === 1 || diff === sides - 1) isForbidden = true;
                }
                break;
            }
        }
    }

    prevIndex.push(currentIndex);
    if (prevIndex.length > 10) {
        prevIndex.shift();
    }

    const randomVertex = vertices[currentIndex];
    const {jumpDistance} = settings;
    state.currentPoint.x += (randomVertex.x - state.currentPoint.x) * jumpDistance;
    state.currentPoint.y += (randomVertex.y - state.currentPoint.y) * jumpDistance;
}

function updatePixelDataFromMatrix() {
    const {imageMatrix, pixelData, maxValue} = state;
    const logMax = Math.log(1 + maxValue);

    for (let i = 0; i < imageMatrix.length; i++) {
        if (imageMatrix[i] > 0) {
            const normalizedVal = normalizeValue(imageMatrix[i], logMax);
            pixelData[i] = calculatePixelValue(normalizedVal);
        }
    }
}

function erase() {
    if (!ctx) return;
    state.imageMatrix.fill(0);
    state.maxValue = 1;
    state.prevIndex = [];
    state.iterations = 0;
    state.stabilityCounter = 0;
    state.newPixelsSinceLastCheck = 0;
    state.newPixelsEma = 0;
    state.filledPixels = 0;

    if (!state.settings.solidBg) {
        state.pixelData.fill(0);
    } else {
        const bg32 = (0xFF << 24) | (state.bgColor.b << 16) | (state.bgColor.g << 8) | state.bgColor.r;
        state.pixelData.fill(bg32);
    }
}

function drawLines() {
    const {settings, mainVertices, center, radius} = state;
    if (!settings.drawCircle && !settings.drawPolygon) return;

    ctx.strokeStyle = settings.fgColor;
    ctx.lineWidth = 1;

    if (settings.drawCircle) {
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2, true);
        ctx.stroke();
    }
    if (settings.drawPolygon && mainVertices.length > 0) {
        ctx.beginPath();
        ctx.moveTo(mainVertices[0].x, mainVertices[0].y);
        for (let i = 1; i <= mainVertices.length; i++) {
            ctx.lineTo(mainVertices[i % mainVertices.length].x, mainVertices[i % mainVertices.length].y);
        }
        ctx.stroke();
    }
}

function renderCanvas() {
    if (!ctx) return;
    const imageData = new ImageData(new Uint8ClampedArray(state.imageDataBuffer), state.settings.canvasSize, state.settings.canvasSize);
    ctx.putImageData(imageData, 0, 0);

    drawLines();
}

/**
 * Updates the pixel data from the raw matrix and draws it to the offscreen canvas.
 */
function prepareCanvasForOutput() {
    updatePixelDataFromMatrix();
    renderCanvas();
}


function renderFrame() {
    prepareCanvasForOutput();
    const imageBitmap = offscreenCanvas.transferToImageBitmap();
    self.postMessage({type: 'render', data: {imageBitmap}}, [imageBitmap]);
}

function checkStability() {
    state.newPixelsEma = EMA_ALPHA * state.newPixelsSinceLastCheck + (1 - EMA_ALPHA) * state.newPixelsEma;
    state.filledPixels += state.newPixelsSinceLastCheck;
    const newFillRatio = Math.max(0, 1 - state.newPixelsSinceLastCheck / state.filledPixels) * 100;
    state.newPixelsSinceLastCheck = 0;

    self.postMessage({type: 'stabilityCheck', data: {newPixelsEma: state.newPixelsEma, newFillRatio}});

    if (state.newPixelsEma < (state.settings.stabilityNewPixelsThreshold || 1.0)) {
        state.stabilityCounter++;
        if (state.stabilityCounter >= STABILITY_WINDOW) {
            return true;
        }
    } else {
        state.stabilityCounter = 0;
    }
    return false;
}

// --- Main Loop and Controls ---

function drawLoop() {
    if (!state.isRunning) return;

    const {settings, center, cosAngles, sinAngles, imageMatrix} = state;
    const {canvasSize, symmetrical, sides} = settings;
    const centerX = center.x;
    const centerY = center.y;

    const startTime = performance.now();
    for (let i = 0; i < DEFAULT_BATCH_SIZE; i++) {
        updateCurrentPoint();
        const {x: currentX, y: currentY} = state.currentPoint;

        if (symmetrical) {
            // Pre-calculate relative coordinates to the center
            const relX = currentX - centerX;
            const relY = currentY - centerY;
            const mirroredRelX = -relX;

            for (let j = 0; j < sides; j++) {
                const cos = cosAngles[j];
                const sin = sinAngles[j];

                // Point 1: Rotated original
                const rotatedX1 = relX * cos - relY * sin + centerX;
                const rotatedY1 = relX * sin + relY * cos + centerY;

                // Point 2: Rotated mirrored
                const rotatedX2 = mirroredRelX * cos - relY * sin + centerX;
                const rotatedY2 = mirroredRelX * sin + relY * cos + centerY;

                const p1x = rotatedX1 | 0;
                const p1y = rotatedY1 | 0;
                const p2x = rotatedX2 | 0;
                const p2y = rotatedY2 | 0;

                if (p1x >= 0 && p1x < canvasSize && p1y >= 0 && p1y < canvasSize) {
                    const index = p1y * canvasSize + p1x;
                    if (imageMatrix[index] === 0) state.newPixelsSinceLastCheck++;
                    const val = ++imageMatrix[index];
                    if (val > state.maxValue) state.maxValue = val;
                }
                if (p2x >= 0 && p2x < canvasSize && p2y >= 0 && p2y < canvasSize) {
                    const index = p2y * canvasSize + p2x;
                    if (imageMatrix[index] === 0) state.newPixelsSinceLastCheck++;
                    const val = ++imageMatrix[index];
                    if (val > state.maxValue) state.maxValue = val;
                }
            }
        } else {
            const px = currentX | 0;
            const py = currentY | 0;

            if (px >= 0 && px < canvasSize && py >= 0 && py < canvasSize) {
                const index = py * canvasSize + px;
                if (imageMatrix[index] === 0) state.newPixelsSinceLastCheck++;
                const val = ++imageMatrix[index];
                if (val > state.maxValue) state.maxValue = val;
            }
        }
    }
    const pointsPerBatch = symmetrical ? sides * 2 : 1;
    state.iterations += DEFAULT_BATCH_SIZE * pointsPerBatch;

    const stable = checkStability();
    if (settings.autoStop && state.iterations >= DEFAULT_STABILITY_INTERVAL) {
        state.iterations = 0;
        if (stable) {
            self.postMessage({type: 'finish', data: {time: performance.now() - state.runTime}});
            stop();
            return;
        }
    }

    const now = performance.now();
    if (now - state.lastUpdateTime > DEFAULT_UPDATE_DELAY) {
        if (settings.liveRendering) {
            renderFrame();
        }
        state.lastUpdateTime = now;
    }

    state.loopId = setTimeout(drawLoop, 0);
}


// --- Control Functions ---
function play() {
    if (state.isRunning) return;
    state.isRunning = true;
    state.runTime = performance.now();
    state.lastUpdateTime = performance.now();
    drawLoop();
}

function stop() {
    if (!state.isRunning) return;
    state.runTime = null;
    state.isRunning = false;
    if (state.loopId) {
        clearTimeout(state.loopId);
        state.loopId = null;
    }
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
            setup(newSettings);
            renderFrame(); // Initial render
            break;
        case 'reset':
            stop();
            setup(newSettings);
            renderFrame();
            break;
        case 'play':
            play();
            break;
        case 'stop':
            stop();
            break;
        case 'updateSetting':
            state.settings[key] = value;

            const geometryKeys = ['sides', 'padding', 'midpointVertex', 'centerVertex'];
            const colorKeys = ['bgColor', 'fgColor', 'solidBg', 'gammaExponent'];
            const cosmeticKeys = ['drawCircle', 'drawPolygon'];

            let needsRender = false;

            if (geometryKeys.includes(key)) {
                // These require a full reset of the simulation
                stop();
                setup(state.settings);
                renderFrame();

            } else if (colorKeys.includes(key)) {
                updateColors();
                if (state.settings.solidBg) {
                    const bg32 = (0xFF << 24) | (state.bgColor.b << 16) | (state.bgColor.g << 8) | state.bgColor.r;
                    state.pixelData.fill(bg32);
                } else {
                    state.pixelData.fill(0);
                }
                needsRender = true;
            } else if (cosmeticKeys.includes(key)) {
                needsRender = true;
            } else if (key === 'liveRendering' && value === true) {
                needsRender = true;
            }
            if (needsRender && (!state.isRunning || state.settings.liveRendering)) {
                renderFrame();
            }
            break;
        case 'getBlob':
            prepareCanvasForOutput();
            offscreenCanvas.convertToBlob({type: 'image/png'}).then(blob => {
                self.postMessage({type: 'blobReady', data: {blob}});
            });
            break;
    }
};