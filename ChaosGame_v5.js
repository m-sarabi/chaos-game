class ChaosGame {
    /**
     * @param {HTMLCanvasElement | null} showCanvas The canvas element to draw the preview output on.
     * @param {Object} settings The initial settings of the simulation.
     */
    constructor(showCanvas, settings) {
        this.showCanvas = showCanvas;
        this.settings = settings;
        this.listeners = {};
        this.lastBitmap = null;

        this.showCtx = this.showCanvas ? this.showCanvas.getContext('2d') : null;

        // The class creates and manages its own worker
        this.worker = new Worker('worker.js');
        this.worker.onmessage = this.handleWorkerMessage.bind(this);

        this.init();
    }

    init() {
        const offscreen = new OffscreenCanvas(this.settings.canvasSize, this.settings.canvasSize);
        // Transfer control of this canvas to the worker. This is a one-time operation.
        this.worker.postMessage({type: 'initCanvas', canvas: offscreen}, [offscreen]);
        this.worker.postMessage({type: 'init', settings: this.settings});
    }

    /**
     * Handles all messages coming from the worker thread.
     * @param {MessageEvent} e The event object from the worker.
     */
    handleWorkerMessage(e) {
        const {type, data} = e.data;

        switch (type) {
            case 'render': {
                const imageBitmap = data.imageBitmap;
                if (this.lastBitmap) {
                    this.lastBitmap.close();
                }
                this.lastBitmap = imageBitmap;
                this.drawShowCanvas(imageBitmap);
                break;
            }
            case 'stabilityCheck':
                this.emit('stabilityCheck', data);
                break;
            case 'finish':
                this.emit('finish', data);
                break;
            case 'blobReady':
                const imageURL = URL.createObjectURL(data.blob);
                const link = document.createElement('a');
                link.href = imageURL;
                const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '_');
                link.download = `chaos-game-${time}-${this.settings.jumpDistance}.png`;
                link.click();
                URL.revokeObjectURL(imageURL);
                this.emit('download', {})
        }
    }

    drawShowCanvas(imageBitmap) {
        if (!this.showCtx) {
            return;
        }

        this.showCtx.clearRect(0, 0, this.showCanvas.width, this.showCanvas.height);
        if (this.lastBitmap) {
            this.showCtx.drawImage(imageBitmap, 0, 0, this.showCanvas.width, this.showCanvas.height);
        }
    }

    play() {
        this.worker.postMessage({type: 'play'});
    }

    stop() {
        this.worker.postMessage({type: 'stop'});
    }

    reset() {
        if (this.lastBitmap) {
            this.lastBitmap.close();
            this.lastBitmap = null;
        }
        // When resetting, we pass the current settings to the worker
        this.worker.postMessage({type: 'reset', settings: this.settings});
    }

    /**
     * Updates a single setting in the simulation.
     * @param {string} key The name of the setting to update.
     * @param {*} value The new value for the setting.
     */
    updateSetting(key, value) {
        this.settings[key] = value;
        this.worker.postMessage({type: 'updateSetting', key, value});
    }

    /**
     * Registers an event listener.
     * @param {string} eventName The name of the event (e.g., 'finish', 'stabilityCheck').
     * @param {function} callback The function to call when the event is emitted.
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
     */
    emit(eventName, data) {
        if (this.listeners[eventName]) {
            this.listeners[eventName].forEach(callback => callback(data));
        }
    }

    download() {
        this.worker.postMessage({ type: 'getBlob' });
    }
}