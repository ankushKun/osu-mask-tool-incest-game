import "./index.css";
import { useEffect, useRef, useState, useCallback } from "react";

// IndexedDB utilities for video storage
const DB_NAME = 'VideoHistoryDB';
const DB_VERSION = 1;
const STORE_NAME = 'videos';

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
};

const saveVideoToDB = async (name: string, file: File): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put({ id: name, file, timestamp: Date.now(), size: file.size });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const getVideoFromDB = async (name: string): Promise<File | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(name);

    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.file : null);
    };
    request.onerror = () => reject(request.error);
  });
};

const clearVideosDB = async (): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

type Point = { x: number; y: number };
type Shape = {
  points: Point[];
  color: string;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
  image?: HTMLImageElement;
  centerX?: number;
  centerY?: number;
  size?: number;
};
type Explosion = { x: number; y: number; id: number };

type GamePhase = "idle" | "showing" | "drawing" | "result";
type ResultFeedback = { score: number; accuracy: number; distance: number; rating: string } | null;
type VideoHistoryItem = {
  name: string;
  timestamp: number;
  size?: number;
  file?: File;
  loading?: boolean;
};

function getPointSegmentDistance(p: Point, v: Point, w: Point) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

function isPointInPolygon(p: Point, polygon: Point[]) {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x, yi = polygon[i]!.y;
    const xj = polygon[j]!.x, yj = polygon[j]!.y;
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

export default function App() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [progress, setProgress] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [beats, setBeats] = useState<number[]>([]);
  const [flashCount, setFlashCount] = useState(0);
  const [currentShape, setCurrentShape] = useState<Shape | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>("idle");
  const [userDrawing, setUserDrawing] = useState<Point[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [beatIndex, setBeatIndex] = useState(0);
  const [resultFeedback, setResultFeedback] = useState<ResultFeedback>(null);
  const [shapesCompleted, setShapesCompleted] = useState(0);
  const [sensitivity, setSensitivity] = useState(5);
  const [isUnmasked, setIsUnmasked] = useState(false);
  const [cursorPos, setCursorPos] = useState<Point | null>(null);
  const [videoHistory, setVideoHistory] = useState<VideoHistoryItem[]>([]);
  const [currentVideoName, setCurrentVideoName] = useState<string>("");
  const [explosion, setExplosion] = useState<Explosion | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const gameRootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shapeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const drawTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastShapeRef = useRef<Shape | null>(null);
  const userDrawingRef = useRef<Point[]>([]);
  const phaseRef = useRef<GamePhase>("idle");
  const sensitivityRef = useRef(5);
  const unmaskTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const comedyMaskImageRef = useRef<HTMLImageElement | null>(null);
  const fileMapRef = useRef<Map<string, File>>(new Map()); // Store File objects in memory

  // Audio analysis refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const handleBeatRef = useRef<(beatIdx: number, pitch?: number) => void>(() => { });

  // Sync phase ref
  useEffect(() => {
    phaseRef.current = gamePhase;
  }, [gamePhase]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  const generateRandomShape = useCallback((pitch?: number): Shape => {
    const canvas = canvasRef.current;
    if (!canvas) return { points: [], color: "#fff", boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };

    const width = canvas.width;
    const height = canvas.height;

    // Random center point with better margins
    const margin = 150;

    const centerX = Math.random() * (width - margin * 2) + margin;
    const centerY = Math.random() * (height - margin * 2) + margin;

    // Size varies
    const size = 120 + Math.random() * 60;

    // Generate outline points for collision detection (circular approximation)
    const points: Point[] = [];
    const numPoints = 32;
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      points.push({
        x: centerX + Math.cos(angle) * size,
        y: centerY + Math.sin(angle) * size,
      });
    }

    // Calculate bounding box
    const boundingBox = {
      minX: centerX - size,
      minY: centerY - size,
      maxX: centerX + size,
      maxY: centerY + size,
    };

    const colors = ["#ff0066", "#00ffff", "#ffff00", "#00ff66", "#ff6600", "#ff00ff"];
    let color;
    if (pitch !== undefined) {
      // Map pitch to color to reinforce the note feeling
      const colorIdx = Math.floor(pitch * colors.length);
      color = colors[Math.min(colors.length - 1, Math.max(0, colorIdx))]!;
    } else {
      color = colors[Math.floor(Math.random() * colors.length)]!;
    }

    return {
      points,
      color,
      boundingBox,
      image: comedyMaskImageRef.current || undefined,
      centerX,
      centerY,
      size,
    };
  }, []);

  const drawShape = (shape: Shape, ctx: CanvasRenderingContext2D, alpha = 1) => {
    if (!shape.image || !shape.centerX || !shape.centerY || !shape.size) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Apply color tint and glow
    ctx.shadowBlur = 40;
    ctx.shadowColor = shape.color;

    // Position and size the mask
    const drawSize = shape.size * 2;
    const x = shape.centerX - shape.size;
    const y = shape.centerY - shape.size;

    // Apply color filter by drawing with blend mode
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(shape.image, x, y, drawSize, drawSize);

    // Add colored glow overlay
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = shape.color;
    ctx.globalAlpha = alpha * 0.3;
    ctx.fillRect(x, y, drawSize, drawSize);

    ctx.restore();
  };

  // Draw hint outline during drawing phase
  const drawShapeHint = (shape: Shape, ctx: CanvasRenderingContext2D) => {
    if (!shape.image || !shape.centerX || !shape.centerY || !shape.size) return;

    ctx.save();
    ctx.globalAlpha = 0.2;

    // Draw faint version of the mask as hint
    const drawSize = shape.size * 2;
    const x = shape.centerX - shape.size;
    const y = shape.centerY - shape.size;

    ctx.drawImage(shape.image, x, y, drawSize, drawSize);

    // Add dashed circular outline
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = 3;
    ctx.setLineDash([15, 15]);
    ctx.beginPath();
    ctx.arc(shape.centerX, shape.centerY, shape.size, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  };

  const drawUserPath = (points: Point[], ctx: CanvasRenderingContext2D) => {
    if (points.length < 2) return;

    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 24;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowBlur = 20;
    ctx.shadowColor = "#ffffff";

    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i]!.x, points[i]!.y);
    }

    ctx.stroke();
    ctx.restore();
  };

  const drawLaserTrail = (points: Point[], ctx: CanvasRenderingContext2D) => {
    if (points.length < 1) return;

    const trailLength = 25; // Length of the fading trail
    const lastPoint = points[points.length - 1]!;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Draw the cursor head (Laser point)
    ctx.shadowBlur = 20;
    ctx.shadowColor = "#00ffff";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2);
    ctx.fill();

    // Draw the fading trail
    const startIndex = Math.max(0, points.length - trailLength);

    for (let i = startIndex; i < points.length - 1; i++) {
      const p1 = points[i]!;
      const p2 = points[i + 1]!;

      // Calculate opacity based on index (newer = more opaque)
      const opacity = (i - startIndex) / (points.length - 1 - startIndex);

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);

      // Outer glow (Bluish)
      ctx.shadowBlur = 15;
      ctx.shadowColor = `rgba(0, 200, 255, ${opacity})`;
      ctx.strokeStyle = `rgba(100, 220, 255, ${opacity})`;
      ctx.lineWidth = 8 * opacity + 2;
      ctx.stroke();

      // Inner core (White)
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
      ctx.lineWidth = 3 * opacity + 1;
      ctx.stroke();
    }

    ctx.restore();
  };

  // Calculate score based on overlap area and center distance
  const calculateScore = useCallback((drawn: Point[], target: Shape): { score: number; accuracy: number; distance: number; rating: string } => {
    if (drawn.length < 5 || target.points.length < 3) {
      return { score: -50, accuracy: 0, distance: 0, rating: "MISS" };
    }

    // 1. Check for points outside the shape (Penalty)
    let maxOutsideDist = 0;
    let totalError = 0;
    const tolerance = 20; // Allow 20px margin of error for "tracing" the line

    for (const p of drawn) {
      let minD = Infinity;
      for (let i = 0; i < target.points.length; i++) {
        const p1 = target.points[i]!;
        const p2 = target.points[(i + 1) % target.points.length]!;
        const d = getPointSegmentDistance(p, p1, p2);
        if (d < minD) minD = d;
      }
      totalError += minD;

      const inside = isPointInPolygon(p, target.points);
      if (!inside && minD > tolerance) {
        maxOutsideDist = Math.max(maxOutsideDist, minD - tolerance);
      }
    }
    const avgError = totalError / drawn.length;

    // 2. Calculate Completeness (Angular coverage)
    // Find centroid of target
    let cx = 0, cy = 0;
    for (const p of target.points) { cx += p.x; cy += p.y; }
    cx /= target.points.length;
    cy /= target.points.length;

    // Check how many angular sectors are covered
    const sectors = 24; // 15-degree sectors
    const hits = new Set<number>();
    for (const p of drawn) {
      const angle = Math.atan2(p.y - cy, p.x - cx);
      const sector = Math.floor((angle + Math.PI) / (2 * Math.PI) * sectors);
      hits.add(sector);
    }
    const coverage = Math.min(1, hits.size / (sectors * 0.85)); // Allow small gaps

    // 3. Final Scoring Logic
    let finalScoreVal = 0;
    let rating = "MISS";
    let accuracyPercent = 0;

    if (maxOutsideDist > 0) {
      // Negative score if outside: -1 to -100 based on distance
      // Max penalty at 150px outside
      const penalty = Math.min(100, (maxOutsideDist / 150) * 100);
      finalScoreVal = -Math.round(penalty);
      rating = "MISS";
    } else {
      // Positive score if inside: 0 to 100 based on coverage
      finalScoreVal = Math.round(coverage * 100);
      accuracyPercent = Math.round(Math.max(0, 1 - avgError / 100) * 100); // Visual accuracy stat

      if (finalScoreVal >= 95) rating = "PERFECT";
      else if (finalScoreVal >= 80) rating = "GREAT";
      else if (finalScoreVal >= 50) rating = "GOOD";
      else if (finalScoreVal > 0) rating = "OK";
    }

    return {
      score: finalScoreVal,
      accuracy: accuracyPercent,
      distance: Math.round(avgError),
      rating
    };
  }, []);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  // End drawing phase and calculate score
  const endDrawingPhase = useCallback(() => {
    if (phaseRef.current !== "drawing") return;

    if (drawTimerRef.current) {
      clearInterval(drawTimerRef.current);
      drawTimerRef.current = null;
    }

    const shape = lastShapeRef.current;
    const drawn = userDrawingRef.current;

    if (shape) {
      const result = calculateScore(drawn, shape);

      if (result.rating === "MISS") {
        setScore(prev => Math.max(0, prev + result.score)); // Allow score to drop
        setCombo(0);
        setResultFeedback(result);
      } else {
        const comboBonus = Math.floor(combo * 2); // Reduced combo bonus for 100-scale
        const finalScore = result.score + comboBonus;
        setScore(prev => prev + finalScore);
        setCombo(prev => {
          const newCombo = prev + 1;
          setMaxCombo(max => Math.max(max, newCombo));
          return newCombo;
        });
        setResultFeedback({ score: finalScore, accuracy: result.accuracy, distance: result.distance, rating: result.rating });
        setShapesCompleted(prev => prev + 1);

        // Unmasking Logic: If score > 50, reveal the video
        if (result.score > 50) {
          setIsUnmasked(true);
          if (unmaskTimeoutRef.current) clearTimeout(unmaskTimeoutRef.current);
          unmaskTimeoutRef.current = setTimeout(() => {
            setIsUnmasked(false);
          }, 3000); // Reveal for 3 seconds

          // Trigger explosion effect
          if (shape.centerX && shape.centerY) {
            setExplosion({ x: shape.centerX, y: shape.centerY, id: Date.now() });
            setTimeout(() => setExplosion(null), 600);
          }
        }
      }
    } else {
      setResultFeedback({ score: 0, accuracy: 0, distance: 0, rating: "MISS" });
    }

    setGamePhase("result");

    // Show result feedback briefly, then show the correct shape
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx && shape) {
      clearCanvas();
      // Draw the correct shape as reference
      drawShape(shape, ctx, 0.5);
      // Draw user's attempt on top
      if (drawn.length > 1) {
        drawUserPath(drawn, ctx);
      }
    }

    // Clear result after very short delay (next beat will handle it anyway)
    setTimeout(() => {
      if (phaseRef.current === "result") {
        setResultFeedback(null);
        setGamePhase("idle");
        clearCanvas();
      }
    }, 600);
  }, [combo, calculateScore]);

  const handleBeat = useCallback((beatIdx: number, pitch?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear any pending timeouts
    if (shapeTimeoutRef.current) {
      clearTimeout(shapeTimeoutRef.current);
      shapeTimeoutRef.current = null;
    }

    const currentPhase = phaseRef.current;

    // If we were drawing, evaluate first
    if (currentPhase === "drawing") {
      endDrawingPhase();
    }

    // Generate and show new shape as a brief BLIP
    const shape = generateRandomShape(pitch);
    lastShapeRef.current = shape;
    setCurrentShape(shape);
    setGamePhase("showing");

    clearCanvas();
    drawShape(shape, ctx);

    // Clear previous drawing immediately
    setUserDrawing([]);
    userDrawingRef.current = [];

    // Shape disappears after a brief moment (600ms), then drawing starts
    shapeTimeoutRef.current = setTimeout(() => {
      setGamePhase("drawing");
      setResultFeedback(null);

      clearCanvas();
      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Show hint immediately so user knows what to draw
      drawShapeHint(shape, ctx);

      // Redraw user path if they started tracing during "showing" phase
      if (userDrawingRef.current.length > 0) {
        drawLaserTrail(userDrawingRef.current, ctx);
      }
    }, 600);
  }, [generateRandomShape, endDrawingPhase]);

  // Keep handleBeatRef updated to avoid stale closures in the audio loop
  useEffect(() => {
    handleBeatRef.current = handleBeat;
  }, [handleBeat]);

  const setupAudioAnalysis = () => {
    const video = videoRef.current;
    if (!video) return;

    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    if (!sourceNodeRef.current) {
      try {
        sourceNodeRef.current = ctx.createMediaElementSource(video);
        analyserRef.current = ctx.createAnalyser();
        analyserRef.current.fftSize = 1024;
        analyserRef.current.smoothingTimeConstant = 0.8;
        sourceNodeRef.current.connect(analyserRef.current);
        analyserRef.current.connect(ctx.destination);
      } catch (e) {
        console.error("Audio setup failed", e);
      }
    }

    if (!analyserRef.current) return;
    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    let lastBeatTime = 0;
    const minBeatSeparation = 0.25; // Faster response (250ms)
    const energyHistory: number[] = [];

    const analyze = () => {
      if (video.paused || video.ended) {
        animationFrameRef.current = requestAnimationFrame(analyze);
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      // Calculate energy and dominant frequency
      let sum = 0;
      let maxVal = 0;
      let maxIndex = 0;

      // Focus on audible range for melody (bins 2 to ~150 for 1024 FFT at 44.1k is ~86Hz to ~6.4kHz)
      const startBin = 2;
      const endBin = Math.min(bufferLength, 150);

      for (let i = startBin; i < endBin; i++) {
        const val = dataArray[i]!;
        sum += val;
        if (val > maxVal) {
          maxVal = val;
          maxIndex = i;
        }
      }

      const average = sum / (endBin - startBin);

      // Calculate local average from history BEFORE adding current
      const localAvg = energyHistory.length ? energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length : 0;

      // Dynamic threshold based on sensitivity (1-10)
      // Higher sensitivity (10) -> Lower threshold (1.05) -> More beats
      // Lower sensitivity (1) -> Higher threshold (1.5) -> Fewer beats
      const threshold = 1.0 + (11 - sensitivityRef.current) * 0.05;
      const now = ctx.currentTime;

      // Trigger if energy spikes above local average
      // Also add a failsafe: if no beat for 3 seconds and there is sound, trigger one
      const timeSinceBeat = now - lastBeatTime;
      const isBeat = average > localAvg * threshold && average > 25 && (timeSinceBeat > minBeatSeparation);
      const isFailsafe = timeSinceBeat > 3.0 && average > 25;

      if (isBeat || isFailsafe) {
        lastBeatTime = now;

        // Calculate pitch (0-1) based on dominant frequency bin
        const pitch = (maxIndex - startBin) / (endBin - startBin);
        const clampedPitch = Math.max(0, Math.min(1, pitch));

        // Trigger beat
        setBeatIndex((idx) => {
          const newIdx = idx + 1;
          handleBeatRef.current(newIdx, clampedPitch);
          return newIdx;
        });
        setFlashCount(c => c + 1);
        setBeats(b => [...b, video.currentTime]);
      }

      // Update history
      energyHistory.push(average);
      if (energyHistory.length > 45) energyHistory.shift(); // Increased buffer

      animationFrameRef.current = requestAnimationFrame(analyze);
    };

    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    analyze();
  };

  const addToHistory = async (name: string, file: File) => {
    try {
      // Save to IndexedDB
      await saveVideoToDB(name, file);
    } catch (e) {
      console.error('Failed to save video to IndexedDB', e);
    }

    const newItem: VideoHistoryItem = {
      name,
      timestamp: Date.now(),
      size: file.size,
      file,
    };

    setVideoHistory(prev => {
      // Remove duplicate if exists (same name)
      const filtered = prev.filter(item => item.name !== name);
      const updated = [newItem, ...filtered].slice(0, 10);

      // Save metadata to localStorage
      try {
        const metadata = updated.map(({ name, timestamp, size }) => ({ name, timestamp, size }));
        localStorage.setItem('videoHistory', JSON.stringify(metadata));
      } catch (e) {
        console.error('Failed to save video history metadata', e);
      }

      return updated;
    });
  };

  const loadFromHistory = async (item: VideoHistoryItem) => {
    // Check if we have the File object
    let file = item.file;

    if (!file) {
      // Try to load from IndexedDB
      try {
        file = await getVideoFromDB(item.name);
        if (!file) {
          console.error('File not found in IndexedDB');
          return;
        }

        // Update history with loaded file
        setVideoHistory(prev => prev.map(h =>
          h.name === item.name ? { ...h, file } : h
        ));
      } catch (e) {
        console.error('Failed to load file from IndexedDB', e);
        return;
      }
    }

    if (urlRef.current) URL.revokeObjectURL(urlRef.current);

    // Create blob URL from File object
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    setVideoUrl(url);
    setCurrentVideoName(item.name);
    setIsPlaying(false);
    setBeatIndex(0);
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setShapesCompleted(0);

    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
  };

  const clearHistory = async () => {
    setVideoHistory([]);
    fileMapRef.current.clear();

    try {
      localStorage.removeItem('videoHistory');
      await clearVideosDB();
    } catch (e) {
      console.error('Failed to clear history', e);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setVideoUrl(url);
      setCurrentVideoName(file.name);
      setIsPlaying(false);
      setBeatIndex(0);
      setScore(0);
      setCombo(0);
      setMaxCombo(0);
      setShapesCompleted(0);

      // Add to history with File object
      addToHistory(file.name, file);
    }
  };

  const handleStart = async () => {
    if (!videoRef.current) return;
    try {
      await videoRef.current.play();
      setIsPlaying(true);
      setScore(0);
      setCombo(0);
      setMaxCombo(0);
      setShapesCompleted(0);
      setGamePhase("idle");

      setBeats([]);

      // Start audio analysis
      setupAudioAnalysis();

    } catch (err) {
      console.warn("play failed", err);
    }
  };

  // Load video history from localStorage and IndexedDB
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const stored = localStorage.getItem('videoHistory');
        if (stored) {
          const metadata = JSON.parse(stored) as Array<{ name: string; timestamp: number; size?: number }>;

          // Load files from IndexedDB
          const historyWithFiles = await Promise.all(
            metadata.slice(0, 10).map(async (item) => {
              try {
                const file = await getVideoFromDB(item.name);
                return {
                  ...item,
                  file: file || undefined,
                };
              } catch (e) {
                console.error(`Failed to load video ${item.name} from DB`, e);
                return item;
              }
            })
          );

          setVideoHistory(historyWithFiles);
        }
      } catch (e) {
        console.error('Failed to load video history', e);
      }
    };

    loadHistory();
  }, []);

  // Load comedy mask image
  useEffect(() => {
    const img = new Image();
    // Theatrical comedy mask SVG as data URL
    img.src = `data:image/svg+xml,${encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 220">
        <defs>
          <filter id="shadow">
            <feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity="0.4"/>
          </filter>
        </defs>
        
        <!-- Theatrical mask outline with curved top -->
        <path d="M 100 10 
                 Q 65 8 45 30
                 Q 25 50 20 75
                 L 20 130
                 Q 20 165 35 185
                 Q 50 205 75 210
                 Q 87.5 212 100 212
                 Q 112.5 212 125 210
                 Q 150 205 165 185
                 Q 180 165 180 130
                 L 180 75
                 Q 175 50 155 30
                 Q 135 8 100 10 Z" 
              fill="white" stroke="black" stroke-width="4" filter="url(#shadow)"/>
        
        <!-- Left eye area - squinted happy eye with wrinkles -->
        <path d="M 50 75 Q 70 68 85 75" fill="black" stroke="black" stroke-width="3"/>
        <path d="M 48 65 Q 65 60 80 65" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M 46 57 Q 63 52 78 57" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"/>
        
        <!-- Right eye area - squinted happy eye with wrinkles -->
        <path d="M 115 75 Q 130 68 150 75" fill="black" stroke="black" stroke-width="3"/>
        <path d="M 120 65 Q 135 60 152 65" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M 122 57 Q 137 52 154 57" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"/>
        
        <!-- Nose bridge and nose -->
        <path d="M 100 75 L 100 115" fill="none" stroke="black" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="100" cy="120" rx="12" ry="16" fill="white" stroke="black" stroke-width="3"/>
        <path d="M 88 120 Q 88 125 92 127" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"/>
        <path d="M 112 120 Q 112 125 108 127" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"/>
        
        <!-- Large theatrical smile -->
        <path d="M 55 145 
                 Q 65 165 80 175
                 Q 90 182 100 183
                 Q 110 182 120 175
                 Q 135 165 145 145
                 Q 135 175 120 188
                 Q 110 195 100 196
                 Q 90 195 80 188
                 Q 65 175 55 145 Z" 
              fill="black" stroke="black" stroke-width="3"/>
        
        <!-- Smile highlight/teeth -->
        <ellipse cx="100" cy="165" rx="35" ry="10" fill="white" opacity="0.9"/>
        
        <!-- Cheek laugh lines - left -->
        <path d="M 45 125 Q 50 135 52 147" fill="none" stroke="black" stroke-width="3" stroke-linecap="round"/>
        <path d="M 38 132 Q 42 142 44 155" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round"/>
        
        <!-- Cheek laugh lines - right -->
        <path d="M 155 125 Q 150 135 148 147" fill="none" stroke="black" stroke-width="3" stroke-linecap="round"/>
        <path d="M 162 132 Q 158 142 156 155" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    `)}`;

    img.onload = () => {
      comedyMaskImageRef.current = img;
    };

    img.onerror = () => {
      console.error('Failed to load comedy mask image');
    };
  }, []);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      if (shapeTimeoutRef.current) clearTimeout(shapeTimeoutRef.current);
      if (drawTimerRef.current) clearInterval(drawTimerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (unmaskTimeoutRef.current) clearTimeout(unmaskTimeoutRef.current);
    };
  }, []);

  // Keyboard controls: Spacebar to skip, Z/X for drawing (osu! style)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Spacebar to skip forward
      if (e.code === "Space" && isPlaying) {
        e.preventDefault();
        const video = videoRef.current;
        if (video) {
          video.currentTime = Math.min(video.duration, video.currentTime + 10);
          setGamePhase("idle");
          setUserDrawing([]);
          clearCanvas();
          if (shapeTimeoutRef.current) {
            clearTimeout(shapeTimeoutRef.current);
            shapeTimeoutRef.current = null;
          }
        }
        setFlashCount((c) => c + 1);
        return;
      }

      // Z or X key to start drawing (osu! style)
      if ((e.code === "KeyZ" || e.code === "KeyX") && !e.repeat) {
        if (gamePhase !== "drawing" && gamePhase !== "showing") return;
        e.preventDefault();

        const coords = getCanvasCoords();
        if (!coords) return;

        setIsDrawing(true);
        const newDrawing = [coords];
        setUserDrawing(newDrawing);
        userDrawingRef.current = newDrawing;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Z or X key release to end drawing
      if (e.code === "KeyZ" || e.code === "KeyX") {
        if (gamePhase !== "drawing" && gamePhase !== "showing") return;
        e.preventDefault();

        setIsDrawing(false);

        // Immediately evaluate and end drawing phase
        if (gamePhase === "drawing" && userDrawingRef.current.length > 15) {
          endDrawingPhase();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isPlaying, gamePhase, endDrawingPhase]);

  // Get canvas coordinates from mouse/touch event or current cursor
  const getCanvasCoords = (e?: React.MouseEvent | React.TouchEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();

    if (!e) {
      // Use stored cursor position for keyboard events
      return cursorPos;
    }

    if ('touches' in e) {
      const touch = e.touches[0];
      if (!touch) return null;
      return {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    } else {
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }
  };

  // Canvas drawing handlers
  const handleDrawStart = (e: React.MouseEvent | React.TouchEvent) => {
    if (gamePhase !== "drawing" && gamePhase !== "showing") return;
    e.preventDefault();
    setIsDrawing(true);

    const coords = getCanvasCoords(e);
    if (!coords) return;
    const newDrawing = [coords];
    setUserDrawing(newDrawing);
    userDrawingRef.current = newDrawing;
  };

  const handleDrawMove = (e: React.MouseEvent | React.TouchEvent) => {
    const coords = getCanvasCoords(e);
    if (coords) {
      setCursorPos(coords); // Always track cursor position
    }

    if (!isDrawing || (gamePhase !== "drawing" && gamePhase !== "showing")) return;
    e.preventDefault();

    if (!coords) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    setUserDrawing((prev) => {
      const updated = [...prev, coords];
      userDrawingRef.current = updated;

      // Redraw
      const ctx = canvas.getContext("2d");
      if (ctx) {
        clearCanvas();

        if (phaseRef.current === "showing" && lastShapeRef.current) {
          drawShape(lastShapeRef.current, ctx);
        } else {
          ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          if (lastShapeRef.current) {
            drawShapeHint(lastShapeRef.current, ctx);
          }
        }
        drawLaserTrail(updated, ctx);
      }

      return updated;
    });
  };

  const handleDrawEnd = useCallback(() => {
    if (gamePhase !== "drawing" && gamePhase !== "showing") return;
    setIsDrawing(false);

    // Immediately evaluate and end drawing phase when user lifts finger/mouse
    // Only if they've drawn something substantial
    if (gamePhase === "drawing" && userDrawingRef.current.length > 15) {
      endDrawingPhase();
    }
  }, [gamePhase, endDrawingPhase]);

  // Track mouse position for keyboard drawing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      setCursorPos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });

      // If currently drawing with keyboard, add points
      if (isDrawing && (gamePhase === "drawing" || gamePhase === "showing")) {
        const coords = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };

        setUserDrawing((prev) => {
          const updated = [...prev, coords];
          userDrawingRef.current = updated;

          // Redraw
          const ctx = canvas.getContext("2d");
          if (ctx) {
            clearCanvas();

            if (phaseRef.current === "showing" && lastShapeRef.current) {
              drawShape(lastShapeRef.current, ctx);
            } else {
              ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              if (lastShapeRef.current) {
                drawShapeHint(lastShapeRef.current, ctx);
              }
            }
            drawLaserTrail(updated, ctx);
          }

          return updated;
        });
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [isDrawing, gamePhase]);

  // Resize canvas to match video
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const updateCanvasSize = () => {
      const rect = video.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    updateCanvasSize();
    video.addEventListener("loadedmetadata", updateCanvasSize);
    window.addEventListener("resize", updateCanvasSize);

    return () => {
      video.removeEventListener("loadedmetadata", updateCanvasSize);
      window.removeEventListener("resize", updateCanvasSize);
    };
  }, [videoUrl]);

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !v.duration || Number.isNaN(v.duration)) {
      setProgress(0);
      setTimeLeft(null);
      return;
    }
    setProgress(Math.min(1, Math.max(0, v.currentTime / v.duration)));
    setTimeLeft(Math.max(0, v.duration - v.currentTime));
  };

  // Clear beats when a new video is loaded
  useEffect(() => {
    setBeats([]);
    setBeatIndex(0);
    setCurrentShape(null);
    setGamePhase("idle");
    setUserDrawing([]);
    clearCanvas();
    if (drawTimerRef.current) clearInterval(drawTimerRef.current);
  }, [videoUrl]);

  const formatTime = (seconds: number) => {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="game-root" ref={gameRootRef}>
      <style>{`
        @keyframes explodeRing {
          0% { transform: scale(0.5); opacity: 1; border-width: 10px; }
          100% { transform: scale(2.5); opacity: 0; border-width: 0px; }
        }
        @keyframes explodeFlash {
          0% { transform: scale(0); opacity: 1; }
          50% { transform: scale(1.5); opacity: 0.8; }
          100% { transform: scale(2); opacity: 0; }
        }
        .explosion-container {
          position: absolute;
          pointer-events: none;
          z-index: 100;
          width: 0; height: 0;
        }
        .explosion-ring {
          position: absolute;
          top: -50px; left: -50px; width: 100px; height: 100px;
          border-radius: 50%;
          border: 5px solid #fff;
          box-shadow: 0 0 20px #fff, 0 0 40px #ff00ff;
          animation: explodeRing 0.6s ease-out forwards;
        }
        .explosion-flash {
          position: absolute;
          top: -50px; left: -50px; width: 100px; height: 100px;
          border-radius: 50%;
          background: radial-gradient(circle, #fff 0%, rgba(255,255,255,0) 70%);
          animation: explodeFlash 0.4s ease-out forwards;
        }
      `}</style>
      <div className="scanlines" />
      <input
        id="file"
        className="file-input"
        type="file"
        accept="video/*, .mp4"
        onChange={handleFileChange}
      />

      <video
        ref={videoRef}
        className="game-video"
        src={videoUrl || undefined}
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
      />

      {/* Mask Overlay - obscures video until unmasked */}
      <div className={`video-overlay ${isUnmasked ? 'unmasked' : ''}`} />

      <canvas
        ref={canvasRef}
        className="game-canvas"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: (gamePhase === "drawing" || gamePhase === "showing") ? "auto" : "none",
          cursor: isDrawing ? "none" : ((gamePhase === "drawing" || gamePhase === "showing") ? "crosshair" : "default"),
          touchAction: "none",
        }}
        onMouseDown={handleDrawStart}
        onMouseMove={handleDrawMove}
        onMouseUp={handleDrawEnd}
        onMouseLeave={handleDrawEnd}
        onTouchStart={handleDrawStart}
        onTouchMove={handleDrawMove}
        onTouchEnd={handleDrawEnd}
        onTouchCancel={handleDrawEnd}
      />

      {explosion && (
        <div className="explosion-container" style={{ left: explosion.x, top: explosion.y }}>
          <div className="explosion-ring" />
          <div className="explosion-flash" />
        </div>
      )}

      <div className="progress-bar" aria-hidden>
        <div
          className="progress-fill"
          style={{ width: `${Math.round(progress * 10000) / 100}%` }}
        />
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {(videoRef.current?.duration ? beats : []).map((b, i) => {
            const dur = videoRef.current?.duration || 1;
            const left = Math.min(100, Math.max(0, (b / dur) * 100));
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: "rgba(255, 255, 255, 0.5)",
                  opacity: 0.5,
                  transform: "translateX(-1px)",
                }}
              />
            );
          })}
        </div>
      </div>

      <div className="hud">
        {/* render a transient fullscreen flash on each beat */}
        {flashCount > 0 ? <div key={flashCount} className="beat-flash" /> : null}

        {/* Phase indicator */}
        {gamePhase === "showing" && (
          <div className="phase-indicator showing">
            <div className="phase-icon">👁</div>
          </div>
        )}
        {gamePhase === "drawing" && (
          <div className="phase-indicator drawing">
            <div className="phase-icon">✏️</div>
          </div>
        )}

        {/* Result feedback */}
        {resultFeedback && (
          <div className="result-feedback">
            <div className="result-score">
              <div style={{ fontSize: '0.4em', letterSpacing: '4px', color: resultFeedback.rating === 'MISS' ? '#ff3333' : '#ffd700' }}>{resultFeedback.rating}</div>
              {resultFeedback.score > 0 ? '+' : ''}{resultFeedback.score}
            </div>
            <div className="result-details">
              <span className="overlap-stat">Accuracy: {resultFeedback.accuracy}%</span>
              <span className="distance-stat">Avg Error: {resultFeedback.distance}px</span>
            </div>
          </div>
        )}

        <div className="hud-top">
          <div className="score-container">
            <div className="score"><span>Score: {score.toLocaleString()}</span></div>
            <div key={combo} className={`combo ${combo > 0 ? 'visible' : ''}`}>
              {combo > 0 ? `${combo}x` : ''}
            </div>
          </div>
          <div className="stats-container">
            <div>Shapes: {shapesCompleted}</div>
            <div>Max: {maxCombo}x</div>
          </div>
          <div className="timer">
            <span>{timeLeft !== null ? formatTime(timeLeft) : "--:--"}</span>
          </div>
        </div>

        <div className="center-controls">
          <div className="controls">
            {!videoUrl ? (
              <div className="menu-screen">
                <div className="menu-title">DISCO</div>
                <label className="btn" htmlFor="file">
                  Load Video
                </label>

                {videoHistory.length > 0 && (
                  <div className="video-history">
                    <div className="history-header">
                      <span className="history-title">Recent Videos</span>
                      <button
                        className="history-clear"
                        onClick={clearHistory}
                        title="Clear history"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="history-list">
                      {videoHistory.map((item, idx) => {
                        const isAvailable = !!item.file;
                        return (
                          <button
                            key={`${item.name}-${item.timestamp}`}
                            className={`history-item ${!isAvailable ? 'unavailable' : ''}`}
                            onClick={() => isAvailable && loadFromHistory(item)}
                            disabled={!isAvailable}
                            title={!isAvailable ? 'File not available - please reload' : undefined}
                          >
                            <div className="history-item-number">{idx + 1}</div>
                            <div className="history-item-content">
                              <div className="history-item-name">
                                {item.name}
                                {!isAvailable && <span className="unavailable-badge">⚠</span>}
                              </div>
                              <div className="history-item-date">
                                {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : !isPlaying ? (
              <div className="start-menu">
                <div className="sensitivity-control">
                  <label className="sensitivity-label">Intensity: {sensitivity}</label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                    className="sensitivity-slider"
                  />
                </div>
                <button className="btn" onClick={handleStart}>
                  Start Game
                </button>
              </div>
            ) : gamePhase === "idle" && shapesCompleted === 0 ? (
              <div className="waiting-hint">
                <div className="waiting-text">Waiting for beat...</div>
                <div className="waiting-subtext">SPACE to skip ahead</div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="hud-bottom" />
      </div>
    </div>
  );
}
