# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a Svelte + Vite project that uses Bun as the package manager.

### Development
```bash
bun install       # Install dependencies
bun run dev       # Start development server
bun run build     # Build for production
bun run preview   # Preview production build
```

### Accessing Different Pages
- Admin Interface: http://localhost:5173/admin.html
- Overlay View: http://localhost:5173/overlay.html
- Original App: http://localhost:5173/

## Architecture

This is a Svelte 5 application using Vite as the build tool:

- **Build Tool**: Vite with Svelte plugin configured in `vite.config.js`
- **Framework**: Svelte 5 with the new `mount` API for component initialization
- **Entry Points**: Multiple HTML files with corresponding JS entry points
  - `index.html` + `src/main.js` - Original app
  - `admin.html` + `src/admin.js` - Match admin interface
  - `overlay.html` + `src/overlay.js` - OBS overlay view
- **Type Checking**: JavaScript with JSDoc type checking enabled (`checkJs: true` in `jsconfig.json`)
- **Module System**: ESNext modules with bundler resolution
- **Preprocessing**: Uses `vitePreprocess` for handling various file types in Svelte components

## Floorball Match Overlay System

This project includes a floorball match broadcast overlay system for OBS Studio:

### Components
- **OBS WebSocket Module** (`src/lib/obsWebSocket.js`): Handles communication with OBS's built-in WebSocket server
- **Admin Interface** (`src/lib/Admin.svelte`): Control panel for managing match data
- **Overlay Interface** (`src/lib/Overlay.svelte`): Transparent overlay displayed in OBS

### How It Works
1. Both admin and overlay connect to OBS WebSocket (default port 4455)
2. Admin interface updates match data using SetPersistentData and broadcasts CustomEvents
3. Overlay receives updates in real-time and displays them with transparent background
4. Data persists in OBS between page reloads

### OBS Setup
1. Enable WebSocket server in OBS: Tools > WebSocket Server Settings
2. Note the port and password (if set)
3. Add Browser Source pointing to http://localhost:5173/overlay.html
4. Set resolution (e.g., 1920x1080) and enable transparency

The application follows standard Svelte project structure:
- Components live in `src/lib/`
- Assets are stored in `src/assets/` and `public/`
- Global styles are imported via `src/app.css`