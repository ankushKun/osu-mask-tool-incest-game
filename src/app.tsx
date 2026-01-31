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
type ResultFeedback = { score: number; accuracy: number; distance: number; rating: string } | null;

function getPointSegmentDistance(p: Point, v: Point, w: Point) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
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

  const drawLaserTrail = (points: Point[], ctx: CanvasRenderingContext2D) => {
    if (points.length < 1) return;

    const trailLength = 25; // Length of the fading trail
    const lastPoint = points[points.length - 1]!;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

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

    // Draw the cursor head (Laser point)
    ctx.shadowBlur = 20;
    ctx.shadowColor = "#00ffff";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
  };

  // Calculate score based on overlap area and center distance
  const calculateScore = useCallback((drawn: Point[], target: Shape): { score: number; accuracy: number; distance: number; rating: string } => {
    if (drawn.length < 5 || target.points.length < 3) {
      return { score: -50, accuracy: 0, distance: 0, rating: "MISS" };
    }

    // 1. Calculate Proximity (Average distance to shape outline)
    let totalError = 0;
    for (const p of drawn) {
      let minD = Infinity;
      // Find distance to closest segment of the target polygon
      for (let i = 0; i < target.points.length; i++) {
        const p1 = target.points[i]!;
        const p2 = target.points[(i + 1) % target.points.length]!;
        const d = getPointSegmentDistance(p, p1, p2);
        if (d < minD) minD = d;
      }
      totalError += minD;
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

    // 3. Final Scoring
    // Accuracy drops as error increases (tolerance ~120px)
    const accuracyRaw = Math.max(0, 1 - avgError / 120);
    const accuracy = Math.pow(accuracyRaw, 1.5); // Gentler falloff

    // Penalize incomplete shapes less heavily
    const coveragePenalty = coverage < 0.3 ? 0 : coverage;

    const finalScoreVal = Math.round(1000 * accuracy * coveragePenalty);
    const accuracyPercent = Math.round(accuracy * 100);

    let rating = "MISS";
    if (finalScoreVal > 800) rating = "PERFECT";
    else if (finalScoreVal > 600) rating = "GREAT";
    else if (finalScoreVal > 400) rating = "GOOD";
    else if (finalScoreVal > 100) rating = "OK";

    return {
      score: rating === "MISS" ? -50 : finalScoreVal,
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
        setScore(prev => Math.max(0, prev + result.score));
        setCombo(0);
        setResultFeedback(result);
      } else {
        const comboBonus = Math.floor(combo * 5);
        const finalScore = result.score + comboBonus;
        setScore(prev => prev + finalScore);
        setCombo(prev => {
          const newCombo = prev + 1;
          setMaxCombo(max => Math.max(max, newCombo));
          return newCombo;
        });
        setResultFeedback({ score: finalScore, accuracy: result.accuracy, distance: result.distance, rating: result.rating });
        setShapesCompleted(prev => prev + 1);
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
        { minBeatSeparation: 2.0, sensitivityMode: 'medium' as const } // Slower beats
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
    if (!isDrawing || (gamePhase !== "drawing" && gamePhase !== "showing")) return;
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
