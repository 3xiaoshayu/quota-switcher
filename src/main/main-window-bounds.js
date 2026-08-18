const DEFAULT_MAIN_WIDTH = 1440;
const DEFAULT_MAIN_HEIGHT = 900;
const MIN_MAIN_WIDTH = 1280;
const MIN_MAIN_HEIGHT = 720;

function clampDimension(preferred, available) {
    const value = Number(available);
    if (!Number.isFinite(value) || value <= 0) return preferred;
    return Math.min(preferred, Math.round(value));
}

function resolveMainWindowSize(workArea) {
    return {
        width: clampDimension(DEFAULT_MAIN_WIDTH, workArea?.width),
        height: clampDimension(DEFAULT_MAIN_HEIGHT, workArea?.height),
    };
}

module.exports = {
    DEFAULT_MAIN_WIDTH,
    DEFAULT_MAIN_HEIGHT,
    MIN_MAIN_WIDTH,
    MIN_MAIN_HEIGHT,
    resolveMainWindowSize,
};
