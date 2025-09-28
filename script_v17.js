const TIME_BUDGET = 50;

class ChaosGame {
    /**
     *
     * @param {HTMLCanvasElement} showCanvas
     * @param {Object} settings
     */
    constructor(showCanvas, settings) {
        this.showCanvas = showCanvas;
        this.showCtx = this.showCanvas.getContext('2d');
        this.fullCanvas = document.createElement('canvas');
        this.fullCtx = this.fullCanvas.getContext('2d');

        this.settings = {
            sides: 3,
            canvasSize: 1000,
            jumpDistance: 0.5,
            padding: 10,
            burnInCount: 300,
            updateDelay: 50,
            gammaExponent: 0.5,
            batchSize: 10_000,
            autoStop: true,
            drawCircle: false,
            drawPolygon: false,
            symmetrical: true,
            centerVertex: false,
            midpointVertex: false,
            bgColor: 'black',
            fgColor: 'white',
            restriction: null,

            stabilityNewPixelsThreshold: 20.0,
            stabilityCheckInterval: 1_000_000,
            ...settings,
        };

        this.isStopped = false;
        this.vertices = [];
        this.currentPoint = null;
        this.center = null;
        this.radius = null;
        this.imageMatrix = new Float32Array(this.settings.canvasSize ** 2);
        this.updateTime = null;
        this.startTime = null;
        this.iterations = 0;
        this.updateMultiplier = 1;

        // this.availableRestrictions = [
        //     'no-repeat',
        //     'no-neighbor',
        // ];

        this.bgColor = null;
        this.fgColor = null;

        this.maxValue = 1;
        this.imageData = null;
        this.pixelData = null;

        this.filledPixels = 0;
        this.newPixelsSinceLastCheck = 0;
        this.newPixelsEma = 0;
        this.emaAlpha = 0.2;
        this.stabilityWindow = 10;

        this.prevIndex = [];

        this.listeners = {};

        this.bindEvents();
    }

    init() {
        this.resizeCanvas();

        this.newPixelsSinceLastCheck = 0;
        this.newPixelsEma = 0;

        this.maxValue = 0;
        this.imageData = this.fullCtx.createImageData(this.settings.canvasSize, this.settings.canvasSize);
        this.updateColors();

        this.pixelData = new Uint32Array(this.imageData.data.buffer);
        this.pixelData.fill((0xFF << 24) | (this.bgColor.b << 16) | (this.bgColor.g << 8) | this.bgColor.r);
        this.preDraw();
        this.erase();
    }

    reset() {
        this.isStopped = true;
        requestAnimationFrame(() => {
            this.init();
        });
    }

    updateColors() {
        this.fullCtx.fillStyle = this.settings.bgColor;
        this.fullCtx.strokeStyle = this.settings.fgColor;
        this.showCtx.fillStyle = this.settings.bgColor;
        this.showCtx.strokeStyle = this.settings.fgColor;
        this.fgColor = ChaosGame.colorToRGB(this.showCtx.strokeStyle);
        this.bgColor = ChaosGame.colorToRGB(this.showCtx.fillStyle);
    }

    static colorToRGB(color) {
        if (color.startsWith('#')) {
            let hex = color.slice(1);

            // Expand shorthand #rgb or #rgba → #rrggbb / #rrggbbaa
            if (hex.length === 3 || hex.length === 4) {
                hex = hex.split('').map(ch => ch + ch).join('');
            }

            hex = parseInt(hex.slice(0, 6), 16);
            return {r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff};
        } else {
            const rgb = color.match(/\d+/g).map(Number);
            return {r: rgb[0], g: rgb[1], b: rgb[2]};
        }
    }

    /**
     *
     * @param {string} eventName
     * @param {function} callback
     */
    on(eventName, callback) {
        if (!this.listeners[eventName]) {
            this.listeners[eventName] = [];
        }
        this.listeners[eventName].push(callback);
    }

    // todo: add an off() to remove event

    /**
     *
     * @param {string} eventName
     * @param {any} data
     */
    emit(eventName, data) {
        if (this.listeners[eventName]) {
            this.listeners[eventName].forEach(callback => {
                callback(data);
            });
        }
    }

    getRandomPointInShape() {
        // 1. Randomly select one of the triangles that form the polygon.
        // The number of sides (and triangles) is equal to the number of vertices.
        const numberOfSides = this.vertices.length;
        const triangleIndex = Math.floor(Math.random() * numberOfSides);

        // 2. Define the vertices of the selected triangle.
        const v1 = this.center;
        const v2 = this.vertices[triangleIndex];
        const v3 = this.vertices[(triangleIndex + 1) % numberOfSides];

        // 3. Generate a random point inside this triangle using barycentric coordinates.
        const r1 = Math.random();
        const r2 = Math.random();

        const x = (1 - Math.sqrt(r1)) * v1.x + Math.sqrt(r1) * (1 - r2) * v2.x + Math.sqrt(r1) * r2 * v3.x;
        const y = (1 - Math.sqrt(r1)) * v1.y + Math.sqrt(r1) * (1 - r2) * v2.y + Math.sqrt(r1) * r2 * v3.y;

        return {x, y};
    }

    preDraw() {
        let angle = -Math.PI / 2;
        this.vertices.length = 0;
        for (let i = 0; i < this.settings.sides; i++) {
            this.vertices.push({
                x: Math.cos(angle) * this.radius + this.center.x,
                y: Math.sin(angle) * this.radius + this.center.y,
            });
            angle += 2 * Math.PI / this.settings.sides;
        }
        if (this.settings.midpointVertex) {
            const midpoints = [];
            for (let i = 0; i < this.vertices.length; i++) {
                let i2 = (i + 1) % this.settings.sides;
                midpoints.push({
                    x: (this.vertices[i].x + this.vertices[i2].x) / 2,
                    y: (this.vertices[i].y + this.vertices[i2].y) / 2,
                });
            }
            for (let i = 0; i < midpoints.length; i++) {
                this.vertices.splice(2 * i + 1, 0, midpoints[i]);
            }
        }
        if (this.settings.centerVertex) this.vertices.push(this.center);
        this.buildRestrictions();
        this.fullCtx.fillRect(0, 0, this.fullCanvas.width, this.fullCanvas.height);
        this.erase();
        this.currentPoint = this.getRandomPointInShape();
        this.burnIn();
    }

    buildRestrictions() {
        const sides = this.settings.midpointVertex ? this.settings.sides * 2 : this.settings.sides;
        this.allowedMoves = [];

        for (let i = 0; i < this.vertices.length; i++) {
            let allowed = [];

            if (['no-repeat', 'no-double-repeat'].includes(this.settings.restriction)) {
                // All except self
                for (let j = 0; j < this.vertices.length; j++) {
                    if (j !== i) allowed.push(j);
                }
            } else if (['no-neighbor', 'no-neighbor-after-repeat'].includes(this.settings.restriction)) {
                // All except left/right neighbors
                const left = (i - 1 + sides) % sides;
                const right = (i + 1) % sides;
                for (let j = 0; j < this.vertices.length; j++) {
                    if (i >= sides || (j !== left && j !== right)) allowed.push(j);
                }
            } else {
                // No restriction → all valid
                allowed = Array.from({length: this.vertices.length}, (_, j) => j);
            }

            this.allowedMoves[i] = allowed;
        }
    }

    updateCurrentPoint() {
        let currentIndex;

        if (
            this.prevIndex.length === 0 ||
            (['no-neighbor-after-repeat','no-double-repeat'].includes(this.settings.restriction) &&
            (this.prevIndex.length < 2 || this.prevIndex.at(-1) !== this.prevIndex.at(-2)))
        ) {
            currentIndex = Math.floor(Math.random() * this.vertices.length);
        } else {
            const allowed = this.allowedMoves[this.prevIndex.at(-1)];
            currentIndex = allowed[Math.floor(Math.random() * allowed.length)];
        }

        // keep track of up to 10 previous indexes
        this.prevIndex.push(currentIndex);
        if (this.prevIndex.length > 10) this.prevIndex.shift();

        const randomVertex = this.vertices[currentIndex];
        this.currentPoint.x = this.currentPoint.x + (randomVertex.x - this.currentPoint.x) * this.settings.jumpDistance;
        this.currentPoint.y = this.currentPoint.y + (randomVertex.y - this.currentPoint.y) * this.settings.jumpDistance;
    }

    burnIn() {
        for (let i = 0; i < this.settings.burnInCount; i++) {
            this.updateCurrentPoint();
        }
    }

    updateMatrix() {
        this.updateCurrentPoint();

        const rotatePoint = (x, y, angle) => {
            // Translate point to origin
            const dx = x - this.center.x;
            const dy = y - this.center.y;

            // Apply rotation
            const rotatedX = dx * Math.cos(angle) - dy * Math.sin(angle);
            const rotatedY = dx * Math.sin(angle) + dy * Math.cos(angle);

            // Translate back
            return {
                x: rotatedX + this.center.x,
                y: rotatedY + this.center.y,
            };
        };

        const symmetricalPoints = () => {
            const points = [];
            for (let i = 0; i < this.settings.sides; i++) {
                points.push(rotatePoint(this.currentPoint.x, this.currentPoint.y, 2 * Math.PI / this.settings.sides * i));
                points.push(rotatePoint(2 * this.center.x - this.currentPoint.x, this.currentPoint.y, 2 * Math.PI / this.settings.sides * i));
            }
            return points;
        };

        const points = this.settings.symmetrical ? symmetricalPoints() : [this.currentPoint];

        for (const point of points) {
            const x = Math.round(point.x);
            const y = Math.round(point.y);
            const index = y * this.settings.canvasSize + x;
            const isNewPixel = (this.imageMatrix[index] === 0);
            this.imageMatrix[index] += 1;
            let val = this.imageMatrix[index];

            if (isNewPixel) {
                this.newPixelsSinceLastCheck++;
            }

            if (val > this.maxValue) this.maxValue = val;

            val = (val / this.maxValue) ** this.settings.gammaExponent;
            // const pixelValue = Math.log(1 + val) / Math.log(1 + this.maxValue) * 255 | 0;
            const ler = (a, b, t) => Math.round(a + t * (b - a));
            const pixelValue = {
                r: ler(this.bgColor.r, this.fgColor.r, val),
                g: ler(this.bgColor.g, this.fgColor.g, val),
                b: ler(this.bgColor.b, this.fgColor.b, val),
            };

            this.pixelData[index] = (0xFF << 24) | (pixelValue.b << 16) | (pixelValue.g << 8) | pixelValue.r;
        }
    }

    rescaleAll() {
        for (let i = 0; i < this.settings.canvasSize ** 2; i++) {
            const val = (this.imageMatrix[i] / this.maxValue) ** this.settings.gammaExponent;
            const ler = (a, b, t) => Math.round(a + t * (b - a));
            const pixelValue = {
                r: ler(this.bgColor.r, this.fgColor.r, val),
                g: ler(this.bgColor.g, this.fgColor.g, val),
                b: ler(this.bgColor.b, this.fgColor.b, val),
            };

            // this.pixelData[i] = (0xFF << 24) | (pixelValue << 16) | (pixelValue << 8) | pixelValue;
            this.pixelData[i] = (0xFF << 24) | (pixelValue.b << 16) | (pixelValue.g << 8) | pixelValue.r;
        }
    }

    draw() {
        if (this.isStopped) return;
        const startTime = performance.now();
        while (performance.now() - startTime < TIME_BUDGET) {
            for (let i = 0; i < this.settings.batchSize; i++) {
                this.updateMatrix();
            }
            this.iterations += this.settings.symmetrical ? this.settings.batchSize * this.settings.sides * 2 : this.settings.batchSize;

            if (this.settings.autoStop && this.iterations >= this.settings.stabilityCheckInterval && this.checkStability()) {
                this.stop();
                return;
            }
        }

        if (startTime - this.updateTime > this.settings.updateDelay * this.updateMultiplier) {
            this.updateMultiplier *= 1.01;
            this.updateCanvas();
            this.updateTime = startTime;
        }
        if (!this.isStopped) {
            requestAnimationFrame(() => this.draw());
        }
    }

    drawCircle() {
        this.fullCtx.beginPath();
        this.fullCtx.arc(this.center.x, this.center.y, this.radius, 0, Math.PI * 2, true);
        this.fullCtx.stroke();
    }

    drawPolygon() {
        this.fullCtx.beginPath();
        this.fullCtx.moveTo(this.vertices[0].x, this.vertices[0].y);
        const indexes = this.settings.midpointVertex ?
            Array.from({length: this.settings.sides}, (_, i) => 2 * i) :
            Array.from({length: this.settings.sides}, (_, i) => i);
        for (let i = 0; i < indexes.length; i++) {
            const index = (i + 1) % this.settings.sides;
            this.fullCtx.lineTo(this.vertices[indexes[index]].x, this.vertices[indexes[index]].y);
        }
        this.fullCtx.stroke();
    }

    drawLines() {
        if (this.settings.drawCircle) {
            this.drawCircle();
        }
        if (this.settings.drawPolygon) {
            this.drawPolygon();
        }
    }

    drawFullCanvas() {
        this.fullCtx.putImageData(this.imageData, 0, 0);
        this.drawLines();
    }

    drawShowCanvas() {
        this.showCtx.clearRect(0, 0, this.showCanvas.width, this.showCanvas.height);
        this.showCtx.drawImage(this.fullCanvas, 0, 0, this.fullCanvas.width, this.fullCanvas.height, 0, 0, this.showCanvas.width, this.showCanvas.height);
    }

    checkStability() {
        this.iterations = 0;
        this.newPixelsEma = this.emaAlpha * this.newPixelsSinceLastCheck + (1 - this.emaAlpha) * this.newPixelsEma;
        this.filledPixels += this.newPixelsSinceLastCheck;
        const newFillRatio = Math.max(0, 1 - this.newPixelsSinceLastCheck / this.filledPixels) * 100;
        this.newPixelsSinceLastCheck = 0; // reset counter

        // Event Emission
        this.emit('stabilityCheck', {
            newPixelsEma: this.newPixelsEma,
            newFillRatio,
        });

        const quietByNew = this.newPixelsEma < (this.settings.stabilityNewPixelsThreshold || 1.0);
        if (quietByNew) {
            this.stabilityCounter++;
            if (this.stabilityCounter >= this.stabilityWindow) {
                return true;
            }
        } else {
            this.stabilityCounter = 0;
        }

        return false;
    }


    updateCanvas() {
        this.drawFullCanvas();
        this.drawShowCanvas();
    }

    bindEvents() {
        // inputs
    }

    resizeCanvas() {
        this.fullCanvas.width = this.settings.canvasSize;
        this.fullCanvas.height = this.settings.canvasSize;

        this.center = {x: this.fullCanvas.width / 2, y: this.fullCanvas.height / 2};
        this.radius = this.fullCanvas.width / 2 - this.settings.padding;
        this.drawShowCanvas();
    }

    play() {
        this.isStopped = false;
        document.getElementById('chaos-play').disabled = true;
        document.getElementById('chaos-stop').disabled = false;
        this.startTime = performance.now();
        this.updateTime = this.startTime;
        this.draw();
    }

    stop() {
        this.isStopped = true;
        document.getElementById('chaos-play').disabled = false;
        document.getElementById('chaos-stop').disabled = true;
        this.rescaleAll();
        this.updateCanvas();
        console.log('Total time:', performance.now() - this.startTime);
    }

    erase() {
        this.imageMatrix = new Float32Array(this.settings.canvasSize ** 2);
        this.maxValue = 1;
        this.imageData = this.fullCtx.createImageData(this.settings.canvasSize, this.settings.canvasSize);
        this.pixelData = new Uint32Array(this.imageData.data.buffer);
        this.pixelData.fill((0xFF << 24) | (this.bgColor.b << 16) | (this.bgColor.g << 8) | this.bgColor.r);
        this.prevIndex.length = 0;

        this.iterations = 0;
        this.stabilityCounter = 0;
        this.updateMultiplier = 1;

        this.newPixelsSinceLastCheck = 0;
        this.newPixelsEma = 0;

        this.fullCtx.fillRect(0, 0, this.fullCanvas.width, this.fullCanvas.height);
        this.drawLines();
        this.showCtx.fillRect(0, 0, this.showCanvas.width, this.showCanvas.height);
        this.drawShowCanvas();
    }

    download() {
        const imageURL = this.fullCanvas.toDataURL('image/png');

        const link = document.createElement('a');
        link.href = imageURL;
        link.download = `chaos-game-${new Date(Date.now()).toTimeString().split(' ')[0].replaceAll(':', '_')}-${Math.round(this.settings.jumpDistance * 10000) / 10000}.png`;
        link.click();
    }
}

document.addEventListener('DOMContentLoaded', () => {

    const elements = {
        // controls
        playButton: document.getElementById('chaos-play'),
        stopButton: document.getElementById('chaos-stop'),
        eraseButton: document.getElementById('chaos-erase'),
        downloadButton: document.getElementById('chaos-download'),

        // inputs
        sides: document.getElementById('chaos-sides'),
        size: document.getElementById('canvas-size'),
        padding: document.getElementById('padding'),
        jumpDistance: document.getElementById('jump-distance'),
        gammaExponent: document.getElementById('gamma-exponent'),
        threshold: document.getElementById('chaos-new-pixels-threshold'),
        restriction: document.getElementById('restriction'),

        // toggles
        centerVertex: document.getElementById('center-vertex'),
        midpointVertex: document.getElementById('midpoint-vertex'),
        linesToggle: document.getElementById('show-lines'),
        autoStop: document.getElementById('auto-stop'),

        showCanvas: document.getElementById('chaos-canvas'),
        toggleOptionsButton: document.getElementById('show-options'),
        optionsContainer: document.querySelector('.options'),
        controlsContainer: document.querySelector('.canvas-controls'),
        overlay: document.querySelector('.overlay'),
        emaSpan: document.getElementById('ema-value'),
        fillRatio: document.getElementById('fill-ratio'),
        bgInput: document.getElementById('bg-color'),
        fgInput: document.getElementById('fg-color'),
    };

    function initEvents() {
        // controls
        elements.playButton.addEventListener('click', () => chaosGame.play());
        elements.stopButton.addEventListener('click', () => chaosGame.stop());
        elements.eraseButton.addEventListener('click', () => chaosGame.erase());
        elements.downloadButton.addEventListener('click', () => chaosGame.download());

        // inputs
        elements.sides.addEventListener('change', () => {
            chaosGame.settings.sides = parseInt(elements.sides.value);
            reset();
        });
        elements.size.addEventListener('change', () => {
            chaosGame.settings.canvasSize = parseInt(elements.size.value);
            reset();
        });
        elements.padding.addEventListener('change', () => {
            chaosGame.settings.padding = parseInt(elements.padding.value);
            reset();
        });
        elements.jumpDistance.addEventListener('change', () => {
            chaosGame.settings.jumpDistance = elements.jumpDistance.value;
        });
        elements.gammaExponent.addEventListener('change', () => {
            chaosGame.settings.gammaExponent = elements.gammaExponent.value;
            chaosGame.rescaleAll();
            chaosGame.updateCanvas();
        });
        elements.threshold.addEventListener('change', () => {
            chaosGame.settings.stabilityNewPixelsThreshold = Math.max(1, elements.threshold.value);
        });
        elements.restriction.addEventListener('change', () => {
            const restrictionValue = elements.restriction.value;
            chaosGame.settings.restriction = restrictionValue === 'none' ? null : restrictionValue;
            reset();
        });

        // toggles
        elements.centerVertex.addEventListener('change', () => {
            chaosGame.settings.centerVertex = elements.centerVertex.checked;
            reset();

        });
        elements.midpointVertex.addEventListener('change', () => {
            chaosGame.settings.midpointVertex = elements.midpointVertex.checked;
            reset();
        });
        elements.linesToggle.addEventListener('change', () => {
            chaosGame.settings.drawCircle = chaosGame.settings.drawPolygon = elements.linesToggle.checked;
            chaosGame.updateCanvas();
        });
        elements.autoStop.addEventListener('change', () => {
            chaosGame.settings.autoStop = elements.autoStop.checked;
            elements.threshold.disabled = !elements.autoStop.checked;
        });

        elements.bgInput.addEventListener('input', () => {
            chaosGame.settings.bgColor = elements.bgInput.value;
            chaosGame.updateColors();
            chaosGame.rescaleAll();
            chaosGame.updateCanvas();
        });
        elements.fgInput.addEventListener('input', () => {
            chaosGame.settings.fgColor = elements.fgInput.value;
            chaosGame.updateColors();
            chaosGame.rescaleAll();
            chaosGame.updateCanvas();
        });

        elements.toggleOptionsButton.addEventListener('click', () => {
            toggleOptions();
        });

        elements.overlay.addEventListener('click', (event) => {
            if (event.target === elements.overlay) {
                elements.overlay.classList.add('disabled');
                toggleOptions();
            }
        });

        window.addEventListener('resize', () => {
            if (document.documentElement.clientWidth === oldWidth) {
                return;
            }
            oldWidth = document.documentElement.clientWidth;
            if (document.documentElement.clientWidth > 720) {
                optionsOpen = false;
                elements.toggleOptionsButton.style.display = 'none';
            } else {
                elements.toggleOptionsButton.style.display = 'flex';
            }
            elements.optionsContainer.classList.remove('open');
            elements.overlay.classList.add('disabled');
            resizeShowCanvas();
        });
    }

    function initValues() {
        elements.sides.value = chaosGame.settings.sides;
        elements.size.value = chaosGame.settings.canvasSize;
        elements.padding.value = chaosGame.settings.padding;
        elements.jumpDistance.value = chaosGame.settings.jumpDistance;
        elements.gammaExponent.value = chaosGame.settings.gammaExponent;
        elements.threshold.value = chaosGame.settings.stabilityNewPixelsThreshold;
        elements.threshold.disabled = !chaosGame.settings.autoStop;
        elements.restriction.value = chaosGame.settings.restriction === null ? 'none' : chaosGame.settings.restriction;

        elements.centerVertex.checked = chaosGame.settings.centerVertex;
        elements.midpointVertex.checked = chaosGame.settings.midpointVertex;
        elements.linesToggle.checked = chaosGame.settings.drawCircle;
        elements.autoStop.checked = chaosGame.settings.autoStop;

        elements.bgInput.value = chaosGame.showCtx.fillStyle;
        elements.fgInput.value = chaosGame.showCtx.strokeStyle;
    }

    function toggleOptions() {
        if (optionsOpen) {
            elements.optionsContainer.classList.remove('open');
            elements.overlay.classList.add('disabled');
        } else {
            elements.optionsContainer.classList.add('open');
            elements.overlay.classList.remove('disabled');
        }
        optionsOpen = !optionsOpen;
    }

    function reset() {
        document.getElementById('chaos-stop').disabled = true;
        document.getElementById('chaos-play').disabled = false;
        chaosGame.reset();
    }

    let oldWidth = document.documentElement.clientWidth;
    let optionsOpen = false;

    function resizeShowCanvas() {
        const showCanvasSize = Math.min(window.innerHeight - elements.controlsContainer.clientHeight - 40, window.innerWidth - 40);
        elements.showCanvas.height = showCanvasSize;
        elements.showCanvas.width = showCanvasSize;
    }

    initEvents();

    resizeShowCanvas();
    const chaosGame = new ChaosGame(elements.showCanvas, {
        symmetrical: false,
    });
    chaosGame.init();
    chaosGame.on('stabilityCheck', (data) => {
        elements.emaSpan.textContent = data.newPixelsEma.toFixed(1);
        elements.fillRatio.textContent = data.newFillRatio.toFixed(2) + '%';
    });
    initValues();
});