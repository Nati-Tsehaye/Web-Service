import express, { type Request, type Response } from "express" // Import Request, Response
import { createServer } from "http"
import { type WebSocket, WebSocketServer } from "ws" // Import WebSocket
import cors from "cors"
import { v4 as uuidv4 } from "uuid"
import type { WebSocketMessage } from "./types"
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
} from "./gameState"

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
app.get("/api/rooms", (req: Request, res: Response) => {
  res.json({ rooms: getRoomsArray() })
})

app.get("/api/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    players: gameState.players.size,
    rooms: gameState.rooms.size,
    timestamp: new Date().toISOString(),
  })
})

// Simple test endpoint
app.get("/", (req: Request, res: Response) => {
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
wss.on("connection", (ws: WebSocket, req: Request) => {
  console.log(`🔌 New WebSocket connection from ${req.socket.remoteAddress}`)

  // Send initial room data
  const initialMessage: WebSocketMessage = {
    type: "room_update",
    rooms: getRoomsArray(),
  }
  ws.send(JSON.stringify(initialMessage))

  ws.on("message", (data: Buffer) => {
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

  ws.on("error", (error: Error) => {
    console.error("❌ WebSocket error:", error)
  })
})

function handleWebSocketMessage(ws: WebSocket, message: WebSocketMessage) {
  let currentSessionPlayerId = message.playerId || getPlayerByWebSocket(ws)

  if (!currentSessionPlayerId) {
    currentSessionPlayerId = uuidv4()
  }

  // Ensure the player exists in gameState.players with the correct ID and WebSocket.
  if (!gameState.players.has(currentSessionPlayerId)) {
    if (message.playerName) {
      addPlayer(currentSessionPlayerId, message.playerName, ws)
    } else {
      console.warn(`Received message for unknown player ${currentSessionPlayerId} without playerName:`, message)
      sendError(ws, "Player not registered. Please join a room first.")
      return
    }
  } else {
    const existingPlayer = gameState.players.get(currentSessionPlayerId)!
    if (existingPlayer.websocket !== ws) {
      console.log(`Updating WebSocket for existing player ${currentSessionPlayerId}`)
      if (existingPlayer.websocket) {
        gameState.connections.delete(existingPlayer.websocket)
      }
      existingPlayer.websocket = ws
      gameState.connections.set(ws, currentSessionPlayerId)
    }
  }

  const playerIdToUse = currentSessionPlayerId // Now guaranteed to be a string

  switch (message.type) {
    case "join_room":
      if (message.roomId && message.playerName) {
        const success = joinRoom(playerIdToUse, message.roomId)
        if (success) {
          console.log(`✅ Player ${message.playerName} joined room ${message.roomId}`)
          broadcastRoomUpdate()
          const response: WebSocketMessage = {
            type: "player_joined",
            roomId: message.roomId,
            playerId: playerIdToUse,
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
        const success = leaveRoom(playerIdToUse, message.roomId)
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
        const success = selectBoard(playerIdToUse, message.roomId, message.boardId)
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

  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === client.OPEN) {
      client.send(messageStr)
    }
  })
}

function sendError(ws: WebSocket, errorMessage: string) {
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
