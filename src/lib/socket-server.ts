import { Server as SocketIOServer } from "socket.io"
import type { Server as HTTPServer } from "http"
import { GameStateManager } from "../lib/upstash-client" // Import GameStateManager
import type { GameRoom as GameRoomType, Player as PlayerType, GameState as GameStateType, Winner } from "@/types/game"

// Extend types for internal use if needed
export interface Player extends PlayerType {}
export interface GameRoom extends GameRoomType {}

// Centralized number calling intervals
const activeGameIntervals = new Map<string, NodeJS.Timeout>()

class GameRoomManager {
  // This class will now primarily interact with Redis via GameStateManager
  // and manage the in-memory state for active games (like number calling intervals)

  constructor() {
    // Ensure default rooms exist on startup
    GameStateManager.ensureDefaultRooms().catch(console.error)
  }

  async getRoomsByStake(stake: number): Promise<GameRoom[]> {
    const allRooms = await GameStateManager.getAllRooms()
    return allRooms.filter((room) => room.stake === stake).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  async getAllRooms(): Promise<GameRoom[]> {
    return GameStateManager.getAllRooms()
  }

  async findAvailableRoom(stake: number): Promise<GameRoom | null> {
    const rooms = await this.getRoomsByStake(stake)
    return rooms.find((room) => room.status === "waiting" && room.players.length < room.maxPlayers) || null
  }

  async createRoom(stake: number): Promise<GameRoom> {
    const roomId = `room-${stake}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const room: GameRoom = {
      id: roomId,
      stake,
      players: [],
      maxPlayers: 100, // Default max players
      status: "waiting",
      prize: 0,
      createdAt: new Date(),
      activeGames: 0,
      hasBonus: true,
    }
    await GameStateManager.setRoom(roomId, room)
    return room
  }

  async joinRoom(roomId: string, player: Player): Promise<{ success: boolean; room?: GameRoom; message?: string }> {
    const room = await GameStateManager.getRoom(roomId)
    if (!room) {
      return { success: false, message: "Room not found" }
    }

    if (room.players.length >= room.maxPlayers) {
      return { success: false, message: "Room is full" }
    }

    if (room.status !== "waiting") {
      return { success: false, message: "Game already started" }
    }

    // Remove player from previous room if exists and is different session
    const previousRoomId = await GameStateManager.getPlayerSession(player.id)
    if (previousRoomId && previousRoomId !== roomId) {
      await this.leaveRoom(previousRoomId, player.id)
    }

    // Check if this Telegram user is already in this room (prevent duplicate joins from different devices)
    if (player.telegramId) {
      const existingTelegramPlayer = room.players?.find((p) => p.telegramId === player.telegramId)
      if (existingTelegramPlayer && existingTelegramPlayer.id !== player.id) {
        console.log(`🚫 Telegram user ${player.telegramId} already in room with different session ID`)
        console.log(`   Existing: ${existingTelegramPlayer.id}, New: ${player.id}`)

        // Remove the old session and replace with new one
        room.players = room.players?.filter((p) => p.telegramId !== player.telegramId) || []

        // Clean up old player session and board selections
        await GameStateManager.removePlayerSession(existingTelegramPlayer.id)
        await GameStateManager.removePlayerFromAllBoardSelections(existingTelegramPlayer.id)

        console.log(`🔄 Replaced old session ${existingTelegramPlayer.id} with new session ${player.id}`)
      }
    } else {
      // For guest users, check by player ID as before
      const existingPlayer = room.players?.find((p) => p.id === player.id)
      if (existingPlayer) {
        console.log("🔄 Player already in room with same session, updating session")
        await GameStateManager.setPlayerSession(player.id, roomId)
        return { success: true, room, message: "Already in room" }
      }
    }

    // Remove player from other rooms first (but protect this player ID)
    console.log("🧹 Cleaning up player from other rooms...")
    if (player.telegramId) {
      await GameStateManager.removePlayerByTelegramId(player.telegramId, player.id)
    } else {
      await GameStateManager.removePlayerFromAllRooms(player.id)
    }

    room.players.push(player)
    room.prize = room.players.length * room.stake

    // Auto-start logic (moved from API route)
    const minPlayers = 2
    const autoStartThreshold = Math.min(room.maxPlayers * 0.1, 10)

    if (room.players.length >= minPlayers && room.players.length >= autoStartThreshold) {
      room.status = "starting"
      // Schedule game start
      setTimeout(async () => {
        const currentRoom = await GameStateManager.getRoom(roomId)
        if (currentRoom && currentRoom.status === "starting") {
          currentRoom.status = "active"
          currentRoom.gameStartTime = new Date()
          currentRoom.activeGames = 1
          await GameStateManager.setRoom(roomId, currentRoom)
          this.startCentralizedNumberCalling(roomId) // Start number calling
        }
      }, 10000) // 10 seconds delay
    }

    await GameStateManager.setRoom(roomId, room)
    await GameStateManager.setPlayerSession(player.id, roomId)

    return { success: true, room }
  }

  async leaveRoom(roomId: string, playerId: string): Promise<{ success: boolean; room?: GameRoom }> {
    const room = await GameStateManager.getRoom(roomId)
    if (!room) return { success: false }

    const playerIndex = room.players.findIndex((p) => p.id === playerId)
    if (playerIndex === -1) return { success: false }

    room.players.splice(playerIndex, 1)
    room.prize = room.players.length * room.stake
    await GameStateManager.removePlayerSession(playerId)
    await GameStateManager.removePlayerFromAllBoardSelections(playerId)

    // Reset room status if completely empty
    if (room.players.length === 0) {
      room.status = "waiting"
      room.activeGames = 0
      room.calledNumbers = []
      room.currentNumber = undefined
      room.gameStartTime = undefined
      await GameStateManager.resetGameState(roomId)
      this.stopCentralizedNumberCalling(roomId) // Stop number calling
    } else if (room.players.length < 2 && room.status !== "waiting") {
      // If game was active and players drop below 2, reset to waiting
      room.status = "waiting"
      room.activeGames = 0
      room.calledNumbers = []
      room.currentNumber = undefined
      room.gameStartTime = undefined
      await GameStateManager.resetGameState(roomId)
      this.stopCentralizedNumberCalling(roomId) // Stop number calling
    }

    await GameStateManager.setRoom(roomId, room)
    return { success: true, room }
  }

  async getRoom(roomId: string): Promise<GameRoom | null> {
    return GameStateManager.getRoom(roomId)
  }

  async getPlayerRoom(playerId: string): Promise<GameRoom | null> {
    const roomId = await GameStateManager.getPlayerSession(playerId)
    return roomId ? GameStateManager.getRoom(roomId) : null
  }

  // Game State Actions
  async startGame(roomId: string): Promise<{ success: boolean; gameState?: GameStateType }> {
    let gameState = await GameStateManager.getGameState(roomId)
    if (!gameState) {
      gameState = {
        roomId,
        calledNumbers: [],
        currentNumber: null,
        gameStatus: "waiting",
        winners: [],
        lastUpdate: new Date().toISOString(),
      }
    }

    if (gameState.gameStatus === "waiting") {
      gameState.gameStatus = "active"
      gameState.gameStartTime = new Date().toISOString()
      gameState.lastUpdate = new Date().toISOString()

      if (!gameState.calledNumbers) gameState.calledNumbers = []
      if (!gameState.winners) gameState.winners = []

      await GameStateManager.setGameState(roomId, gameState)
      this.startCentralizedNumberCalling(roomId)
      return { success: true, gameState }
    }
    return { success: false, message: "Game already started or not in waiting state" }
  }

  async callNextNumber(roomId: string): Promise<{ success: boolean; gameState?: GameStateType }> {
    const newNumber = await GameStateManager.callNextNumber(roomId)
    if (newNumber) {
      const gameState = await GameStateManager.getGameState(roomId)
      return { success: true, gameState: gameState || undefined }
    }
    return { success: false, message: "No new number called" }
  }

  async claimBingo(
    roomId: string,
    playerId: string,
    playerName: string,
    winningPattern: string,
  ): Promise<{ success: boolean; gameState?: GameStateType }> {
    const gameState = await GameStateManager.getGameState(roomId)
    if (!gameState || gameState.gameStatus !== "active") {
      return { success: false, message: "Game not active or state not found" }
    }

    const winner: Winner = {
      playerId,
      playerName,
      winningPattern,
      timestamp: new Date().toISOString(),
    }

    gameState.winners.push(winner)

    if (gameState.winners.length === 1) {
      gameState.gameStatus = "finished"
      this.stopCentralizedNumberCalling(roomId) // Stop calling when first winner
    }

    gameState.lastUpdate = new Date().toISOString()
    await GameStateManager.setGameState(roomId, gameState)
    return { success: true, gameState }
  }

  async resetGame(roomId: string): Promise<{ success: boolean; gameState?: GameStateType }> {
    this.stopCentralizedNumberCalling(roomId)
    const gameState = await GameStateManager.resetGameState(roomId)
    return { success: true, gameState }
  }

  // Board Selection Actions
  async selectBoard(
    roomId: string,
    playerId: string,
    playerName: string,
    boardNumber: number,
  ): Promise<{ success: boolean; selections?: any[]; message?: string }> {
    const selections = await GameStateManager.getBoardSelections(roomId)
    const existingSelection = selections.find((s) => s.boardNumber === boardNumber && s.playerId !== playerId)
    if (existingSelection) {
      return {
        success: false,
        message: `Board ${boardNumber} is already selected by ${existingSelection.playerName}`,
      }
    }

    await GameStateManager.removeBoardSelection(roomId, playerId) // Remove previous selection by this player
    const newSelection = { roomId, playerId, playerName, boardNumber, timestamp: new Date().toISOString() }
    await GameStateManager.setBoardSelection(roomId, playerId, newSelection)
    const updatedSelections = await GameStateManager.getBoardSelections(roomId)
    return { success: true, selections: updatedSelections }
  }

  async deselectBoard(
    roomId: string,
    playerId: string,
  ): Promise<{ success: boolean; selections?: any[]; message?: string }> {
    await GameStateManager.removeBoardSelection(roomId, playerId)
    const updatedSelections = await GameStateManager.getBoardSelections(roomId)
    return { success: true, selections: updatedSelections }
  }

  // Centralized Number Calling Logic (moved from API route)
  private async startCentralizedNumberCalling(roomId: string) {
    // Clear any existing caller for this room
    if (activeGameIntervals.has(roomId)) {
      clearInterval(activeGameIntervals.get(roomId)!)
      activeGameIntervals.delete(roomId)
    }

    console.log(`🎯 Starting centralized number calling for room: ${roomId}`)

    const callNumber = async () => {
      try {
        const gameState = await GameStateManager.getGameState(roomId)
        if (!gameState || gameState.gameStatus !== "active") {
          console.log(`⏹️ Stopping number calling for room ${roomId} - game not active`)
          this.stopCentralizedNumberCalling(roomId)
          return
        }

        // Check if all numbers have been called
        const calledCount = gameState.calledNumbers?.length || 0
        if (calledCount >= 75) {
          console.log(`🏁 All numbers called for room ${roomId}`)
          gameState.gameStatus = "finished"
          await GameStateManager.setGameState(roomId, gameState)
          this.stopCentralizedNumberCalling(roomId)
          return
        }

        // Call next number
        const newNumber = await GameStateManager.callNextNumber(roomId)
        if (newNumber) {
          console.log(`📢 Centrally called number ${newNumber} for room ${roomId}`)
          // Fetch updated game state after number call
          const updatedGameState = await GameStateManager.getGameState(roomId)
          if (updatedGameState) {
            io.to(roomId).emit("game-state-update", updatedGameState)
          }
        }
      } catch (error) {
        console.error(`Error in centralized number calling for room ${roomId}:`, error)
      }
    }

    // Call first number after 3 seconds, then every 5 seconds
    setTimeout(callNumber, 3000)
    const interval = setInterval(callNumber, 5000)
    activeGameIntervals.set(roomId, interval)
  }

  private stopCentralizedNumberCalling(roomId: string) {
    if (activeGameIntervals.has(roomId)) {
      clearInterval(activeGameIntervals.get(roomId)!)
      activeGameIntervals.delete(roomId)
      console.log(`⏹️ Stopped centralized number calling for room: ${roomId}`)
    }
  }
}

let io: SocketIOServer // Declare io globally to be accessible in GameRoomManager methods

export function initializeSocketServer(httpServer: HTTPServer) {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
    },
  })

  const roomManager = new GameRoomManager()

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id)

    // Send initial room data
    roomManager.getAllRooms().then((rooms) => {
      socket.emit("rooms-update", rooms)
    })

    // Join a room
    socket.on("join-room", async ({ roomId, player }: { roomId: string; player: Omit<Player, "joinedAt"> }) => {
      const fullPlayer: Player = {
        ...player,
        joinedAt: new Date(),
      }
      const { success, room, message } = await roomManager.joinRoom(roomId, fullPlayer)

      if (success && room) {
        socket.join(room.id)
        socket.emit("room-joined", room)

        // Broadcast room update to all clients
        io.emit("rooms-update", await roomManager.getAllRooms())

        // Notify room members
        io.to(room.id).emit("player-joined", { room, player: fullPlayer })

        // Send initial game state and board selections to the newly joined player
        const gameState = await GameStateManager.getGameState(room.id)
        if (gameState) {
          socket.emit("game-state-update", gameState)
        }
        const boardSelections = await GameStateManager.getBoardSelections(room.id)
        socket.emit("board-selections-update", boardSelections)
      } else {
        socket.emit("join-failed", { message: message || "Could not join room" })
      }
    })

    // Leave room
    socket.on("leave-room", async ({ roomId, playerId }: { roomId: string; playerId: string }) => {
      const { success, room } = await roomManager.leaveRoom(roomId, playerId)
      if (success) {
        socket.leave(roomId)
        socket.emit("room-left")

        // Broadcast updates
        io.emit("rooms-update", await roomManager.getAllRooms())
        if (room) {
          io.to(roomId).emit("player-left", { room, playerId })
          // If room became empty and reset, send updated game state
          if (room.players.length === 0 && room.status === "waiting") {
            io.to(roomId).emit("game-state-update", await GameStateManager.getGameState(roomId))
          }
        }
      } else {
        socket.emit("leave-failed", { message: "Could not leave room" })
      }
    })

    // Game State Actions
    socket.on("start-game", async ({ roomId }: { roomId: string }) => {
      const { success, gameState, message } = await roomManager.startGame(roomId)
      if (success && gameState) {
        io.to(roomId).emit("game-state-update", gameState)
        io.emit("rooms-update", await roomManager.getAllRooms()) // Update room status in lobby
      } else {
        socket.emit("game-action-failed", { action: "start-game", message: message || "Failed to start game" })
      }
    })

    socket.on("claim-bingo", async ({ roomId, playerId, playerName, winningPattern }) => {
      const { success, gameState, message } = await roomManager.claimBingo(roomId, playerId, playerName, winningPattern)
      if (success && gameState) {
        io.to(roomId).emit("game-state-update", gameState)
        io.emit("rooms-update", await roomManager.getAllRooms()) // Update room status in lobby
      } else {
        socket.emit("game-action-failed", { action: "claim-bingo", message: message || "Failed to claim bingo" })
      }
    })

    socket.on("reset-game", async ({ roomId }: { roomId: string }) => {
      const { success, gameState, message } = await roomManager.resetGame(roomId)
      if (success && gameState) {
        io.to(roomId).emit("game-state-update", gameState)
        io.emit("rooms-update", await roomManager.getAllRooms()) // Update room status in lobby
      } else {
        socket.emit("game-action-failed", { action: "reset-game", message: message || "Failed to reset game" })
      }
    })

    // Board Selection Actions
    socket.on(
      "select-board",
      async ({
        roomId,
        playerId,
        playerName,
        boardNumber,
      }: { roomId: string; playerId: string; playerName: string; boardNumber: number }) => {
        const { success, selections, message } = await roomManager.selectBoard(
          roomId,
          playerId,
          playerName,
          boardNumber,
        )
        if (success && selections) {
          io.to(roomId).emit("board-selections-update", selections)
        } else {
          socket.emit("board-action-failed", { action: "select-board", message: message || "Failed to select board" })
        }
      },
    )

    socket.on("deselect-board", async ({ roomId, playerId }: { roomId: string; playerId: string }) => {
      const { success, selections, message } = await roomManager.deselectBoard(roomId, playerId)
      if (success && selections) {
        io.to(roomId).emit("board-selections-update", selections)
      } else {
        socket.emit("board-action-failed", { action: "deselect-board", message: message || "Failed to deselect board" })
      }
    })

    // Refresh rooms
    socket.on("refresh-rooms", async () => {
      socket.emit("rooms-update", await roomManager.getAllRooms())
    })

    // Handle disconnect
    socket.on("disconnect", async () => {
      console.log("User disconnected:", socket.id)
      // Aggressive cleanup for all players (especially guests) not currently active
      // This is a more robust way to handle unexpected disconnects
      const activePlayerIds = new Set(
        Array.from(io.sockets.sockets.values())
          .map((s) => s.data.playerId)
          .filter(Boolean),
      )
      await GameStateManager.aggressiveGhostCleanup(activePlayerIds as Set<string>)
      io.emit("rooms-update", await roomManager.getAllRooms()) // Update lobby after cleanup
    })

    // Store player ID on socket for easier lookup during disconnect
    socket.on("set-player-id", ({ playerId }: { playerId: string }) => {
      socket.data.playerId = playerId
      console.log(`Socket ${socket.id} associated with player ID: ${playerId}`)
    })
  })

  return io
}
