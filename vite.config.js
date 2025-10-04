import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'src/ChaosGame.js'),
            // The name for the UMD global variable
            name: 'ChaosGame',
            // Formats to build
            formats: ['es', 'umd'],
            fileName: (format) => {
                if (format === 'umd') {
                    return 'chaos-game.umd.js'; // The key change is here!
                }
                return 'chaos-game.es.js';
            },
        },
        sourcemap: true,
        rollupOptions: {
            external: [],
            output: {
                globals: {},
            },
        },
    },
});