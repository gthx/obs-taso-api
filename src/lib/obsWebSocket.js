import { writable } from "svelte/store";

export const connectionStatus = writable("disconnected");
export const matchData = writable({
  homeTeam: { name: "", score: 0 },
  awayTeam: { name: "", score: 0 },
  period: 1,
  time: "00:00",
  lastUpdated: null,
});

class OBSWebSocketClient {
  constructor() {
    this.ws = null;
    this.password = "";
    this.reconnectInterval = null;
    this.requestId = 1;
    this.requestCallbacks = new Map();
    this.eventListeners = new Map();
  }

  async connect(url = "ws://localhost:4455", password = "") {
    this.password = password;
    this.url = url;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        this.connectResolve = resolve;
        this.connectReject = reject;

        this.ws.onopen = () => {
          console.log("WebSocket opened, waiting for Hello message");
          connectionStatus.set("connecting");
        };

        this.ws.onclose = () => {
          console.log("Disconnected from OBS WebSocket");
          connectionStatus.set("disconnected");
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          connectionStatus.set("error");
          if (this.connectReject) {
            this.connectReject(error);
            this.connectReject = null;
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(JSON.parse(event.data));
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async identify(authString = null) {
    const identifyRequest = {
      op: 1, // Identify
      d: {
        rpcVersion: 1,
        eventSubscriptions: 33, // CustomEvents flag
      },
    };

    // If authString is provided, add it to the request
    if (authString) {
      identifyRequest.d.authentication = authString;
    }

    this.ws.send(JSON.stringify(identifyRequest));
  }

  async subscribe(events) {
    // OBS WebSocket v5 handles subscriptions during identify
    console.log("Subscribed to events:", events);
  }

  handleMessage(message) {
    // Handle different message types based on op code
    switch (message.op) {
      case 0: // Hello
        console.log("Received Hello", message.d);
        this.handleHello(message.d);
        break;
      case 2: // Identified
        console.log("Successfully identified");
        connectionStatus.set("connected");
        if (this.connectResolve) {
          this.connectResolve();
          this.connectResolve = null;
        }
        break;
      case 5: // Event
        this.handleEvent(message.d);
        break;
      case 7: // RequestResponse
        this.handleResponse(message.d);
        break;
      default:
        console.log("Unknown message:", message);
    }
  }

  async handleHello(helloData) {
    // Check if authentication is required
    if (helloData.authentication) {
      console.log("Authentication required");
      if (this.password === null || this.password === undefined) {
        console.log("No password provided - authentication will fail");
        connectionStatus.set("error");
        if (this.connectReject) {
          this.connectReject(
            new Error("Authentication required but no password provided"),
          );
          this.connectReject = null;
        }
        this.ws.close();
        return;
      }

      try {
        const authResponse = await this.generateAuthResponse(
          this.password,
          helloData.authentication.challenge,
          helloData.authentication.salt,
        );
        await this.identify(authResponse);
      } catch (error) {
        console.error("Authentication failed:", error);
        connectionStatus.set("error");
        if (this.connectReject) {
          this.connectReject(error);
          this.connectReject = null;
        }
        this.ws.close();
      }
    } else {
      console.log("No authentication required - proceeding with connection");
      await this.identify();
    }
  }

  async generateAuthResponse(password, challenge, salt) {
    // Implement OBS WebSocket v5 SHA256 challenge-response authentication
    try {
      // Step 1: Concatenate password + salt
      const secretString = password + salt;

      // Step 2-3: Generate SHA256 hash of password+salt and base64 encode it
      const secretHash = await this.sha256(secretString);
      const secret = this.base64Encode(secretHash);

      // Step 4: Concatenate base64 secret + challenge
      const authResponseString = secret + challenge;

      // Step 5-6: Generate SHA256 hash of secret+challenge and base64 encode it
      const authResponseHash = await this.sha256(authResponseString);
      const authResponse = this.base64Encode(authResponseHash);

      return authResponse;
    } catch (error) {
      throw new Error(`Failed to generate auth response: ${error.message}`);
    }
  }

  async sha256(message) {
    // Use Web Crypto API to generate SHA256 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(hashBuffer);
  }

  base64Encode(uint8Array) {
    // Convert Uint8Array to base64 string
    let binary = "";
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  handleEvent(eventData) {
    if (eventData.eventType === "CustomEvent") {
      const { eventData: customData } = eventData;
      if (customData && customData.eventName === "MatchUpdate") {
        matchData.set(customData.eventData);
      }
    }

    // Emit to any registered listeners
    const listeners = this.eventListeners.get(eventData.eventType) || [];
    listeners.forEach((callback) => callback(eventData));
  }

  handleResponse(response) {
    const callback = this.requestCallbacks.get(response.requestId);
    if (callback) {
      callback(response);
      this.requestCallbacks.delete(response.requestId);
    }
  }

  async sendRequest(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      const requestId = this.requestId++;

      const request = {
        op: 6, // Request
        d: {
          requestType,
          requestId: requestId.toString(),
          requestData,
        },
      };

      this.requestCallbacks.set(requestId.toString(), (response) => {
        if (response.requestStatus.result) {
          resolve(response.responseData);
        } else {
          reject(new Error(response.requestStatus.comment));
        }
      });

      this.ws.send(JSON.stringify(request));
    });
  }

  async setMatchData(data) {
    try {
      await this.sendRequest("SetPersistentData", {
        realm: "OBS_WEBSOCKET_DATA_REALM_GLOBAL",
        slotName: "floorball-match",
        slotValue: data,
      });

      // Also broadcast as custom event for real-time updates
      await this.sendRequest("BroadcastCustomEvent", {
        eventData: {
          eventName: "MatchUpdate",
          eventData: data,
        },
      });

      matchData.set(data);
    } catch (error) {
      console.error("Failed to set match data:", error);
    }
  }

  async sendClockControl(action, data = {}) {
    try {
      await this.sendRequest("BroadcastCustomEvent", {
        eventData: {
          eventName: "ClockControl",
          eventData: {
            action,
            ...data,
            timestamp: Date.now(),
          },
        },
      });
    } catch (error) {
      console.error("Failed to send clock control:", error);
    }
  }

  async sendScoreUpdate(homeScore, awayScore) {
    try {
      await this.sendRequest("BroadcastCustomEvent", {
        eventData: {
          eventName: "ScoreUpdate",
          eventData: {
            homeScore,
            awayScore,
            timestamp: Date.now(),
          },
        },
      });
    } catch (error) {
      console.error("Failed to send score update:", error);
    }
  }

  async sendPenaltyUpdate(homePenalties, awayPenalties) {
    try {
      await this.sendRequest("BroadcastCustomEvent", {
        eventData: {
          eventName: "PenaltyUpdate",
          eventData: {
            homePenalties,
            awayPenalties,
            timestamp: Date.now(),
          },
        },
      });
    } catch (error) {
      console.error("Failed to send penalty update:", error);
    }
  }

  async sendShootoutUpdate(homeAttempts, awayAttempts) {
    try {
      await this.sendRequest("BroadcastCustomEvent", {
        eventData: {
          eventName: "ShootoutUpdate",
          eventData: {
            homeAttempts,
            awayAttempts,
            timestamp: Date.now(),
          },
        },
      });
    } catch (error) {
      console.error("Failed to send shootout update:", error);
    }
  }

  async sendMatchInfo(matchInfo) {
    try {
      await this.sendRequest("BroadcastCustomEvent", {
        eventData: {
          eventName: "MatchInfo",
          eventData: {
            ...matchInfo,
            timestamp: Date.now(),
          },
        },
      });
    } catch (error) {
      console.error("Failed to send match info:", error);
    }
  }

  async getMatchData() {
    try {
      const response = await this.sendRequest("GetPersistentData", {
        realm: "OBS_WEBSOCKET_DATA_REALM_GLOBAL",
        slotName: "floorball-match",
      });

      if (response && response.slotValue) {
        matchData.set(response.slotValue);
        return response.slotValue;
      }
    } catch (error) {
      console.error("Failed to get match data:", error);
    }
    return null;
  }

  addEventListener(eventType, callback) {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, []);
    }
    this.eventListeners.get(eventType).push(callback);
  }

  removeEventListener(eventType, callback) {
    const listeners = this.eventListeners.get(eventType);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  attemptReconnect() {
    if (this.reconnectInterval) return;

    const url = this.url || "ws://localhost:4455";
    const password = this.password || "";

    this.reconnectInterval = setInterval(async () => {
      try {
        await this.connect(url, password);
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      } catch (error) {
        console.log("Reconnection attempt failed");
      }
    }, 5000);
  }

  disconnect() {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const obsWebSocket = new OBSWebSocketClient();
