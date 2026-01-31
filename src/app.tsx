import "./index.css";
import { useEffect, useRef, useState, useCallback } from "react";
import detectBeatsFromVideo from "./lib/detectBeats";

type Point = { x: number; y: number };
type Shape = {
  points: Point[];
  color: string;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
};

type GamePhase = "idle" | "showing" | "drawing" | "result";
type ResultFeedback = { score: number; overlap: number; distance: number } | null;

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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const stopDetectRef = useRef<(() => void) | null>(null);
  const gameRootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shapeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const drawTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastShapeRef = useRef<Shape | null>(null);
  const userDrawingRef = useRef<Point[]>([]);
  const phaseRef = useRef<GamePhase>("idle");

  // Sync phase ref
  useEffect(() => {
    phaseRef.current = gamePhase;
  }, [gamePhase]);

  const generateRandomShape = useCallback((): Shape => {
    const canvas = canvasRef.current;
    if (!canvas) return { points: [], color: "#fff", boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };

    const width = canvas.width;
    const height = canvas.height;

    // Random center point with better margins
    const margin = 150;
    const centerX = Math.random() * (width - margin * 2) + margin;
    const centerY = Math.random() * (height - margin * 2) + margin;

    // Generate organic blob shape - larger and more visible
    const points: Point[] = [];
    const numPoints = 6 + Math.floor(Math.random() * 4); // 6-9 points (simpler shapes)
    const baseRadius = 80 + Math.random() * 60; // 80-140px radius (larger)

    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const radiusVariation = 0.75 + Math.random() * 0.5; // Less variation for clearer shapes
      const radius = baseRadius * radiusVariation;

      points.push({
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });
    }

    // Calculate bounding box
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const boundingBox = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };

    const colors = ["#ff0066", "#00ffff", "#ffff00", "#00ff66", "#ff6600", "#ff00ff"];
    return {
      points,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      boundingBox,
    };
  }, []);

  const drawShape = (shape: Shape, ctx: CanvasRenderingContext2D, alpha = 1) => {
    if (shape.points.length < 3) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowBlur = 40;
    ctx.shadowColor = shape.color;

    ctx.beginPath();
    ctx.moveTo(shape.points[0]!.x, shape.points[0]!.y);

    // Draw smooth curves through all points
    for (let i = 1; i < shape.points.length; i++) {
      const xc = (shape.points[i]!.x + shape.points[i - 1]!.x) / 2;
      const yc = (shape.points[i]!.y + shape.points[i - 1]!.y) / 2;
      ctx.quadraticCurveTo(shape.points[i - 1]!.x, shape.points[i - 1]!.y, xc, yc);
    }

    // Close the shape back to start
    ctx.quadraticCurveTo(
      shape.points[shape.points.length - 1]!.x,
      shape.points[shape.points.length - 1]!.y,
      shape.points[0]!.x,
      shape.points[0]!.y
    );

    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // Draw hint outline during drawing phase
  const drawShapeHint = (shape: Shape, ctx: CanvasRenderingContext2D) => {
    if (shape.points.length < 3) return;

    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);

    ctx.beginPath();
    ctx.moveTo(shape.points[0]!.x, shape.points[0]!.y);

    for (let i = 1; i < shape.points.length; i++) {
      const xc = (shape.points[i]!.x + shape.points[i - 1]!.x) / 2;
      const yc = (shape.points[i]!.y + shape.points[i - 1]!.y) / 2;
      ctx.quadraticCurveTo(shape.points[i - 1]!.x, shape.points[i - 1]!.y, xc, yc);
    }

    ctx.quadraticCurveTo(
      shape.points[shape.points.length - 1]!.x,
      shape.points[shape.points.length - 1]!.y,
      shape.points[0]!.x,
      shape.points[0]!.y
    );

    ctx.closePath();
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

  // Calculate score based on overlap area and center distance
  const calculateScore = useCallback((drawn: Point[], target: Shape): { score: number; overlap: number; distance: number } => {
    if (drawn.length < 5 || target.points.length < 3) {
      return { score: 0, overlap: 0, distance: 999 };
    }

    const { boundingBox } = target;
    const shapeWidth = boundingBox.maxX - boundingBox.minX;
    const shapeHeight = boundingBox.maxY - boundingBox.minY;
    const shapeCenterX = (boundingBox.minX + boundingBox.maxX) / 2;
    const shapeCenterY = (boundingBox.minY + boundingBox.maxY) / 2;
    const shapeArea = shapeWidth * shapeHeight;

    // Calculate drawn path bounding box
    const drawnXs = drawn.map(p => p.x);
    const drawnYs = drawn.map(p => p.y);
    const drawnBox = {
      minX: Math.min(...drawnXs),
      minY: Math.min(...drawnYs),
      maxX: Math.max(...drawnXs),
      maxY: Math.max(...drawnYs),
    };
    const drawnWidth = drawnBox.maxX - drawnBox.minX;
    const drawnHeight = drawnBox.maxY - drawnBox.minY;
    const drawnCenterX = (drawnBox.minX + drawnBox.maxX) / 2;
    const drawnCenterY = (drawnBox.minY + drawnBox.maxY) / 2;
    const drawnArea = drawnWidth * drawnHeight;

    // Calculate center distance
    const centerDistance = Math.sqrt(
      Math.pow(shapeCenterX - drawnCenterX, 2) +
      Math.pow(shapeCenterY - drawnCenterY, 2)
    );

    // Calculate intersection/overlap area
    const overlapMinX = Math.max(boundingBox.minX, drawnBox.minX);
    const overlapMinY = Math.max(boundingBox.minY, drawnBox.minY);
    const overlapMaxX = Math.min(boundingBox.maxX, drawnBox.maxX);
    const overlapMaxY = Math.min(boundingBox.maxY, drawnBox.maxY);

    let intersectionArea = 0;
    if (overlapMaxX > overlapMinX && overlapMaxY > overlapMinY) {
      intersectionArea = (overlapMaxX - overlapMinX) * (overlapMaxY - overlapMinY);
    }

    // IoU (Intersection over Union) style overlap
    const unionArea = shapeArea + drawnArea - intersectionArea;
    const overlapRatio = unionArea > 0 ? intersectionArea / unionArea : 0;

    // NO INTERSECTION = 0 POINTS
    if (intersectionArea === 0) {
      return { score: 0, overlap: 0, distance: Math.round(centerDistance) };
    }

    // Distance bonus: closer = more bonus points (max 100 bonus)
    const maxDistanceForPoints = Math.max(shapeWidth, shapeHeight) * 1.5;
    const distanceScore = Math.max(0, 1 - centerDistance / maxDistanceForPoints);
    const distanceBonus = Math.round(distanceScore * 100);

    // Overlap score: more overlap = more points (max 400 points for perfect overlap)
    const overlapPoints = Math.round(overlapRatio * 400);

    // Total score = overlap points + distance bonus
    const totalScore = overlapPoints + distanceBonus;

    return {
      score: totalScore,
      overlap: Math.round(overlapRatio * 100),
      distance: Math.round(centerDistance),
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

    if (shape && drawn.length > 5) {
      const result = calculateScore(drawn, shape);

      // Add combo bonus
      const comboBonus = Math.floor(combo * 5);
      const finalScore = result.score + comboBonus;

      setScore(prev => prev + finalScore);
      setCombo(prev => {
        const newCombo = prev + 1;
        setMaxCombo(max => Math.max(max, newCombo));
        return newCombo;
      });
      setResultFeedback({ score: finalScore, overlap: result.overlap, distance: result.distance });
      setShapesCompleted(prev => prev + 1);
    } else {
      setResultFeedback({ score: 0, overlap: 0, distance: 999 });
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

  const handleBeat = useCallback((beatIdx: number) => {
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
    const shape = generateRandomShape();
    lastShapeRef.current = shape;
    setCurrentShape(shape);
    setGamePhase("showing");

    clearCanvas();
    drawShape(shape, ctx);

    // Shape disappears after a brief moment (500ms), then drawing starts
    shapeTimeoutRef.current = setTimeout(() => {
      setUserDrawing([]);
      userDrawingRef.current = [];
      setGamePhase("drawing");
      setResultFeedback(null);

      clearCanvas();
      ctx.fillStyle = "rgba(0, 0, 0, 0.92)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }, 500);
  }, [generateRandomShape, endDrawingPhase]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setVideoUrl(url);
      setIsPlaying(false);
      setBeatIndex(0);
      setScore(0);
      setCombo(0);
      setMaxCombo(0);
      setShapesCompleted(0);
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

      // start beat detection with slower tempo
      stopDetectRef.current?.();
      setBeats([]);
      stopDetectRef.current = await detectBeatsFromVideo(
        videoRef.current,
        (t) => {
          setBeats((b) => {
            if (b.length && Math.abs(b[b.length - 1]! - t) < 0.12) return b;
            const next = [...b, t];

            // Handle beat-based shape/drawing logic
            setBeatIndex((idx) => {
              const newIdx = idx + 1;
              handleBeat(newIdx);
              return newIdx;
            });

            return next;
          });
          // trigger fullscreen flash
          setFlashCount((c) => c + 1);
        },
        { minBeatSeparation: 1.5, sensitivityMode: 'medium' as const } // Fast beats - blip shape, draw until next beat
      );
    } catch (err) {
      console.warn("play failed", err);
    }
  };

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      stopDetectRef.current?.();
      if (shapeTimeoutRef.current) clearTimeout(shapeTimeoutRef.current);
      if (drawTimerRef.current) clearInterval(drawTimerRef.current);
    };
  }, []);

  // Spacebar to manually trigger next shape (for testing and manual mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && isPlaying && gamePhase === "idle") {
        e.preventDefault();
        setBeatIndex((idx) => {
          const newIdx = idx + 1;
          handleBeat(newIdx);
          return newIdx;
        });
        setFlashCount((c) => c + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, gamePhase, handleBeat]);

  // Get canvas coordinates from mouse/touch event
  const getCanvasCoords = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();

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
    if (gamePhase !== "drawing") return;
    e.preventDefault();
    setIsDrawing(true);

    const coords = getCanvasCoords(e);
    if (!coords) return;
    const newDrawing = [coords];
    setUserDrawing(newDrawing);
    userDrawingRef.current = newDrawing;
  };

  const handleDrawMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || gamePhase !== "drawing") return;
    e.preventDefault();

    const coords = getCanvasCoords(e);
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
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (lastShapeRef.current) {
          drawShapeHint(lastShapeRef.current, ctx);
        }
        drawUserPath(updated, ctx);
      }

      return updated;
    });
  };

  const handleDrawEnd = useCallback(() => {
    if (gamePhase !== "drawing") return;
    setIsDrawing(false);

    // Immediately evaluate and end drawing phase when user lifts finger/mouse
    // Only if they've drawn something substantial
    if (userDrawingRef.current.length > 15) {
      endDrawingPhase();
    }
  }, [gamePhase, endDrawingPhase]);

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
    stopDetectRef.current?.();
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
      <input
        id="file"
        className="file-input"
        type="file"
        accept="video/*, .mp4"
        onChange={handleFileChange}
      />

      <video
        ref={videoRef}
        className="game-video opacity-20"
        src={videoUrl || undefined}
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
      />

      <canvas
        ref={canvasRef}
        className="game-canvas"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: gamePhase === "drawing" ? "auto" : "none",
          cursor: gamePhase === "drawing" ? "crosshair" : "default",
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
                  background: "red",
                  opacity: 0.9,
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
            <div className="result-score">+{resultFeedback.score}</div>
            <div className="result-details">
              <span className="overlap-stat">Overlap: {resultFeedback.overlap}%</span>
              <span className="distance-stat">Distance: {resultFeedback.distance}px</span>
            </div>
          </div>
        )}

        <div className="hud-top">
          <div className="score-container">
            <div className="score">Score: {score.toLocaleString()}</div>
            <div className="combo">{combo > 0 && `${combo}x COMBO`}</div>
          </div>
          <div className="stats-container">
            <div className="shapes-done">Shapes: {shapesCompleted}</div>
            <div className="max-combo">Max Combo: {maxCombo}x</div>
          </div>
          <div className="timer">{timeLeft !== null ? formatTime(timeLeft) : "--:--"}</div>
        </div>

        <div className="center-controls">
          <div className="controls">
            {!videoUrl ? (
              <label className="btn" htmlFor="file">
                Load Video
              </label>
            ) : !isPlaying ? (
              <button className="btn" onClick={handleStart}>
                Start Game
              </button>
            ) : gamePhase === "idle" && shapesCompleted === 0 ? (
              <div className="waiting-hint">
                <div className="waiting-text">Waiting for beat...</div>
                <div className="waiting-subtext">or press SPACE</div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="hud-bottom" />
      </div>
    </div>
  );
}
