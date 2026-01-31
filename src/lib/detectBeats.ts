interface BeatDetectorConfig {
    fftSize: number;
    // Frequency ranges (in bins)
    subBassRange: [number, number];
    bassRange: [number, number];
    lowMidRange: [number, number];
    midRange: [number, number];
    highMidRange: [number, number];
    highRange: [number, number];
    // Weights for different frequency bands
    subBassWeight: number;
    bassWeight: number;
    lowMidWeight: number;
    midWeight: number;
    highMidWeight: number;
    highWeight: number;
    minBeatSeparation: number;
    energyThreshold: number;
    historySize: number;
    // New options for versatility
    useOnsetDetection: boolean;
    useEnergySpikes: boolean;
    sensitivityMode: 'low' | 'medium' | 'high';
    // BPM sync options
    beatsToAnalyze: number;      // How many beats to collect before syncing to BPM
    bpmSyncEnabled: boolean;      // Enable constant BPM mode after detection
}

const DEFAULT_CONFIG: BeatDetectorConfig = {
    fftSize: 2048,
    // More granular frequency ranges
    subBassRange: [0, 4],        // Sub-bass (20-60Hz) - deep bass drops
    bassRange: [4, 12],          // Bass (60-200Hz) - kick drums
    lowMidRange: [12, 24],       // Low-mid (200-400Hz) - bass guitars, low synths
    midRange: [24, 48],          // Mid (400-1kHz) - snare, vocals
    highMidRange: [48, 96],      // High-mid (1-3kHz) - presence, hi-hats
    highRange: [96, 180],        // High (3-8kHz) - cymbals, brightness
    // Weights optimized for beat detection
    subBassWeight: 1.5,
    bassWeight: 2.0,             // Kick drums are crucial
    lowMidWeight: 1.0,
    midWeight: 1.4,              // Snares are important
    highMidWeight: 0.8,
    highWeight: 0.5,
    minBeatSeparation: 0.35,     // Allow faster beats (170 BPM max)
    energyThreshold: 1.4,        // Slightly lower for more sensitivity
    historySize: 50,             // ~1.2 seconds of history
    useOnsetDetection: true,
    useEnergySpikes: true,
    sensitivityMode: 'medium',
    beatsToAnalyze: 6,           // Collect 6 beats before switching to constant BPM
    bpmSyncEnabled: true,        // Enable constant BPM mode
};

// Sensitivity presets
const SENSITIVITY_PRESETS = {
    low: { energyThreshold: 1.8, minBeatSeparation: 0.5 },
    medium: { energyThreshold: 1.4, minBeatSeparation: 0.35 },
    high: { energyThreshold: 1.1, minBeatSeparation: 0.25 },
};

export async function detectBeatsFromVideo(
    videoEl: HTMLVideoElement,
    onBeat: (timeSec: number, intensity?: number) => void,
    config: Partial<BeatDetectorConfig> = {}
): Promise<() => void> {
    const baseCfg = { ...DEFAULT_CONFIG, ...config };

    // Apply sensitivity preset
    const sensitivitySettings = SENSITIVITY_PRESETS[baseCfg.sensitivityMode];
    const cfg = {
        ...baseCfg,
        energyThreshold: config.energyThreshold ?? sensitivitySettings.energyThreshold,
        minBeatSeparation: config.minBeatSeparation ?? sensitivitySettings.minBeatSeparation,
    };

    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const audioCtx: AudioContext = new AudioCtx();
    const src = audioCtx.createMediaElementSource(videoEl);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = cfg.fftSize;
    analyser.smoothingTimeConstant = 0.7; // Slightly less smoothing for faster response

    const binCount = analyser.frequencyBinCount;
    const freqData = new Float32Array(binCount);
    const prevFreqData = new Float32Array(binCount);
    const prevPrevFreqData = new Float32Array(binCount); // For second derivative

    src.connect(analyser);
    analyser.connect(audioCtx.destination);

    // History buffers for adaptive thresholding
    const fluxHistory: number[] = [];
    const energyHistory: number[] = [];
    const bassEnergyHistory: number[] = [];

    let lastBeatTime = -Infinity;
    let raf = 0;

    // Tempo estimation and constant BPM mode
    const beatTimes: number[] = [];
    let detectedBPM: number | null = null;
    let bpmLocked = false;
    let nextScheduledBeat: number | null = null;
    let bpmSyncStartTime: number | null = null;

    function calculateBPM(): number | null {
        if (beatTimes.length < cfg.beatsToAnalyze) return null;

        // Calculate intervals between consecutive beats
        const intervals: number[] = [];
        for (let i = 1; i < beatTimes.length; i++) {
            intervals.push(beatTimes[i]! - beatTimes[i - 1]!);
        }

        // Filter out outliers (intervals that are too short or too long)
        const validIntervals = intervals.filter(i => i >= 0.25 && i <= 2.0);
        if (validIntervals.length < 3) return null;

        // Use median for robustness
        const sorted = [...validIntervals].sort((a, b) => a - b);
        const medianInterval = sorted[Math.floor(sorted.length / 2)]!;

        // Convert to BPM
        const bpm = 60 / medianInterval;

        // Clamp to reasonable BPM range (60-200)
        if (bpm >= 60 && bpm <= 200) {
            return bpm;
        }

        // Try to find if it's double-time or half-time
        if (bpm > 200 && bpm <= 400) return bpm / 2;
        if (bpm >= 30 && bpm < 60) return bpm * 2;

        return null;
    }

    function dbToLinear(db: number): number {
        return Math.pow(10, db / 20);
    }

    function getEnergyInRange(startBin: number, endBin: number): number {
        let energy = 0;
        let count = 0;
        for (let i = startBin; i <= endBin && i < binCount; i++) {
            const amplitude = dbToLinear(freqData[i]!);
            energy += amplitude * amplitude; // RMS-style
            count++;
        }
        return count > 0 ? Math.sqrt(energy / count) : 0;
    }

    function calculateSpectralFlux(): { flux: number; bassFlux: number; intensity: number } {
        let totalFlux = 0;
        let bassFlux = 0;
        let totalEnergy = 0;

        const ranges = [
            { range: cfg.subBassRange, weight: cfg.subBassWeight, isBass: true },
            { range: cfg.bassRange, weight: cfg.bassWeight, isBass: true },
            { range: cfg.lowMidRange, weight: cfg.lowMidWeight, isBass: false },
            { range: cfg.midRange, weight: cfg.midWeight, isBass: false },
            { range: cfg.highMidRange, weight: cfg.highMidWeight, isBass: false },
            { range: cfg.highRange, weight: cfg.highWeight, isBass: false },
        ];

        for (const { range, weight, isBass } of ranges) {
            const bandFlux = calculateBandFlux(range[0], range[1]);
            const weightedFlux = bandFlux * weight;
            totalFlux += weightedFlux;

            if (isBass) {
                bassFlux += weightedFlux;
            }

            totalEnergy += getEnergyInRange(range[0], range[1]) * weight;
        }

        return { flux: totalFlux, bassFlux, intensity: totalEnergy };
    }

    function calculateBandFlux(startBin: number, endBin: number): number {
        let flux = 0;
        for (let i = startBin; i <= endBin && i < binCount; i++) {
            const cur = Math.max(0, dbToLinear(freqData[i]!));
            const prev = Math.max(0, dbToLinear(prevFreqData[i]!));
            const diff = cur - prev;

            // Only positive changes (onset detection)
            if (diff > 0) {
                flux += diff * diff; // Square for emphasis on large changes
            }
        }
        return Math.sqrt(flux);
    }

    function detectOnset(): boolean {
        if (!cfg.useOnsetDetection) return false;

        // Check for sudden increase followed by decrease (peak detection)
        let currentEnergy = 0;
        let prevEnergy = 0;
        let prevPrevEnergy = 0;

        for (let i = cfg.bassRange[0]; i <= cfg.midRange[1] && i < binCount; i++) {
            currentEnergy += dbToLinear(freqData[i]!);
            prevEnergy += dbToLinear(prevFreqData[i]!);
            prevPrevEnergy += dbToLinear(prevPrevFreqData[i]!);
        }

        // Peak detection: previous frame was higher than both neighbors
        const isPeak = prevEnergy > prevPrevEnergy * 1.1 && prevEnergy > currentEnergy * 0.95;
        return isPeak;
    }

    function getAdaptiveThreshold(history: number[]): number {
        if (history.length < 5) return Infinity;

        // Use median instead of mean for robustness
        const sorted = [...history].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;

        // Calculate MAD (Median Absolute Deviation) for robust std dev
        const deviations = history.map(v => Math.abs(v - median));
        const mad = [...deviations].sort((a, b) => a - b)[Math.floor(deviations.length / 2)]!;
        const robustStdDev = mad * 1.4826; // Scale factor for normal distribution

        return median + (cfg.energyThreshold * robustStdDev);
    }

    function isLocalMaximum(value: number, history: number[], windowSize: number = 3): boolean {
        if (history.length < windowSize) return false;
        const recent = history.slice(-windowSize);
        return value >= Math.max(...recent) * 0.98; // Allow small tolerance
    }

    function updateBPMEstimate(time: number) {
        beatTimes.push(time);

        // Keep only recent beats for BPM calculation
        while (beatTimes.length > 8) {
            beatTimes.shift();
        }
    }

    function analyze() {
        analyser.getFloatFrequencyData(freqData);

        const { flux, bassFlux, intensity } = calculateSpectralFlux();
        const bassEnergy = getEnergyInRange(cfg.subBassRange[0], cfg.bassRange[1]);

        // Update history buffers
        fluxHistory.push(flux);
        energyHistory.push(intensity);
        bassEnergyHistory.push(bassEnergy);

        if (fluxHistory.length > cfg.historySize) fluxHistory.shift();
        if (energyHistory.length > cfg.historySize) energyHistory.shift();
        if (bassEnergyHistory.length > cfg.historySize) bassEnergyHistory.shift();

        const time = videoEl.currentTime || 0;
        const timeSinceLastBeat = time - lastBeatTime;

        // Multiple detection methods
        let isBeat = false;
        let beatIntensity = 0;

        // Method 1: Spectral flux threshold
        const fluxThreshold = getAdaptiveThreshold(fluxHistory);
        const fluxBeat = flux > fluxThreshold &&
            isLocalMaximum(flux, fluxHistory) &&
            fluxHistory.length >= cfg.historySize * 0.3;

        // Method 2: Bass energy spike
        const bassThreshold = getAdaptiveThreshold(bassEnergyHistory);
        const bassBeat = cfg.useEnergySpikes &&
            bassEnergy > bassThreshold * 1.2 &&
            isLocalMaximum(bassEnergy, bassEnergyHistory, 4);

        // Method 3: Onset detection
        const onsetBeat = detectOnset();

        // ===== CONSTANT BPM MODE =====
        // After collecting enough beats, switch to constant BPM firing
        if (cfg.bpmSyncEnabled && bpmLocked && detectedBPM && nextScheduledBeat !== null) {
            // Check if we've reached the next scheduled beat
            if (time >= nextScheduledBeat) {
                const beatInterval = 60 / detectedBPM;
                lastBeatTime = nextScheduledBeat;
                nextScheduledBeat = nextScheduledBeat + beatInterval;

                try {
                    onBeat(time, 0.8); // Consistent intensity for synced beats
                } catch (e) {
                    console.error("Beat callback error:", e);
                }
            }

            // Shift frequency data history
            prevPrevFreqData.set(prevFreqData);
            prevFreqData.set(freqData);

            raf = requestAnimationFrame(analyze);
            return;
        }

        // ===== DETECTION MODE (before BPM lock) =====
        // Combine methods with voting
        const votes = [fluxBeat, bassBeat, onsetBeat].filter(Boolean).length;

        if (votes >= 1 && timeSinceLastBeat > cfg.minBeatSeparation) {
            // Stronger confidence with more votes
            if (votes >= 2 || (votes === 1 && timeSinceLastBeat > cfg.minBeatSeparation * 1.5)) {
                lastBeatTime = time;
                beatTimes.push(time);

                // Keep only recent beats for BPM calculation
                while (beatTimes.length > cfg.beatsToAnalyze + 2) {
                    beatTimes.shift();
                }

                // Calculate beat intensity (0-1)
                const fluxRatio = fluxHistory.length > 0 ?
                    flux / (Math.max(...fluxHistory) || 1) : 0.5;
                const beatIntensity = Math.min(1, Math.max(0, fluxRatio));

                try {
                    onBeat(time, beatIntensity);
                } catch (e) {
                    console.error("Beat callback error:", e);
                }

                // Try to lock BPM after enough beats
                if (cfg.bpmSyncEnabled && !bpmLocked && beatTimes.length >= cfg.beatsToAnalyze) {
                    const calculatedBPM = calculateBPM();
                    if (calculatedBPM) {
                        detectedBPM = calculatedBPM;
                        bpmLocked = true;
                        bpmSyncStartTime = time;

                        // Schedule next beat based on detected BPM
                        const beatInterval = 60 / detectedBPM;
                        nextScheduledBeat = time + beatInterval;

                        console.log(`BPM locked at ${Math.round(detectedBPM)} BPM`);
                    }
                }
            }
        }

        // Shift frequency data history
        prevPrevFreqData.set(prevFreqData);
        prevFreqData.set(freqData);

        raf = requestAnimationFrame(analyze);
    }

    try {
        await audioCtx.resume();
    } catch (e) {
        console.error("AudioContext resume failed:", e);
    }

    raf = requestAnimationFrame(analyze);

    return () => {
        cancelAnimationFrame(raf);
        try {
            src.disconnect();
            analyser.disconnect();
            audioCtx.close();
        } catch (e) {
            console.error("Cleanup error:", e);
        }
    };
}

export default detectBeatsFromVideo;
