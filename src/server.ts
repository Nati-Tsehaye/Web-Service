import express from "express"
import { createServer } from "http"
import { WebSocketServer } from "ws"
import cors from "cors"
import { v4 as uuidv4 } from "uuid"
import type { WebSocketMessage } from "./types.js" // Added .js
import {
  gameState,
  getRoomsArray,
  joinRoom,
  leaveRoom,
  addPlayer,
  removePlayer,
  getPlayerByWebSocket,
  selectBoard,
  startGameInRoom,
} from "./gameState.js" // Added .js

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

// Middleware
app.use(
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"], // Allow your Next.js dev server
    credentials: true,
  }),
)
app.use(express.json())

// REST API endpoints
app.get("/api/rooms", (req, res) => {
  res.json({ rooms: getRoomsArray() })
})

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    players: gameState.players.size,
    rooms: gameState.rooms.size,
    timestamp: new Date().toISOString(),
  })
})

// Simple test endpoint
app.get("/", (req, res) => {
  res.json({
    message: "SETB Bingo WebSocket Server",
    status: "running",
    endpoints: {
      health: "/api/health",
      rooms: "/api/rooms",
      websocket: "ws://localhost:3001",
    },
  })
})

// WebSocket connection handling
wss.on("connection", (ws, req) => {
  console.log(`🔌 New WebSocket connection from ${req.socket.remoteAddress}`)

  // Send initial room data
  const initialMessage: WebSocketMessage = {
    type: "room_update",
    rooms: getRoomsArray(),
  }
  ws.send(JSON.stringify(initialMessage))

  ws.on("message", (data) => {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString())
      console.log(`📨 Received message:`, message)
      handleWebSocketMessage(ws, message)
    } catch (error) {
      console.error("❌ Error parsing WebSocket message:", error)
      sendError(ws, "Invalid message format")
    }
  })

  ws.on("close", () => {
    console.log("🔌 WebSocket connection closed")
    const playerId = getPlayerByWebSocket(ws)
    if (playerId) {
      removePlayer(playerId)
      broadcastRoomUpdate()
    }
  })

  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error)
  })
})

function handleWebSocketMessage(ws: any, message: WebSocketMessage) {
  // Prioritize the playerId sent by the client in the message.
  // If not provided (e.g., a very first message before client sets it),
  // then try to get it from the server's connection map.
  // If still not found, generate a new one (this should be rare for subsequent messages).
  let currentSessionPlayerId = message.playerId || getPlayerByWebSocket(ws)

  // If no playerId is established yet (first message from a new client without a stored ID)
  if (!currentSessionPlayerId) {
    currentSessionPlayerId = uuidv4() // Generate a temporary one for this message processing
  }

  // Ensure the player exists in gameState.players with the correct ID and WebSocket.
  // This handles initial connection and re-connections.
  if (!gameState.players.has(currentSessionPlayerId)) {
    // If player ID is new to the server, add them.
    // We need a playerName for this, which should come with 'join_room' or similar.
    if (message.playerName) {
      addPlayer(currentSessionPlayerId, message.playerName, ws)
    } else {
      // If no playerName and player not found, it's an invalid state for this message type.
      console.warn(`Received message for unknown player ${currentSessionPlayerId} without playerName:`, message)
      sendError(ws, "Player not registered. Please join a room first.")
      return // Stop processing this message
    }
  } else {
    // Player exists, ensure their WebSocket connection is up-to-date.
    // This is crucial for re-connections where the WebSocket object changes.
    const existingPlayer = gameState.players.get(currentSessionPlayerId)!
    if (existingPlayer.websocket !== ws) {
      console.log(`Updating WebSocket for existing player ${currentSessionPlayerId}`)
      // Remove old connection mapping if it exists
      if (existingPlayer.websocket) {
        gameState.connections.delete(existingPlayer.websocket)
      }
      existingPlayer.websocket = ws
      gameState.connections.set(ws, currentSessionPlayerId)
    }
  }

  // Now, use currentSessionPlayerId for all subsequent logic.
  // This ensures consistency.
  const playerIdToUse = currentSessionPlayerId

  switch (message.type) {
    case "join_room":
      if (message.roomId && message.playerName) {
        const success = joinRoom(playerIdToUse, message.roomId) // Use playerIdToUse
        if (success) {
          console.log(`✅ Player ${message.playerName} joined room ${message.roomId}`)
          broadcastRoomUpdate()
          const response: WebSocketMessage = {
            type: "player_joined",
            roomId: message.roomId,
            playerId: playerIdToUse, // Send back the confirmed playerId
          }
          ws.send(JSON.stringify(response))
        } else {
          console.log(`❌ Failed to join room ${message.roomId}`)
          sendError(ws, "Failed to join room")
        }
      }
      break

    case "leave_room":
      if (message.roomId) {
        const success = leaveRoom(playerIdToUse, message.roomId) // Use playerIdToUse
        if (success) {
          console.log(`✅ Player ${playerIdToUse} left room ${message.roomId}`)
          broadcastRoomUpdate()
          const response: WebSocketMessage = {
            type: "player_left",
            roomId: message.roomId,
            playerId: playerIdToUse,
          }
          ws.send(JSON.stringify(response))
        }
      }
      break

    case "select_board":
      if (message.roomId && message.boardId) {
        const success = selectBoard(playerIdToUse, message.roomId, message.boardId) // Use playerIdToUse
        if (success) {
          console.log(`✅ Player ${playerIdToUse} selected board ${message.boardId} in room ${message.roomId}`)
          broadcastRoomUpdate()
        } else {
          console.log(`❌ Failed to select board ${message.boardId} for player ${playerIdToUse}`)
          sendError(ws, "Failed to select board, it might be taken.")
        }
      }
      break

    case "start_game":
      if (message.roomId) {
        const success = startGameInRoom(message.roomId)
        if (success) {
          console.log(`✅ Game started in room ${message.roomId}`)
          broadcastRoomUpdate()
        } else {
          console.log(`❌ Failed to start game in room ${message.roomId}`)
          sendError(ws, "Failed to start game.")
        }
      }
      break

    default:
      console.log(`❓ Unknown message type: ${message.type}`)
      sendError(ws, "Unknown message type")
  }
}

function broadcastRoomUpdate() {
  const message: WebSocketMessage = {
    type: "room_update",
    rooms: getRoomsArray(),
  }

  const messageStr = JSON.stringify(message)
  console.log(`📡 Broadcasting room update to ${wss.clients.size} clients`)

  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(messageStr)
    }
  })
}

function sendError(ws: any, errorMessage: string) {
  const message: WebSocketMessage = {
    type: "error",
    message: errorMessage,
  }
  ws.send(JSON.stringify(message))
}

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`🚀 SETB Bingo Server running on port ${PORT}`)
  console.log(`📡 WebSocket server ready at ws://localhost:${PORT}`)
  console.log(`🌐 HTTP server ready at http://localhost:${PORT}`)
  console.log(`🎮 Game rooms initialized: ${gameState.rooms.size}`)
  console.log(`👥 Connected players: ${gameState.players.size}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})
