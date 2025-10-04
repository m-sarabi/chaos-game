/**
 * @typedef {'none' | 'no-repeat' | 'no-double-repeat' | 'no-return' | 'no-neighbor' | 'no-neighbor-after-repeat'} RestrictionRule
 * The rule for choosing the next vertex.
 */

/**
 * @typedef {object} ChaosGameSettings
 * @property {number} canvasSize - The width and height of the canvas in pixels.
 * @property {number} sides - The number of vertices in the main polygon.
 * @property {number} jumpDistance - The fraction of the distance to move towards the chosen vertex.
 * @property {number} padding - The margin in pixels from the edge of the canvas to the polygon.
 * @property {boolean} midpointVertex - If true, adds vertices at the midpoint of each side of the main polygon.
 * @property {boolean} centerVertex - If true, adds a vertex at the geometric center of the polygon.
 * @property {RestrictionRule} restriction - The rule for choosing the next vertex.
 * @property {string} fgColor - The foreground color (for plotted points, circle and polygon) in a CSS-compatible format (e.g., '#FFFFFF', 'rgb(255,255,255)').
 * @property {string} bgColor - The background color, used if `solidBg` is true.
 * @property {boolean} solidBg - If true, the background is a solid color; otherwise, it's transparent.
 * @property {number} gammaExponent - The gamma correction value for adjusting brightness and contrast.
 * @property {boolean} drawCircle - If true, draws the circumscribing circle.
 * @property {boolean} drawPolygon - If true, draws the main polygon's outline.
 * @property {boolean} symmetrical - If true, applies rotational and reflectional symmetry for faster and more perfect results.
 * @property {boolean} autoStop - If true, the simulation will automatically stop when it becomes stable.
 * @property {boolean} liveRendering - If true, the canvas will update periodically while the simulation is running.
 * @property {number} stabilityNewPixelsThreshold - The threshold for new pixels (EMA) below which the simulation is considered stable.
 */

/**
 * This class is the main controller of the Chaos Game,
 * handling user interactions, settings, and communications with the Web Worker
 */
class ChaosGame {
    /**
     * @param {HTMLCanvasElement | null} showCanvas The canvas element to draw the preview output on.
     * @param {ChaosGameSettings} settings The initial settings of the simulation.
     */
    constructor(showCanvas, settings) {
        /** @type {HTMLCanvasElement | null} */
        this.showCanvas = showCanvas;
        /** @type {ChaosGameSettings} */
        this.settings = settings;
        /** @type {Object.<string, Array<(data: any) => void>>} */
        this.listeners = {};
        /** @type {ImageBitmap | null} */
        this.lastBitmap = null;
        /** @type {CanvasRenderingContext2D | null} */
        this.showCtx = this.showCanvas ? this.showCanvas.getContext('2d') : null;

        // The class creates and manages its own worker
        this.worker = new Worker('worker.js');
        this.worker.onmessage = this.handleWorkerMessage.bind(this);

        this.init();
    }

    /**
     * Initializes the worker by creating and transferring an OffscreenCanvas.
     * to render directly without involving the main thread.
     * @private
     */
    init() {
        const offscreen = new OffscreenCanvas(this.settings.canvasSize, this.settings.canvasSize);
        // Transfer control of this canvas to the worker. This is a one-time operation.
        this.worker.postMessage({type: 'initCanvas', canvas: offscreen}, [offscreen]);
        this.worker.postMessage({type: 'init', settings: this.settings});
    }

    /**
     * Handles all messages coming from the worker thread.
     * @param {MessageEvent} e The event object from the worker.
     * @private
     */
    handleWorkerMessage(e) {
        const {type, data} = e.data;

        switch (type) {
            case 'render': {
                // The worker has sent a new frame to display.
                const imageBitmap = data.imageBitmap;
                if (this.lastBitmap) {
                    this.lastBitmap.close();
                }
                this.lastBitmap = imageBitmap;
                this.drawShowCanvas(imageBitmap);
                break;
            }
            case 'stabilityCheck': {
                // The worker has sent a stability update.
                this.emit('stabilityCheck', data);
                break;
            }
            case 'finish': {
                // The worker has finished due to auto-stop
                this.emit('finish', data);
                break;
            }
            case 'blobReady': {
                // The worker has prepared a PNG blob for download.
                const imageURL = URL.createObjectURL(data.blob);
                const link = document.createElement('a');
                link.href = imageURL;
                const {sides, jumpDistance, restriction} = this.settings;
                const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '_');
                link.download = `chaos-game_s${sides}_j${jumpDistance.toFixed(4)}_${restriction}_${time}.png`;
                link.click();
                URL.revokeObjectURL(imageURL);
                this.emit('download', {});
                break;
            }
            default: {
                console.warn(`Unknown worker message type: ${type}`);
                break;
            }
        }
    }

    /**
     * Draws the ImageBitmap on the show canvas.
     * @param {ImageBitmap} imageBitmap The bitmap to draw.
     */
    drawShowCanvas(imageBitmap) {
        if (!this.showCtx) {
            return;
        }

        this.showCtx.clearRect(0, 0, this.showCanvas.width, this.showCanvas.height);
        if (this.lastBitmap) {
            this.showCtx.drawImage(imageBitmap, 0, 0, this.showCanvas.width, this.showCanvas.height);
        }
    }

    /**
     * Starts or resumes the simulation in the worker.
     */
    play() {
        this.worker.postMessage({type: 'play'});
    }

    /**
     * Stops or pauses the simulation in the worker.
     */
    stop() {
        this.worker.postMessage({type: 'stop'});
    }

    /**
     * Resets the simulation in the worker to its initial state using the current settings.
     */
    reset() {
        if (this.lastBitmap) {
            this.lastBitmap.close();
            this.lastBitmap = null;
        }
        this.worker.postMessage({type: 'reset', settings: this.settings});
    }

    /**
     * Updates a single setting in the simulation.
     * @param {keyof ChaosGameSettings} key The name of the setting to update.
     * @param {*} value The new value for the setting.
     */
    updateSetting(key, value) {
        this.settings[key] = value;
        this.worker.postMessage({type: 'updateSetting', key, value});
    }

    /**
     * Registers an event listener.
     * @param {'finish' | 'stabilityCheck' | 'download'} eventName The name of the event.
     * @param {(data: any) => void} callback The function to call when the event is emitted.
     */
    on(eventName, callback) {
        if (!this.listeners[eventName]) {
            this.listeners[eventName] = [];
        }
        this.listeners[eventName].push(callback);
    }

    /**
     * Emits an event to all registered listeners.
     * @param {string} eventName The name of the event to emit.
     * @param {any} data The data to pass to the listeners.
     * @private
     */
    emit(eventName, data) {
        if (this.listeners[eventName]) {
            this.listeners[eventName].forEach(callback => callback(data));
        }
    }

    /**
     * Requests the worker to generate a PNG blob of the current canvas state for downloading.
     */
    download() {
        this.worker.postMessage({type: 'getBlob'});
    }
}