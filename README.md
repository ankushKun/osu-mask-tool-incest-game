# Discosu

A rhythm game where you trace masks that appear on screen to the beat of the music. Think osu! meets Photoshop's masking tool.

Upload any music video, and masks will flash on screen synced to the audio. After each mask disappears, trace its shape from memory. The more accurate your drawing, the higher your score.

## Controls

- Click and drag (or hold Z/X) to draw
- Space to skip forward
- ESC to pause

## Running locally

```bash
bun install
bun run dev
```

Built with Bun, React, TypeScript, and Tailwind. Uses Web Audio API for beat detection.

ps. why masks? It was a theme for a gamejam