const canvas = document.getElementById('chaos-canvas');
const container = document.querySelector('.container');
const stepButton = document.getElementById('chaos-step');
const stopButton = document.getElementById('chaos-stop');
const playButton = document.getElementById('chaos-play');
const sidesInput = document.getElementById('chaos-sides');
const speedInput = document.getElementById('chaos-speed');

const ctx = canvas.getContext('2d');

let stop = false;
let playing = false;
let speed = 1;
const MAX_SPEED = 20;
let center, radius;

speedInput.max = MAX_SPEED;

ctx.strokeStyle = 'white';
resizeCanvas();

function resizeCanvas() {
    const maxWidth = 600;
    const size = Math.min(container.offsetWidth, maxWidth);
    canvas.width = size;
    canvas.height = size;

    center = {x: canvas.width / 2, y: canvas.height / 2};
    radius = canvas.width / 2 - 10;
}

function getRandomPointInShape(vertices, center) {
    // 1. Randomly select one of the triangles that form the polygon.
    // The number of sides (and triangles) is equal to the number of vertices.
    const numberOfSides = vertices.length;
    const triangleIndex = Math.floor(Math.random() * numberOfSides);

    // 2. Define the vertices of the selected triangle.
    const v1 = center;
    const v2 = vertices[triangleIndex];
    const v3 = vertices[(triangleIndex + 1) % numberOfSides];

    // 3. Generate a random point inside this triangle using barycentric coordinates.
    const r1 = Math.random();
    const r2 = Math.random();

    const x = (1 - Math.sqrt(r1)) * v1.x + Math.sqrt(r1) * (1 - r2) * v2.x + Math.sqrt(r1) * r2 * v3.x;
    const y = (1 - Math.sqrt(r1)) * v1.y + Math.sqrt(r1) * (1 - r2) * v2.y + Math.sqrt(r1) * r2 * v3.y;

    return {x, y};
}

function drawPoint(point, size) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, size, 0, Math.PI * 2, true);
    // ctx.fillStyle = color;
    ctx.fill();
}

function drawShape() {
    let angle = -Math.PI / 2;
    vertices.length = 0;
    for (let i = 0; i < sides; i++) {
        vertices.push({x: Math.cos(angle) * radius + center.x, y: Math.sin(angle) * radius + center.y});
        angle += 2 * Math.PI / sides;
    }

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'white';

    ctx.beginPath();
    ctx.strokeStyle = '#555';
    ctx.arc(center.x, center.y, radius + 10, 0, Math.PI * 2, true);
    ctx.stroke();
    ctx.strokeStyle = 'white';

    ctx.beginPath();
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 0; i < vertices.length; i++) {
        const index = (i + 1) % vertices.length;
        ctx.lineTo(vertices[index].x, vertices[index].y);
    }
    ctx.stroke();

    currentPoint = getRandomPointInShape(vertices, center);
    burIn();
}

let vertices = [];
let sides = 3;
let currentPoint;
let pointSize = 1;

drawShape();

function burIn() {
    for (let i = 0; i < sides * 2; i++) {
        const randomVertex = vertices[Math.floor(Math.random() * vertices.length)];

        currentPoint.x = (currentPoint.x + randomVertex.x) / 2;
        currentPoint.y = (currentPoint.y + randomVertex.y) / 2;
    }
}

async function draw(once = false) {
    const randomVertex = vertices[Math.floor(Math.random() * vertices.length)];

    const newPoint = {};

    newPoint.x = (currentPoint.x + randomVertex.x) / 2;
    newPoint.y = (currentPoint.y + randomVertex.y) / 2;

    if (playing) {
        await animateLine(currentPoint, randomVertex, newPoint);
        playing = false;
    }

    currentPoint = newPoint;
    drawPoint(currentPoint, pointSize);
    if (!stop && !once) {
        requestAnimationFrame(() => {
            for (let i = 0; i < speed - 1; i++) {
                draw(true);
            }
            draw();
        });
    }
}

function animateLine(start, end, middle) {
    return new Promise((resolve) => {
        const duration = 1000 / speed;
        const lineStartTime = performance.now();
        const savedCanvas = ctx.getImageData(0, 0, canvas.width, canvas.height);

        function drawLine(currentTime) {
            const elapsedTime = currentTime - lineStartTime;
            const progress = Math.min(elapsedTime / duration, 1);
            const currentX = start.x + (end.x - start.x) * progress;
            const currentY = start.y + (end.y - start.y) * progress;
            ctx.putImageData(savedCanvas, 0, 0);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(currentX, currentY);
            ctx.stroke();

            if (progress < 1) {
                requestAnimationFrame(drawLine);
            } else {
                waitFor(500 / speed, drawPoint);
            }
        }

        function drawPoint() {
            ctx.beginPath();
            ctx.arc(middle.x, middle.y, 3, 0, 2 * Math.PI);
            ctx.fillStyle = 'red';
            ctx.fill();
            ctx.fillStyle = 'white';
            waitFor(500 / speed, restoreCanvas);
        }

        function restoreCanvas() {
            ctx.putImageData(savedCanvas, 0, 0);
            resolve(); // Resolve the promise when done
        }

        function waitFor(ms, callback) {
            const startTime = performance.now();

            function waitLoop(currentTime) {
                const elapsedTime = currentTime - startTime;
                if (elapsedTime >= ms) {
                    callback();
                } else {
                    requestAnimationFrame(waitLoop);
                }
            }

            requestAnimationFrame(waitLoop);
        }

        requestAnimationFrame(drawLine);
    });
}

// requestAnimationFrame(draw);

// events
sidesInput.addEventListener('change', () => {
    stop = true;
    stopButton.disabled = true;
    playButton.disabled = false;
    stepButton.disabled = false;
    requestAnimationFrame(() => {
        sides = parseInt(sidesInput.value);
        drawShape();
        currentPoint = getRandomPointInShape(vertices, center);
        burIn();
    });
});

speedInput.addEventListener('change', () => {
    speed = Number(Math.min(Math.max(1, speedInput.value), MAX_SPEED));
});

stepButton.addEventListener('click', () => {
    stop = true;
    playing = true;
    stopButton.disabled = true;
    playButton.disabled = true;
    stepButton.disabled = true;
    draw().then(() => {
        playButton.disabled = false;
        stepButton.disabled = false;
    });
});

stopButton.addEventListener('click', () => {
    stop = true;
    stopButton.disabled = true;
    playButton.disabled = false;
});

playButton.addEventListener('click', () => {
    stop = false;
    stopButton.disabled = false;
    playButton.disabled = true;
    draw().then();
});

window.addEventListener('resize', () => {
    resizeCanvas();
    drawShape();
});