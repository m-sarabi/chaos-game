import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            // The entry point for your library
            entry: resolve(__dirname, 'src/ChaosGame.js'),
            // The name for the UMD global variable
            name: 'ChaosGame',
            // The file names for the different formats
            fileName: 'chaos-game',
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