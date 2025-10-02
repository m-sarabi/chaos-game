document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const elements = {
        playButton: document.getElementById('chaos-play'),
        stopButton: document.getElementById('chaos-stop'),
        eraseButton: document.getElementById('chaos-erase'),
        downloadButton: document.getElementById('chaos-download'),
        sides: document.getElementById('chaos-sides'),
        size: document.getElementById('canvas-size'),
        padding: document.getElementById('padding'),
        jumpDistance: document.getElementById('jump-distance'),
        gammaExponent: document.getElementById('gamma-exponent'),
        threshold: document.getElementById('chaos-new-pixels-threshold'),
        restriction: document.getElementById('restriction'),
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
        solidBg: document.getElementById('solid-bg'),
    };


    // --- Functions ---
    function getSettingsFromDOM() {
        return {
            sides: parseInt(elements.sides.value),
            canvasSize: parseInt(elements.size.value),
            jumpDistance: parseFloat(elements.jumpDistance.value),
            padding: parseInt(elements.padding.value),
            gammaExponent: parseFloat(elements.gammaExponent.value),
            stabilityNewPixelsThreshold: parseFloat(elements.threshold.value),
            restriction: elements.restriction.value === 'none' ? null : elements.restriction.value,
            centerVertex: elements.centerVertex.checked,
            midpointVertex: elements.midpointVertex.checked,
            drawCircle: elements.linesToggle.checked,
            drawPolygon: elements.linesToggle.checked,
            autoStop: elements.autoStop.checked,
            bgColor: elements.bgInput.value,
            fgColor: elements.fgInput.value,
            solidBg: elements.solidBg.checked,
            symmetrical: true,
        };
    }

    function resizeShowCanvas() {
        const size = Math.min(window.innerHeight - elements.controlsContainer.clientHeight - 40, window.innerWidth - 40);
        elements.showCanvas.height = size;
        elements.showCanvas.width = size;
        if (chaosGame) {
            chaosGame.drawShowCanvas();
        }
    }

    function reset() {
        chaosGame.reset();
        elements.playButton.disabled = false;
        elements.stopButton.disabled = true;
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

    // initialization
    let chaosGame;
    let oldWidth = document.documentElement.clientWidth;
    let optionsOpen = false;
    resizeShowCanvas();
    const initialSettings = getSettingsFromDOM();
    chaosGame = new ChaosGame(elements.showCanvas, initialSettings);

    // wire up ChaosGame events to the UI
    chaosGame.on('stabilityCheck', (data) => {
        elements.emaSpan.textContent = data.newPixelsEma.toFixed(1);
        elements.fillRatio.textContent = data.newFillRatio.toFixed(2) + '%';
    });

    chaosGame.on('finish', (data) => {
        elements.playButton.disabled = false;
        elements.stopButton.disabled = true;
        console.log(data.time);
    });

    // --- Wire up DOM events to ChaosGame methods ---
    elements.playButton.addEventListener('click', () => {
        chaosGame.play();
        elements.playButton.disabled = true;
        elements.stopButton.disabled = false;
    });

    elements.stopButton.addEventListener('click', () => {
        chaosGame.stop();
        elements.playButton.disabled = false;
        elements.stopButton.disabled = true;
    });

    elements.eraseButton.addEventListener('click', () => {
        reset();
    });

    elements.downloadButton.addEventListener('click', () => chaosGame.download());

    // settings that require a full reset
    ['sides', 'size', 'padding', 'restriction', 'centerVertex', 'midpointVertex'].forEach(id => {
        elements[id].addEventListener('change', () => {
            Object.assign(chaosGame.settings, getSettingsFromDOM());
            reset();
        });
    });

    elements.linesToggle.addEventListener('change', () => {
        const isChecked = elements.linesToggle.checked;
        chaosGame.updateSetting('drawCircle', isChecked);
        chaosGame.updateSetting('drawPolygon', isChecked);
    });

    elements.toggleOptionsButton.addEventListener('click', () => {
        toggleOptions();
    });

    elements.overlay.addEventListener('click', (event) => {
        if (event.target === elements.overlay) {
            toggleOptions();
        }
    });

    // settings that can be updated live
    elements.jumpDistance.addEventListener('change', () => chaosGame.updateSetting('jumpDistance', parseFloat(elements.jumpDistance.value)));
    elements.gammaExponent.addEventListener('change', () => chaosGame.updateSetting('gammaExponent', parseFloat(elements.gammaExponent.value)));
    elements.threshold.addEventListener('change', () => chaosGame.updateSetting('stabilityNewPixelsThreshold', parseFloat(elements.threshold.value)));
    elements.bgInput.addEventListener('input', () => chaosGame.updateSetting('bgColor', elements.bgInput.value));
    elements.fgInput.addEventListener('input', () => chaosGame.updateSetting('fgColor', elements.fgInput.value));
    elements.solidBg.addEventListener('input', () => chaosGame.updateSetting('solidBg', elements.solidBg.checked));

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
});