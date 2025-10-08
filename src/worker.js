/**
 * @file This script runs in a Web Worker and does all the calculations
 * for the Chaos Game simulation.
 */

// --- Type Definitions ---
/**
 * @typedef {import('./ChaosGame.js').ChaosGameSettings} ChaosGameSettings
 */

/**
 * @typedef {object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} RGBColor
 * @property {number} r - Red component (0-255).
 * @property {number} g - Green component (0-255).
 * @property {number} b - Blue component (0-255).
 */

/**
 * @typedef {object} WorkerState
 * @property {ChaosGameSettings} settings - The current simulation settings.
 * @property {Point[]} vertices - All active vertices, including main, midpoints, and center.
 * @property {Point[]} mainVertices - The vertices of the main polygon only.
 * @property {Point} currentPoint - The current position of the iterating point.
 * @property {Point} center - The center coordinates of the canvas.
 * @property {number} radius - The radius of the circumscribing circle of the main polygon.
 * @property {Float32Array} imageMatrix - A flat array storing the raw hit count for each pixel. Used for high precision.
 * @property {Uint32Array} pixelData - A flat array storing the 32-bit color data (AABBGGRR) for each pixel.
 * @property {ArrayBuffer} imageDataBuffer - The underlying buffer for `pixelData`.
 * @property {number} maxValue - The highest hit count found in `imageMatrix`, used for normalization.
 * @property {number[]} prevIndex - A history of the last few chosen vertex indices for restriction rules.
 * @property {RGBColor} bgColor - The parsed background color.
 * @property {RGBColor} fgColor - The parsed foreground color.
 * @property {number[]} cosAngles - Pre-calculated cosines of rotation angles for symmetrical drawing.
 * @property {number[]} sinAngles - Pre-calculated sines of rotation angles for symmetrical drawing.
 * @property {number} iterations - Total number of points plotted (or batches processed).
 * @property {number} stabilityCounter - Consecutive checks where the simulation was considered stable.
 * @property {number} newPixelsSinceLastCheck - The number of newly colored pixels since the last stability check.
 * @property {number} newPixelsEma - The Exponential Moving Average of new pixels, used to smooth the stability metric.
 * @property {number} filledPixels - Total number of unique pixels that have been hit at least once.
 * @property {number | null} runTime - The timestamp when the simulation started.
 * @property {boolean} isRunning - Flag indicating if the simulation loop is active.
 * @property {number | null} loopId - The ID of the `setTimeout` for the draw loop, used to cancel it.
 * @property {number} lastUpdateTime - The timestamp of the last render sent to the main thread.
 */

/** @type {WorkerState} Global state for the worker. */
let state = {
    settings: {},
    vertices: [],
    mainVertices: [],
    currentPoint: {x: 0, y: 0},
    center: {x: 0, y: 0},
    radius: 0,
    imageMatrix: null,
    pixelData: null,
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

/** @type {OffscreenCanvas | null} */
let offscreenCanvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let ctx = null;

// Constants
const DEFAULT_BATCH_SIZE = 10000; // Number of points to calculate per loop iteration.
const DEFAULT_BURN_IN_COUNT = 300; // Number of initial iterations to discard, letting the point
const DEFAULT_UPDATE_DELAY = 100; // (ms) Minimum delay between sending a new frame to the main thread.
const DEFAULT_STABILITY_INTERVAL = 1000000; // Number of points to plot before checking for stability.
const STABILITY_WINDOW = 10; // Number of consecutive stable checks required to trigger auto-stop.
const EMA_ALPHA = 0.2; // Smoothing factor for the Exponential Moving Average of new pixels.

// --- Helper Functions ---

/**
 * Parses a CSS color string into an RGB object.
 * @param {string} color - The CSS color string (e.g., '#FFF', '#123456', 'rgb(0, 50, 100)').
 * @returns {RGBColor} The parsed RGB color.
 */
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

/**
 * Linearly interpolates between two numbers.
 * @param {number} a - The start value.
 * @param {number} b - The end value.
 * @param {number} t - The interpolation factor (0-1).
 * @returns {number} The interpolated value, rounded to the nearest integer.
 */
function linearInterpolate(a, b, t) {
    return Math.round(a + t * (b - a));
}

/**
 * Calculates the 32-bit integer value for a pixel based on its density.
 * Handles both solid and transparent background modes.
 * @param {number} val - The normalized density value (0 to 1).
 * @returns {number} The 32-bit RGBA pixel value in AABBGGRR format (little-endian).
 */
function calculatePixelValue(val) {
    const {settings, fgColor, bgColor} = state;
    if (!settings.solidBg) {
        // Transparent background: `val` controls alpha, color is fixed to foreground.
        const alpha = linearInterpolate(0, 255, val);
        return (alpha << 24) | (fgColor.b << 16) | (fgColor.g << 8) | fgColor.r;
    } else {
        // Solid background: interpolate RGB from background to foreground, alpha is full.
        const r = linearInterpolate(bgColor.r, fgColor.r, val);
        const g = linearInterpolate(bgColor.g, fgColor.g, val);
        const b = linearInterpolate(bgColor.b, fgColor.b, val);
        return (0xFF << 24) | (b << 16) | (g << 8) | r;
    }
}

/**
 * Normalizes a raw pixel hit count to a 0-1 range using a two-step
 * log-then-gamma pipeline for better visual contrast.
 * @param {number} rawValue - The hit count from the imageMatrix.
 * @param {number} logMax - The pre-calculated log(1 + maxValue).
 * @returns {number} The normalized value between 0 and 1.
 */
function normalizeValue(rawValue, logMax) {
    if (logMax <= 0) return 0;
    // Logarithmic scaling compresses the range, making faint details more visible.
    const logValue = Math.log(1 + rawValue) / logMax;
    // Gamma correction adjusts the brightness.
    return logValue ** state.settings.gammaExponent;
}

// --- Core Logic ---

/**
 * Initializes or resets the entire simulation state based on new settings.
 * @param {ChaosGameSettings} newSettings - The settings to apply.
 */
function setup(newSettings) {
    state.settings = newSettings;
    state.center = {x: state.settings.canvasSize / 2, y: state.settings.canvasSize / 2};
    state.radius = state.settings.canvasSize / 2 - state.settings.padding;

    if (offscreenCanvas.width !== state.settings.canvasSize) {
        offscreenCanvas.width = state.settings.canvasSize;
        offscreenCanvas.height = state.settings.canvasSize;
    }

    const size = state.settings.canvasSize ** 2;
    state.imageMatrix = new Float32Array(size);
    state.imageDataBuffer = new ArrayBuffer(size * 4);
    state.pixelData = new Uint32Array(state.imageDataBuffer);

    updateColors();
    erase();
    preDraw();
}

/**
 * Parses and caches the foreground and background colors from settings.
 */
function updateColors() {
    state.fgColor = colorToRGB(state.settings.fgColor);
    state.bgColor = colorToRGB(state.settings.bgColor);
}

/**
 * Pre-calculates the positions of all vertices (main, midpoints, center)
 * and other geometric data needed for the simulation loop.
 */
function preDraw() {
    const {settings, radius, center} = state;
    state.vertices = [];
    state.cosAngles = [];
    state.sinAngles = [];
    let angle = -Math.PI / 2; // Start at the top

    // Calculate main polygon vertices and rotation angles for symmetry
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

    // Optionally add midpoint vertices
    if (settings.midpointVertex) {
        const midpoints = [];
        for (let i = 0; i < state.vertices.length; i++) {
            let i2 = (i + 1) % settings.sides;
            midpoints.push({
                x: (state.vertices[i].x + state.vertices[i2].x) / 2,
                y: (state.vertices[i].y + state.vertices[i2].y) / 2,
            });
        }
        // Insert midpoints between main vertices
        for (let i = 0; i < midpoints.length; i++) {
            state.vertices.splice(2 * i + 1, 0, midpoints[i]);
        }
    }
    // Optionally add center vertex
    if (settings.centerVertex) state.vertices.push(center);

    state.currentPoint = getRandomPointInShape();
    burnIn();
}

/**
 * Gets a random starting point uniformly distributed inside the main polygon.
 * This prevents initial bias from starting at the center.
 * @returns {Point} A random point within the polygon.
 */
function getRandomPointInShape() {
    const {mainVertices, center} = state;
    const numberOfSides = mainVertices.length;
    // Pick a random triangle formed by the center and two adjacent vertices
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

/**
 * Runs a few initial iterations without plotting to let the current point settle.
 */
function burnIn() {
    for (let i = 0; i < DEFAULT_BURN_IN_COUNT; i++) {
        updateCurrentPoint();
    }
}

/**
 * Selects the next vertex based on the restriction rule and history,
 * then updates the current point's position by moving it a fraction
 * of the distance towards the chosen vertex.
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
                // Cannot pick the same vertex twice in a row.
                if (currentIndex === lastIndex) isForbidden = true;
                break;
            case 'no-double-repeat':
                // Cannot pick the same vertex three times in a row.
                if (currentIndex === lastIndex && currentIndex === prevLastIndex) isForbidden = true;
                break;
            case 'no-return':
                // Cannot pick the vertex chosen two steps ago.
                if (currentIndex === prevLastIndex) isForbidden = true;
                break;
            case 'no-neighbor': {
                // Cannot pick a vertex adjacent to the previous one.
                const sides = settings.midpointVertex ? settings.sides * 2 : settings.sides;
                if (lastIndex !== undefined && lastIndex < sides && currentIndex < sides) {
                    const diff = Math.abs(currentIndex - lastIndex);
                    if (diff === 1 || diff === sides - 1) isForbidden = true;
                }
                break;
            }
            case 'no-neighbor-after-repeat': {
                // If a vertex was repeated, the next cannot be a neighbor.
                const sides = settings.midpointVertex ? settings.sides * 2 : settings.sides;
                if (lastIndex !== undefined && lastIndex === prevLastIndex && lastIndex < sides && currentIndex < sides) {
                    const diff = Math.abs(currentIndex - lastIndex);
                    if (diff === 1 || diff === sides - 1) isForbidden = true;
                }
                break;
            }
        }
    }

    // Update history
    prevIndex.push(currentIndex);
    if (prevIndex.length > 10) {
        prevIndex.shift();
    }

    // Move the current point
    const randomVertex = vertices[currentIndex];
    const {jumpDistance} = settings;
    state.currentPoint.x += (randomVertex.x - state.currentPoint.x) * jumpDistance;
    state.currentPoint.y += (randomVertex.y - state.currentPoint.y) * jumpDistance;
}

/**
 * Populates the `pixelData` array with color values calculated from the
 * raw hit counts in `imageMatrix`.
 */
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

/**
 * Resets the canvas data and simulation counters to their initial state.
 * Fills the background with either black/transparent or the specified background color.
 */
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
        // Transparent background
        state.pixelData.fill(0);
    } else {
        // Solid background color
        const bg32 = (0xFF << 24) | (state.bgColor.b << 16) | (state.bgColor.g << 8) | state.bgColor.r;
        state.pixelData.fill(bg32);
    }
}

/**
 * Draws cosmetic outlines (polygon and/or circle) on the canvas.
 */
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

/**
 * Puts the generated pixel data onto the offscreen canvas and draws cosmetic lines.
 */
function renderCanvas() {
    if (!ctx) return;
    const imageData = new ImageData(new Uint8ClampedArray(state.imageDataBuffer), state.settings.canvasSize, state.settings.canvasSize);
    ctx.putImageData(imageData, 0, 0);

    drawLines();
}

/**
 * A helper function that fully prepares the canvas for output by updating
 * pixel data from the matrix and then rendering it.
 */
function prepareCanvasForOutput() {
    updatePixelDataFromMatrix();
    renderCanvas();
}

/**
 * Prepares the canvas and sends a rendered frame (as an ImageBitmap) to the main thread.
 */
function renderFrame() {
    prepareCanvasForOutput();
    const imageBitmap = offscreenCanvas.transferToImageBitmap();
    self.postMessage({type: 'render', data: {imageBitmap}}, [imageBitmap]);
}

/**
 * Checks if the simulation has reached a stable state where few new pixels are being colored.
 * @returns {boolean} True if the simulation is considered stable, false otherwise.
 */
function checkStability() {
    // Update the Exponential Moving Average of new pixels to smooth out fluctuations.
    state.newPixelsEma = EMA_ALPHA * state.newPixelsSinceLastCheck + (1 - EMA_ALPHA) * state.newPixelsEma;
    state.filledPixels += state.newPixelsSinceLastCheck;
    const newFillRatio = Math.max(0, 1 - state.newPixelsSinceLastCheck / state.filledPixels) * 100;
    state.newPixelsSinceLastCheck = 0;

    self.postMessage({type: 'stabilityCheck', data: {newPixelsEma: state.newPixelsEma, newFillRatio}});

    // If the smoothed number of new pixels is below the threshold...
    if (state.newPixelsEma < (state.settings.stabilityNewPixelsThreshold || 1.0)) {
        state.stabilityCounter++;
        // ...and this has happened for several consecutive checks, we are stable.
        if (state.stabilityCounter >= STABILITY_WINDOW) {
            return true;
        }
    } else {
        // Otherwise, reset the stability counter.
        state.stabilityCounter = 0;
    }
    return false;
}

// --- Main Loop and Controls ---

/**
 * The main simulation loop. It runs in batches to avoid blocking the worker's
 * message queue for too long.
 */
function drawLoop() {
    if (!state.isRunning) return;

    const {settings, center, cosAngles, sinAngles, imageMatrix} = state;
    const {canvasSize, symmetrical, sides} = settings;
    const centerX = center.x;
    const centerY = center.y;

    // Process one batch of points
    for (let i = 0; i < DEFAULT_BATCH_SIZE; i++) {
        updateCurrentPoint();
        const {x: currentX, y: currentY} = state.currentPoint;


        if (symmetrical) {
            // Symmetrical mode plots multiple points for each calculated point,
            // creating a perfectly symmetrical fractal much faster.
            const relX = currentX - centerX;
            const relY = currentY - centerY;
            const mirroredRelX = -relX;

            for (let j = 0; j < sides; j++) {
                const cos = cosAngles[j];
                const sin = sinAngles[j];

                // Point 1: Rotated original
                const rotatedX1 = relX * cos - relY * sin + centerX;
                const rotatedY1 = relX * sin + relY * cos + centerY;

                // Point 2: Rotated reflected point (across the y-axis)
                const rotatedX2 = mirroredRelX * cos - relY * sin + centerX;
                const rotatedY2 = mirroredRelX * sin + relY * cos + centerY;

                // Use bitwise OR with 0 to truncate to integer (faster than Math.floor)
                const p1x = rotatedX1 | 0;
                const p1y = rotatedY1 | 0;
                const p2x = rotatedX2 | 0;
                const p2y = rotatedY2 | 0;

                // Plot both points if they are within canvas bounds
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
            // Standard non-symmetrical plotting
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
    // Periodically check for stability
    if (settings.autoStop && state.iterations >= DEFAULT_STABILITY_INTERVAL) {
        state.iterations = 0; // Reset counter for the next interval
        if (stable) {
            self.postMessage({type: 'finish', data: {time: performance.now() - state.runTime}});
            stop();
            return; // Stop the loop
        }
    }

    // Throttle UI updates to avoid overwhelming the main thread
    const now = performance.now();
    if (now - state.lastUpdateTime > DEFAULT_UPDATE_DELAY) {
        if (settings.liveRendering) {
            renderFrame();
        }
        state.lastUpdateTime = now;
    }

    // Yield to the event loop and schedule the next batch.
    state.loopId = setTimeout(drawLoop, 0);
}


/**
 * Starts the simulation loop.
 */
function play() {
    if (state.isRunning) return;
    state.isRunning = true;
    state.runTime = performance.now();
    state.lastUpdateTime = performance.now();
    drawLoop();
}

/**
 * Stops the simulation loop and performs a final render.
 */
function stop() {
    if (!state.isRunning) return;
    state.runTime = null;
    state.isRunning = false;
    if (state.loopId) {
        clearTimeout(state.loopId);
        state.loopId = null;
    }
    renderFrame(); // Send a final, high-quality frame
}

/**
 * Handles messages received from the main thread.
 */
self.onmessage = (e) => {
    const {type, key, value, canvas, settings: newSettings} = e.data;
    switch (type) {
        case 'initCanvas': {
            // Receives the OffscreenCanvas from the main thread.
            offscreenCanvas = canvas;
            ctx = offscreenCanvas.getContext('2d');
            break;
        }
        case 'init': {
            // Receives initial settings and sets up the simulation.
            setup(newSettings);
            renderFrame(); // Send the initial empty (or outlined) state back.
            break;
        }
        case 'reset': {
            // Stops the current simulation and re-initializes with new settings.
            stop();
            setup(newSettings);
            renderFrame();
            break;
        }
        case 'play': {
            play();
            break;
        }
        case 'stop': {
            stop();
            break;
        }
        case 'updateSetting': {
            // Updates a single setting. Some settings require a full reset,
            // while others only need a re-render.
            state.settings[key] = value;

            const geometryKeys = ['sides', 'padding', 'midpointVertex', 'centerVertex'];
            const colorKeys = ['bgColor', 'fgColor', 'solidBg', 'gammaExponent'];
            const cosmeticKeys = ['drawCircle', 'drawPolygon'];

            let needsRender = false;

            if (geometryKeys.includes(key)) {
                // Geometry changes require a full reset of the simulation.
                stop();
                setup(state.settings);
                renderFrame();
            } else if (colorKeys.includes(key)) {
                // Color changes only require updating colors and re-rendering the current data.
                updateColors();
                if (state.settings.solidBg) {
                    const bg32 = (0xFF << 24) | (state.bgColor.b << 16) | (state.bgColor.g << 8) | state.bgColor.r;
                    state.pixelData.fill(bg32); // Refill background
                } else {
                    state.pixelData.fill(0); // Clear for transparency
                }
                needsRender = true;
            } else if (cosmeticKeys.includes(key)) {
                // Toggling outlines only requires a re-render.
                needsRender = true;
            } else if (key === 'liveRendering' && value === true) {
                // If live rendering is turned on during a run, send a frame immediately.
                needsRender = true;
            }
            // Perform a re-render if needed and if not currently running a simulation
            // that will render anyway.
            if (needsRender && (!state.isRunning || state.settings.liveRendering)) {
                // If live rendering is turned on during a run, send a frame immediately.
                renderFrame();
            }
            break;
        }
        case 'getBlob': {
            // Safely pause the simulation to prevent a race condition with transferToImageBitmap
            const wasRunning = state.isRunning;
            if (wasRunning) {
                state.isRunning = false;
                clearTimeout(state.loopId);
                state.loopId = null;
            }

            prepareCanvasForOutput();
            offscreenCanvas.convertToBlob({type: 'image/png'}).then(blob => {
                self.postMessage({type: 'blobReady', data: {blob}});

                // If the simulation was running before, resume it
                if (wasRunning) {
                    state.isRunning = true;
                    state.loopId = setTimeout(drawLoop, 0);
                }
            });
            break;
        }
    }
};