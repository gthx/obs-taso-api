#!/usr/bin/env bun

/**
 * Development WebSocket Server
 * Mimics OBS WebSocket v5 protocol for local development
 * Accepts any authentication and stores data in memory
 */

const PORT = 4455;

// In-memory storage for persistent data
const persistentData = new Map();
const clients = new Set();

// Generate a simple challenge for auth flow (dev mode accepts anything)
function generateChallenge() {
  return {
    challenge: 'devchallengestring',
    salt: 'devsaltstring'
  };
}

// Broadcast a message to all connected clients except the sender
function broadcast(message, senderWs) {
  const messageStr = JSON.stringify(message);
  for (const client of clients) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

// Handle incoming messages based on OBS WebSocket v5 protocol
function handleMessage(ws, message) {
  try {
    const msg = JSON.parse(message);
    
    switch (msg.op) {
      case 1: // Identify
        console.log('Client identifying...');
        // Always accept authentication in dev mode
        ws.send(JSON.stringify({
          op: 2, // Identified
          d: {
            negotiatedRpcVersion: 1
          }
        }));
        console.log('Client identified successfully');
        break;
        
      case 6: // Request
        const { requestType, requestId, requestData } = msg.d;
        console.log(`Handling request: ${requestType}`);
        
        switch (requestType) {
          case 'SetPersistentData':
            // Store data in memory
            const { realm, slotName, slotValue } = requestData;
            const key = `${realm}:${slotName}`;
            persistentData.set(key, slotValue);
            
            // Send success response
            ws.send(JSON.stringify({
              op: 7, // RequestResponse
              d: {
                requestType,
                requestId,
                requestStatus: {
                  result: true,
                  code: 100,
                  comment: 'Success'
                },
                responseData: {}
              }
            }));
            console.log(`Stored data in ${key}`);
            break;
            
          case 'GetPersistentData':
            // Retrieve data from memory
            const getKey = `${requestData.realm}:${requestData.slotName}`;
            const value = persistentData.get(getKey);
            
            ws.send(JSON.stringify({
              op: 7, // RequestResponse
              d: {
                requestType,
                requestId,
                requestStatus: {
                  result: true,
                  code: 100,
                  comment: 'Success'
                },
                responseData: {
                  slotValue: value || null
                }
              }
            }));
            console.log(`Retrieved data from ${getKey}`);
            break;
            
          case 'BroadcastCustomEvent':
            // Broadcast custom event to all clients
            const event = {
              op: 5, // Event
              d: {
                eventType: 'CustomEvent',
                eventIntent: 0,
                eventData: requestData.eventData
              }
            };
            
            // Send to all clients including sender
            broadcast(event, null);
            ws.send(JSON.stringify(event));
            
            // Send success response
            ws.send(JSON.stringify({
              op: 7, // RequestResponse
              d: {
                requestType,
                requestId,
                requestStatus: {
                  result: true,
                  code: 100,
                  comment: 'Success'
                },
                responseData: {}
              }
            }));
            console.log(`Broadcasted custom event: ${requestData.eventData.eventName}`);
            break;
            
          default:
            // Unknown request type - send error
            ws.send(JSON.stringify({
              op: 7, // RequestResponse
              d: {
                requestType,
                requestId,
                requestStatus: {
                  result: false,
                  code: 203,
                  comment: `Unknown request type: ${requestType}`
                },
                responseData: {}
              }
            }));
            console.log(`Unknown request type: ${requestType}`);
        }
        break;
        
      default:
        console.log(`Unknown op code: ${msg.op}`);
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

// Create Bun WebSocket server
const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    // Upgrade to WebSocket
    if (server.upgrade(req)) {
      return; // Bun automatically handles the response
    }
    
    // Return 426 Upgrade Required for non-WebSocket requests
    return new Response('WebSocket endpoint only', { status: 426 });
  },
  websocket: {
    open(ws) {
      console.log('Client connected');
      clients.add(ws);
      
      // Send Hello message when client connects
      const hello = {
        op: 0, // Hello
        d: {
          obsWebSocketVersion: '5.0.0',
          rpcVersion: 1,
          authentication: generateChallenge()
        }
      };
      ws.send(JSON.stringify(hello));
      console.log('Sent Hello message');
    },
    
    message(ws, message) {
      handleMessage(ws, message);
    },
    
    close(ws) {
      console.log('Client disconnected');
      clients.delete(ws);
    },
    
    error(ws, error) {
      console.error('WebSocket error:', error);
    }
  }
});

console.log(`
╔════════════════════════════════════════════════╗
║     OBS WebSocket Dev Server                  ║
║     Running on ws://localhost:${PORT}          ║
║                                                ║
║     This is a development server that mimics  ║
║     OBS WebSocket v5 protocol.                ║
║     • Accepts any password                    ║
║     • Stores data in memory                   ║
║     • Broadcasts events to all clients        ║
╚════════════════════════════════════════════════╝
`);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.stop();
  process.exit(0);
});