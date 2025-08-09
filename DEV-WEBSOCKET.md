# Development WebSocket Server

A lightweight WebSocket server that mimics OBS WebSocket v5 protocol for local development.

## Features

- Runs on the same port as OBS (4455)
- Accepts any password (or no password)
- Stores data in memory during the session
- Broadcasts events to all connected clients
- No need to have OBS running

## Usage

### Start both servers (recommended for development):

```bash
# Terminal 1 - Start WebSocket server
bun run dev:ws

# Terminal 2 - Start Vite dev server  
bun run dev
```

### Access the application:

- Admin Interface: http://localhost:5173/admin.html
- Overlay View: http://localhost:5173/overlay.html

### Connect from Admin interface:

1. Open the Admin interface
2. Use any password (or leave blank)
3. Click "Connect to OBS"
4. The connection will succeed immediately

## How it works

The dev server implements a subset of the OBS WebSocket v5 protocol:

- **Authentication**: Always succeeds (accepts any password)
- **Persistent Data**: Stored in memory (survives page reloads during the session)
- **Custom Events**: Broadcasted to all connected clients
- **Multiple Clients**: Admin and Overlay can connect simultaneously

## Differences from production (OBS)

- No actual OBS integration
- Data is lost when the server restarts
- Authentication always succeeds
- Simplified protocol implementation

## Benefits

- Fast development iteration
- No OBS setup required
- Multiple developers can work independently
- Same API as production