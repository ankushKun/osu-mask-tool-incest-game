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
type ResultFeedback = { score: number; grade: string } | null;

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
  const [brushSize, setBrushSize] = useState(24);
  const [cursorPos, setCursorPos] = useState<Point | null>(null);

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
  const mousePosRef = useRef<Point | null>(null);
  const keyHeldRef = useRef<boolean>(false);

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

  const drawUserPath = (points: Point[], ctx: CanvasRenderingContext2D, lineWidth: number = 24) => {
    if (points.length < 2) return;

    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = lineWidth;
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

  // Calculate score based on exact area matching - overflow and underflow deduct points
  const calculateScore = useCallback((drawn: Point[], target: Shape): { score: number; grade: string } => {
    if (drawn.length < 5 || target.points.length < 3) {
      return { score: 0, grade: "MISS" };
    }

    const { boundingBox } = target;
    const shapeWidth = boundingBox.maxX - boundingBox.minX;
    const shapeHeight = boundingBox.maxY - boundingBox.minY;
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
    const drawnArea = drawnWidth * drawnHeight;

    // Calculate intersection area
    const overlapMinX = Math.max(boundingBox.minX, drawnBox.minX);
    const overlapMinY = Math.max(boundingBox.minY, drawnBox.minY);
    const overlapMaxX = Math.min(boundingBox.maxX, drawnBox.maxX);
    const overlapMaxY = Math.min(boundingBox.maxY, drawnBox.maxY);

    let intersectionArea = 0;
    if (overlapMaxX > overlapMinX && overlapMaxY > overlapMinY) {
      intersectionArea = (overlapMaxX - overlapMinX) * (overlapMaxY - overlapMinY);
    }

    // No intersection = 0 points
    if (intersectionArea === 0) {
      return { score: 0, grade: "MISS" };
    }

    // Calculate underflow (missed area) and overflow (extra area)
    const underflow = shapeArea - intersectionArea; // Area of shape not covered
    const overflow = drawnArea - intersectionArea;  // Area drawn outside shape

    // Calculate accuracy as percentage (1.0 = perfect match)
    // Penalize both underflow and overflow equally
    const totalPenalty = underflow + overflow;
    const accuracy = Math.max(0, 1 - (totalPenalty / shapeArea));

    // Also factor in bounds matching (position accuracy)
    const boundsDiffX = Math.abs((drawnBox.minX + drawnBox.maxX) / 2 - (boundingBox.minX + boundingBox.maxX) / 2);
    const boundsDiffY = Math.abs((drawnBox.minY + drawnBox.maxY) / 2 - (boundingBox.minY + boundingBox.maxY) / 2);
    const maxBoundsDiff = Math.max(shapeWidth, shapeHeight);
    const boundsAccuracy = Math.max(0, 1 - (boundsDiffX + boundsDiffY) / maxBoundsDiff);

    // Combined accuracy (70% area, 30% bounds)
    const combinedAccuracy = accuracy * 0.7 + boundsAccuracy * 0.3;

    // Convert to score slabs: 100, 75, 50, 25, 0
    let finalScore: number;
    let grade: string;

    if (combinedAccuracy >= 0.95) {
      finalScore = 100;
      grade = "PERFECT";
    } else if (combinedAccuracy >= 0.80) {
      finalScore = 75;
      grade = "GREAT";
    } else if (combinedAccuracy >= 0.60) {
      finalScore = 50;
      grade = "GOOD";
    } else if (combinedAccuracy >= 0.40) {
      finalScore = 25;
      grade = "OK";
    } else {
      finalScore = 0;
      grade = "MISS";
    }

    return { score: finalScore, grade };
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

      // Score is exactly the slab value - no combo bonus
      setScore(prev => prev + result.score);
      setCombo(prev => {
        const newCombo = prev + 1;
        setMaxCombo(max => Math.max(max, newCombo));
        return newCombo;
      });
      setResultFeedback({ score: result.score, grade: result.grade });
      setShapesCompleted(prev => prev + 1);
    } else {
      setResultFeedback({ score: 0, grade: "MISS" });
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
  // Z and X keys act as mouse down/up (like osu!)
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

      // Z or X key acts as mouse down for drawing
      if ((e.code === "KeyZ" || e.code === "KeyX") && !e.repeat) {
        if (phaseRef.current !== "drawing" || keyHeldRef.current) return;
        keyHeldRef.current = true;
        setIsDrawing(true);

        const pos = mousePosRef.current;
        if (pos) {
          const newDrawing = [pos];
          setUserDrawing(newDrawing);
          userDrawingRef.current = newDrawing;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Z or X key up acts as mouse up
      if (e.code === "KeyZ" || e.code === "KeyX") {
        if (!keyHeldRef.current) return;
        keyHeldRef.current = false;
        setIsDrawing(false);

        // Evaluate drawing on key release
        if (phaseRef.current === "drawing" && userDrawingRef.current.length > 15) {
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
  }, [isPlaying, gamePhase, handleBeat, endDrawingPhase]);

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
    // Always track mouse position for Z/X key drawing and brush cursor
    const coords = getCanvasCoords(e);
    if (coords) {
      mousePosRef.current = coords;
      setCursorPos(coords);
    }

    if (!isDrawing || gamePhase !== "drawing") return;
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
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (lastShapeRef.current) {
          drawShapeHint(lastShapeRef.current, ctx);
        }
        drawUserPath(updated, ctx, brushSize);
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

  // Handle scroll wheel for brush size
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -4 : 4;
    setBrushSize(prev => Math.min(100, Math.max(8, prev + delta)));
  }, []);

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
          cursor: "none",
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
        onWheel={handleWheel}
      />

      {/* Custom brush cursor */}
      {gamePhase === "drawing" && cursorPos && (
        <div
          className="brush-cursor"
          style={{
            position: "absolute",
            left: cursorPos.x,
            top: cursorPos.y,
            width: brushSize,
            height: brushSize,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            border: "3px solid rgba(255, 255, 255, 0.9)",
            background: isDrawing ? "rgba(255, 102, 171, 0.3)" : "transparent",
            pointerEvents: "none",
            zIndex: 20,
            transition: "background 0.1s ease",
          }}
        />
      )}

      {/* Drawing phase indicator */}
      {gamePhase === "drawing" && isPlaying && (
        <div className="phase-text">DRAW!</div>
      )}

      {/* Showing phase indicator */}
      {gamePhase === "showing" && isPlaying && (
        <div className="phase-text memorize">MEMORIZE!</div>
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
                className="beat-marker"
                style={{
                  left: `${left}%`,
                  transform: "translateX(-50%)",
                }}
              />
            );
          })}
        </div>
      </div>

      <div className="hud">
        {/* render a transient fullscreen flash on each beat */}
        {flashCount > 0 ? <div key={flashCount} className="beat-flash" /> : null}

        {/* Result feedback - grade and score */}
        {resultFeedback && (
          <div className={`result-feedback grade-${resultFeedback.grade.toLowerCase()}`}>
            <div className="result-grade">{resultFeedback.grade}</div>
            <div className="result-score">+{resultFeedback.score}</div>
          </div>
        )}

        <div className="hud-top">
          <div className="score-container">
            <div className="score">
              <span className="score-label">SCORE</span>
              <span className="score-value">{score.toLocaleString().padStart(8, '0')}</span>
            </div>
            {combo > 0 && (
              <div className="combo" key={combo}>
                <span className="combo-count">{combo}</span>
                <span className="combo-label">x</span>
              </div>
            )}
          </div>
          <div className="stats-container">
            <div className="shapes-done">
              <span className="stat-icon">◆</span> {shapesCompleted}
            </div>
            <div className="max-combo">
              <span className="stat-icon">★</span> {maxCombo}x
            </div>
          </div>
          <div className="timer">
            <span className="timer-icon">⏱</span>
            {timeLeft !== null ? formatTime(timeLeft) : "--:--"}
          </div>
        </div>

        <div className="center-controls">
          <div className="controls">
            {!videoUrl ? (
              <div className="start-screen">
                <div className="game-logo">
                  <span className="logo-text">SHAPE</span>
                  <span className="logo-accent">MEMORY</span>
                </div>
                <label className="btn" htmlFor="file">
                  ▶ Load Video
                </label>
                <div className="rules">
                  <h3>How to Play</h3>
                  <ul>
                    <li>A shape will flash on screen briefly</li>
                    <li>Draw the exact shape from memory</li>
                    <li>Match the size and position exactly</li>
                    <li>Use mouse/touch or <kbd>Z</kbd>/<kbd>X</kbd> keys to draw</li>
                  </ul>
                  <div className="scoring-info">
                    <h4>★ Scoring ★</h4>
                    <div className="score-slabs">
                      <span className="slab perfect">PERFECT 100</span>
                      <span className="slab great">GREAT 75</span>
                      <span className="slab good">GOOD 50</span>
                      <span className="slab ok">OK 25</span>
                      <span className="slab miss">MISS 0</span>
                    </div>
                    <p>Overflow or underflow deducts accuracy!</p>
                  </div>
                </div>
              </div>
            ) : !isPlaying ? (
              <div className="start-screen">
                <div className="ready-text">READY?</div>
                <button className="btn btn-start" onClick={handleStart}>
                  ▶ START
                </button>
                <div className="rules rules-compact">
                  <p><kbd>Z</kbd>/<kbd>X</kbd> or mouse to draw • Match shapes exactly</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="hud-bottom" />
      </div>
    </div>
  );
}
