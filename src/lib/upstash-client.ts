import { Redis } from "@upstash/redis"
import type { GameRoom } from "@/types/game"

// Initialize Redis client with better error handling and logging
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN

console.log("🔧 Redis Configuration Check:")
console.log("- URL exists:", !!redisUrl)
console.log("- Token exists:", !!redisToken)
console.log("- URL length:", redisUrl?.length || 0)
console.log("- Token length:", redisToken?.length || 0)

if (!redisUrl || !redisToken) {
  console.error("❌ Missing Redis configuration:")
  console.error(
    "Available env vars:",
    Object.keys(process.env).filter((key) => key.includes("REDIS") || key.includes("KV") || key.includes("UPSTASH")),
  )
  throw new Error(`Redis configuration missing: URL=${!!redisUrl}, Token=${!!redisToken}`)
}

export const redis = new Redis({
  url: redisUrl,
  token: redisToken,
})

// Game state management with Redis
export class GameStateManager {
  // Store game state in Redis with TTL
  static async setGameState(roomId: string, state: unknown) {
    try {
      console.log(`💾 Setting game state for room ${roomId}:`, state)
      await redis.setex(`game:${roomId}`, 3600, JSON.stringify(state)) // 1 hour TTL
      console.log(`✅ Game state set for room ${roomId}`)
    } catch (error) {
      console.error(`Error setting game state for room ${roomId}:`, error)
      throw new Error(`Failed to set game state: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  static async getGameState(roomId: string) {
    try {
      const data = await redis.get(`game:${roomId}`)
      if (!data) {
        console.log(`📭 No game state found for room ${roomId}`)
        return null
      }

      // Handle both string and object responses
      let gameState
      if (typeof data === "string") {
        gameState = JSON.parse(data)
      } else {
        gameState = data // Already parsed by Upstash client
      }

      console.log(`📖 Retrieved game state for room ${roomId}:`, {
        status: gameState.gameStatus,
        calledNumbers: gameState.calledNumbers?.length || 0,
        currentNumber: gameState.currentNumber,
      })

      return gameState
    } catch (error) {
      console.error(`Error getting game state for room ${roomId}:`, error)
      // Delete corrupted data
      try {
        await redis.del(`game:${roomId}`)
      } catch {}
      return null
    }
  }

  // NEW: Reset game state for a room
  static async resetGameState(roomId: string) {
    try {
      console.log(`🔄 Resetting game state for room ${roomId}`)

      const freshGameState = {
        roomId,
        calledNumbers: [],
        currentNumber: null,
        gameStatus: "waiting",
        winners: [],
        lastUpdate: new Date().toISOString(),
      }

      await this.setGameState(roomId, freshGameState)
      console.log(`✅ Game state reset for room ${roomId}`)

      return freshGameState
    } catch (error) {
      console.error(`Error resetting game state for room ${roomId}:`, error)
      throw new Error(`Failed to reset game state: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  // Board selections management - Enhanced with cleanup
  static async setBoardSelection(roomId: string, playerId: string, selection: unknown) {
    try {
      // Ensure selection is properly serialized
      const serializedSelection = JSON.stringify(selection)
      await redis.hset(`boards:${roomId}`, { [playerId]: serializedSelection })
    } catch (error) {
      console.error(`Error setting board selection for room ${roomId}, player ${playerId}:`, error)
      throw new Error(`Failed to set board selection: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  static async getBoardSelections(roomId: string) {
    try {
      const selections = await redis.hgetall(`boards:${roomId}`)
      if (!selections || Object.keys(selections).length === 0) return []

      // Get current room to check active players
      const room = await this.getRoom(roomId)
      const activePlayerIds = new Set(room?.players?.map((p) => p.id) || [])

      const validSelections = []
      const corruptedKeys = []
      const inactivePlayerKeys = []

      for (const [playerId, data] of Object.entries(selections)) {
        try {
          // Check if player is still in the room
          if (!activePlayerIds.has(playerId)) {
            console.log(`🧹 Player ${playerId} no longer in room, marking for cleanup`)
            inactivePlayerKeys.push(playerId)
            continue
          }

          // Handle different data types
          let parsedData
          if (typeof data === "string") {
            // Check if it's valid JSON
            if (data.startsWith("{") || data.startsWith("[")) {
              parsedData = JSON.parse(data)
            } else {
              // Invalid JSON string
              console.warn(`Invalid JSON for player ${playerId}:`, data)
              corruptedKeys.push(playerId)
              continue
            }
          } else if (typeof data === "object" && data !== null) {
            parsedData = data
          } else {
            // Invalid data type
            console.warn(`Invalid data type for player ${playerId}:`, typeof data, data)
            corruptedKeys.push(playerId)
            continue
          }

          // Validate the parsed data structure
          if (parsedData && typeof parsedData === "object" && (parsedData as any).boardNumber) {
            validSelections.push({
              playerId,
              ...parsedData,
            })
          } else {
            console.warn(`Invalid selection structure for player ${playerId}:`, parsedData)
            corruptedKeys.push(playerId)
          }
        } catch (error) {
          console.error(`Error parsing selection for player ${playerId}:`, error)
          corruptedKeys.push(playerId)
        }
      }

      // Clean up corrupted entries and inactive players
      const keysToCleanup = [...corruptedKeys, ...inactivePlayerKeys]
      if (keysToCleanup.length > 0) {
        console.log(
          `🧹 Cleaning up ${keysToCleanup.length} board selections (${corruptedKeys.length} corrupted, ${inactivePlayerKeys.length} inactive players)`,
        )
        try {
          await redis.hdel(`boards:${roomId}`, ...keysToCleanup)
        } catch (error) {
          console.error("Error cleaning up board selections:", error)
        }
      }

      console.log(`📊 Returning ${validSelections.length} valid board selections for room ${roomId}`)
      return validSelections
    } catch (error) {
      console.error(`Error getting board selections for room ${roomId}:`, error)
      // If there's a major error, clear the entire hash and return empty array
      try {
        await redis.del(`boards:${roomId}`)
      } catch {}
      return []
    }
  }

  static async removeBoardSelection(roomId: string, playerId: string) {
    try {
      await redis.hdel(`boards:${roomId}`, playerId)
    } catch (error) {
      console.error(`Error removing board selection for room ${roomId}, player ${playerId}:`, error)
      throw new Error(`Failed to remove board selection: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  // NEW: Remove player from all board selections across all rooms
  static async removePlayerFromAllBoardSelections(playerId: string) {
    try {
      console.log(`🧹 Removing player ${playerId} from all board selections...`)

      const boardKeys = await redis.keys("boards:*")
      let removedFromBoards = 0

      for (const key of boardKeys) {
        try {
          const roomId = key.replace("boards:", "")
          const selections = await redis.hgetall(key)

          if (selections && (selections as any)[playerId]) {
            await redis.hdel(key, playerId)
            removedFromBoards++
            console.log(`🗑️ Removed board selection for player ${playerId} from room ${roomId}`)
          }
        } catch (error) {
          console.error(`Error removing board selection from ${key}:`, error)
        }
      }

      console.log(`✅ Removed player ${playerId} from ${removedFromBoards} board selections`)
      return removedFromBoards
    } catch (error) {
      console.error(`Error removing player ${playerId} from all board selections:`, error)
      return 0
    }
  }

  // Clean up board selections for players no longer in room
  static async cleanupBoardSelections(roomId: string) {
    try {
      console.log(`🧹 Cleaning up board selections for room ${roomId}`)

      const room = await this.getRoom(roomId)
      if (!room) {
        // Room doesn't exist, clear all board selections
        await redis.del(`boards:${roomId}`)
        console.log(`🗑️ Cleared all board selections for non-existent room ${roomId}`)
        return
      }

      const activePlayerIds = new Set(room.players?.map((p) => p.id) || [])
      const selections = await redis.hgetall(`boards:${roomId}`)

      if (!selections || Object.keys(selections).length === 0) return

      const inactivePlayerKeys = []
      for (const playerId of Object.keys(selections)) {
        if (!activePlayerIds.has(playerId)) {
          inactivePlayerKeys.push(playerId)
        }
      }

      if (inactivePlayerKeys.length > 0) {
        await redis.hdel(`boards:${roomId}`, ...inactivePlayerKeys)
        console.log(`🧹 Removed ${inactivePlayerKeys.length} board selections from inactive players in room ${roomId}`)
      }
    } catch (error) {
      console.error(`Error cleaning up board selections for room ${roomId}:`, error)
    }
  }

  // Room management - Now properly typed to accept GameRoom with better error handling
  static async setRoom(roomId: string, room: GameRoom) {
    try {
      console.log(`🏠 Setting room ${roomId}...`)

      // Validate required fields
      if (!room.id || !room.stake || typeof room.stake !== "number") {
        throw new Error(`Invalid room data: missing id or stake`)
      }

      // Ensure the room object is properly serializable - convert to plain object
      const roomData = {
        id: String(room.id || roomId),
        stake: Number(room.stake || 0),
        players: Array.isArray(room.players)
          ? room.players.map((player) => ({
              id: String(player.id),
              name: String(player.name || "Guest"),
              telegramId: player.telegramId ? Number(player.telegramId) : undefined,
              avatar: player.avatar ? String(player.avatar) : undefined,
              joinedAt:
                player.joinedAt instanceof Date
                  ? player.joinedAt.toISOString()
                  : String(player.joinedAt || new Date().toISOString()),
            }))
          : [],
        maxPlayers: Number(room.maxPlayers || 100),
        status: String(room.status || "waiting"),
        prize: Number(room.prize || 0),
        activeGames: Number(room.activeGames || 0),
        hasBonus: Boolean(room.hasBonus !== false),
        createdAt:
          room.createdAt instanceof Date
            ? room.createdAt.toISOString()
            : String(room.createdAt || new Date().toISOString()),
        gameStartTime:
          room.gameStartTime instanceof Date
            ? room.gameStartTime.toISOString()
            : room.gameStartTime
              ? String(room.gameStartTime)
              : undefined,
        calledNumbers: Array.isArray(room.calledNumbers) ? room.calledNumbers.map((n) => Number(n)) : [],
        currentNumber: room.currentNumber ? Number(room.currentNumber) : undefined,
      }

      console.log(`📝 Room data prepared for ${roomId}:`, {
        id: roomData.id,
        stake: roomData.stake,
        playersCount: roomData.players.length,
        status: roomData.status,
      })

      // Test Redis connection before attempting to set
      const connectionTest = await this.testConnection()
      if (!connectionTest) {
        throw new Error("Redis connection test failed")
      }

      // Use setex with string serialization to avoid type issues
      const serializedRoom = JSON.stringify(roomData)
      console.log(`💾 Serialized room size: ${serializedRoom.length} characters`)

      await redis.setex(`room:${roomId}`, 7200, serializedRoom) // 2 hours TTL
      console.log(`✅ Successfully set room ${roomId}`)

      // Clean up board selections after room update
      await this.cleanupBoardSelections(roomId)
    } catch (error) {
      console.error(`❌ Error setting room ${roomId}:`, error)
      console.error(`Room data:`, room)
      throw new Error(`Failed to set room: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  static async getRoom(roomId: string): Promise<GameRoom | null> {
    try {
      const data = await redis.get(`room:${roomId}`)
      if (!data) return null

      // Handle both string and object responses
      let roomData
      if (typeof data === "string") {
        roomData = JSON.parse(data)
      } else {
        roomData = data // Already parsed by Upstash client
      }

      // Convert date strings back to Date objects and ensure proper types
      if (roomData.createdAt && typeof roomData.createdAt === "string") {
        roomData.createdAt = new Date(roomData.createdAt)
      }
      if (roomData.gameStartTime && typeof roomData.gameStartTime === "string") {
        roomData.gameStartTime = new Date(roomData.gameStartTime)
      }

      // Convert player joinedAt back to Date objects
      if (Array.isArray(roomData.players)) {
        roomData.players = roomData.players.map(
          (player: {
            id: string
            name: string
            telegramId?: number
            avatar?: string
            joinedAt: string | Date
          }) => ({
            ...player,
            joinedAt: player.joinedAt ? new Date(player.joinedAt) : new Date(),
          }),
        )
      }

      return roomData as GameRoom
    } catch (error) {
      console.error(`Error getting room ${roomId}:`, error)
      // Delete corrupted data
      try {
        await redis.del(`room:${roomId}`)
      } catch {}
      return null
    }
  }

  static async getAllRooms(): Promise<GameRoom[]> {
    try {
      const keys = await redis.keys("room:*")
      if (keys.length === 0) return []

      const rooms = await Promise.all(
        keys.map(async (key) => {
          try {
            const data = await redis.get(key)
            if (!data) return null

            // Handle both string and object responses
            let roomData
            if (typeof data === "string") {
              roomData = JSON.parse(data)
            } else {
              roomData = data // Already parsed by Upstash client
            }

            // Convert date strings back to Date objects
            if (roomData.createdAt && typeof roomData.createdAt === "string") {
              roomData.createdAt = new Date(roomData.createdAt)
            }
            if (roomData.gameStartTime && typeof roomData.gameStartTime === "string") {
              roomData.gameStartTime = new Date(roomData.gameStartTime)
            }

            // Convert player joinedAt back to Date objects
            if (Array.isArray(roomData.players)) {
              roomData.players = roomData.players.map(
                (player: {
                  id: string
                  name: string
                  telegramId?: number
                  avatar?: string
                  joinedAt: string | Date
                }) => ({
                  ...player,
                  joinedAt: player.joinedAt ? new Date(player.joinedAt) : new Date(),
                }),
              )
            }

            return roomData as GameRoom
          } catch (error) {
            console.error(`Error parsing room data for key ${key}:`, error)
            // Delete corrupted data
            try {
              await redis.del(key)
            } catch {}
            return null
          }
        }),
      )
      return rooms.filter((room): room is GameRoom => room !== null)
    } catch (error) {
      console.error("Error getting all rooms:", error)
      return []
    }
  }

  // NEW: Ensure default rooms exist
  static async ensureDefaultRooms() {
    const stakes = [10, 20, 30, 50, 100]
    for (const stake of stakes) {
      const roomId = `room-${stake}` // Use a consistent ID for default rooms
      const existingRoom = await GameStateManager.getRoom(roomId)
      if (existingRoom) {
        console.log(`✅ Room ${roomId} already exists, skipping creation.`)
        continue
      }

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

      try {
        console.log(`Creating default room: ${roomId}`)
        await GameStateManager.setRoom(roomId, room)
        console.log(`✅ Created default room: ${roomId}`)
      } catch (error) {
        console.error(`❌ Failed to create default room ${roomId}:`, error)
      }
    }
  }

  // Player session management
  static async setPlayerSession(playerId: string, roomId: string) {
    try {
      await redis.setex(`player:${playerId}`, 3600, roomId)
      console.log(`📝 Set player session: ${playerId} -> ${roomId}`)
    } catch (error) {
      console.error(`Error setting player session for ${playerId}:`, error)
      throw new Error(`Failed to set player session: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  static async getPlayerSession(playerId: string) {
    try {
      return await redis.get(`player:${playerId}`)
    } catch (error) {
      console.error(`Error getting player session for ${playerId}:`, error)
      return null
    }
  }

  static async removePlayerSession(playerId: string) {
    try {
      await redis.del(`player:${playerId}`)
      console.log(`🗑️ Removed player session: ${playerId}`)
    } catch (error) {
      console.error(`Error removing player session for ${playerId}:`, error)
    }
  }

  // Enhanced method to remove player from all rooms and clean up board selections
  static async removePlayerFromAllRooms(playerId: string) {
    try {
      console.log(`🧹 Removing player ${playerId} from all rooms...`)

      const rooms = await this.getAllRooms()
      let removedFromRooms = 0

      for (const room of rooms) {
        if (Array.isArray(room.players)) {
          const originalPlayerCount = room.players.length
          room.players = room.players.filter((player) => player.id !== playerId)

          if (room.players.length !== originalPlayerCount) {
            // Player was in this room, update it
            room.prize = room.players.length * room.stake

            // Only reset room if completely empty
            if (room.players.length === 0) {
              room.status = "waiting"
              room.activeGames = 0
              room.calledNumbers = []
              room.currentNumber = undefined
              room.gameStartTime = undefined

              // Reset game state
              await this.resetGameState(room.id)
            }
            // Remove the condition that resets when < 2 players

            await this.setRoom(room.id, room)

            // Also remove their board selection
            await this.removeBoardSelection(room.id, playerId)

            removedFromRooms++
            console.log(`🏠 Removed player from room ${room.id} (${originalPlayerCount} -> ${room.players.length})`)
          }
        }
      }

      console.log(`✅ Player ${playerId} removed from ${removedFromRooms} rooms`)
      return removedFromRooms
    } catch (error) {
      console.error(`Error removing player ${playerId} from all rooms:`, error)
      return 0
    }
  }

  // Enhanced method to remove player by Telegram ID from all rooms (prevents duplicate joins)
  static async removePlayerByTelegramId(telegramId: number, excludePlayerId?: string) {
    try {
      console.log(`🧹 Removing all players with Telegram ID ${telegramId} from all rooms...`)
      if (excludePlayerId) {
        console.log(`🔒 Excluding player ID: ${excludePlayerId}`)
      }

      const rooms = await this.getAllRooms()
      let removedFromRooms = 0
      const removedPlayerIds: string[] = []

      for (const room of rooms) {
        if (Array.isArray(room.players)) {
          const originalPlayerCount = room.players.length

          // Remove players with matching Telegram ID (except the excluded one)
          const playersToRemove = room.players.filter(
            (player) => player.telegramId === telegramId && player.id !== excludePlayerId,
          )

          if (playersToRemove.length > 0) {
            // Track removed player IDs for cleanup
            playersToRemove.forEach((player) => removedPlayerIds.push(player.id))

            // Remove the players
            room.players = room.players.filter(
              (player) => !(player.telegramId === telegramId && player.id !== excludePlayerId),
            )

            room.prize = room.players.length * room.stake

            // Reset room if empty or insufficient players
            if (room.players.length === 0) {
              room.status = "waiting"
              room.activeGames = 0
              room.calledNumbers = []
              room.currentNumber = undefined
              room.gameStartTime = undefined
              await this.resetGameState(room.id)
            } else if (room.players.length < 2 && room.status !== "waiting") {
              room.status = "waiting"
              room.activeGames = 0
              room.calledNumbers = []
              room.currentNumber = undefined
              room.gameStartTime = undefined
              await this.resetGameState(room.id)
            }

            await this.setRoom(room.id, room)
            removedFromRooms++

            console.log(
              `🏠 Removed ${playersToRemove.length} duplicate players from room ${room.id} (${originalPlayerCount} -> ${room.players.length})`,
            )
          }
        }
      }

      // Clean up sessions and board selections for removed players
      for (const playerId of removedPlayerIds) {
        await this.removePlayerSession(playerId)
        await this.removePlayerFromAllBoardSelections(playerId)
        console.log(`🗑️ Cleaned up session and board selections for duplicate player: ${playerId}`)
      }

      console.log(
        `✅ Telegram user ${telegramId} duplicates removed from ${removedFromRooms} rooms (${removedPlayerIds.length} duplicate sessions cleaned)`,
      )
      return { removedFromRooms, removedPlayerIds }
    } catch (error) {
      console.error(`Error removing Telegram user ${telegramId} duplicates:`, error)
      return { removedFromRooms: 0, removedPlayerIds: [] }
    }
  }

  // GENTLE GHOST PLAYER CLEANUP - Only remove truly inactive players
  static async gentleGhostCleanup(activePlayerIds: Set<string> = new Set()) {
    try {
      console.log(`🧹 Starting gentle ghost player cleanup...`)
      console.log(`🔒 Protected player IDs:`, Array.from(activePlayerIds))

      const rooms = await this.getAllRooms()
      let totalGhostPlayersRemoved = 0
      const now = new Date()
      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000) // 30 minutes threshold

      for (const room of rooms) {
        if (Array.isArray(room.players) && room.players.length > 0) {
          const originalPlayerCount = room.players.length

          // Only remove players that are:
          // 1. Guest players (not Telegram users)
          // 2. Not in the protected list
          // 3. Joined more than 30 minutes ago (truly inactive)
          room.players = room.players.filter((player) => {
            const isProtected = activePlayerIds.has(player.id)
            const isGuestPlayer = player.id.startsWith("guest-")
            const isTelegramUser = !isGuestPlayer

            // Always keep Telegram users and protected players
            if (isTelegramUser || isProtected) {
              return true
            }

            // For guest players, check if they're truly inactive (30+ minutes old)
            if (isGuestPlayer && player.joinedAt) {
              const joinedAt = player.joinedAt instanceof Date ? player.joinedAt : new Date(player.joinedAt)
              const isOldSession = joinedAt < thirtyMinutesAgo

              if (isOldSession) {
                console.log(
                  `👻 Removing old ghost guest player ${player.id} from room ${room.id} (joined: ${joinedAt.toISOString()})`,
                )
                return false
              }
            }

            return true
          })

          // Update prize based on current player count
          room.prize = room.players.length * room.stake

          // Only reset room status if completely empty
          if (room.players.length === 0 && room.status !== "waiting") {
            room.status = "waiting"
            room.activeGames = 0
            room.calledNumbers = []
            room.currentNumber = undefined
            room.gameStartTime = undefined

            // Reset game state
            await this.resetGameState(room.id)
            console.log(`🔄 Reset room ${room.id} to waiting state (no active players)`)
          }

          const ghostPlayersRemoved = originalPlayerCount - room.players.length
          if (ghostPlayersRemoved > 0) {
            totalGhostPlayersRemoved += ghostPlayersRemoved
            await this.setRoom(room.id, room)
            console.log(`🧹 Removed ${ghostPlayersRemoved} old ghost players from room ${room.id}`)
          }
        }
      }

      // Handle duplicate Telegram users more carefully
      let duplicateTelegramUsers = 0
      const telegramUserSessions = new Map<number, Array<{ playerId: string; joinedAt: Date; roomId: string }>>()

      // Collect all Telegram user sessions across all rooms
      for (const room of rooms) {
        if (Array.isArray(room.players)) {
          room.players.forEach((player) => {
            if (player.telegramId && typeof player.telegramId === "number") {
              if (!telegramUserSessions.has(player.telegramId)) {
                telegramUserSessions.set(player.telegramId, [])
              }
              telegramUserSessions.get(player.telegramId)!.push({
                playerId: player.id,
                joinedAt: player.joinedAt instanceof Date ? player.joinedAt : new Date(player.joinedAt),
                roomId: room.id,
              })
            }
          })
        }
      }

      // Only remove duplicate Telegram sessions if there are more than 2 for the same user
      for (const [telegramId, sessions] of telegramUserSessions.entries()) {
        if (sessions.length > 2) {
          // Only clean up if more than 2 sessions
          console.log(`🔍 Found ${sessions.length} sessions for Telegram user ${telegramId}`)

          // Sort by joinedAt (most recent first)
          sessions.sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())

          // Keep the most recent session and one backup, remove the rest
          const sessionsToRemove = sessions.slice(2)

          console.log(`🔒 Keeping 2 most recent sessions, removing ${sessionsToRemove.length} old ones`)

          // Remove old duplicate sessions
          for (const session of sessionsToRemove) {
            const room = await this.getRoom(session.roomId)
            if (room && Array.isArray(room.players)) {
              const originalCount = room.players.length
              room.players = room.players.filter((p) => p.id !== session.playerId)

              if (room.players.length !== originalCount) {
                duplicateTelegramUsers++
                room.prize = room.players.length * room.stake
                await this.setRoom(room.id, room)

                // Clean up session and board selections
                await this.removePlayerSession(session.playerId)
                await this.removePlayerFromAllBoardSelections(session.playerId)

                console.log(`🧹 Removed old duplicate session ${session.playerId} from room ${session.roomId}`)
              }
            }
          }
        }
      }

      console.log(`🧹 Gentle cleanup completed:`)
      console.log(`   - ${totalGhostPlayersRemoved} old ghost players removed`)
      console.log(`   - ${duplicateTelegramUsers} old duplicate Telegram sessions removed`)

      return {
        ghostPlayersRemoved: totalGhostPlayersRemoved,
        duplicateTelegramUsers: duplicateTelegramUsers,
      }
    } catch (error) {
      console.error("Error during gentle ghost cleanup:", error)
      return {
        ghostPlayersRemoved: 0,
        duplicateTelegramUsers: 0,
      }
    }
  }

  // AGGRESSIVE GHOST PLAYER CLEANUP - Remove all guest players except current active ones
  static async aggressiveGhostCleanup(activePlayerIds: Set<string> = new Set()) {
    try {
      console.log(`🔥 Starting aggressive ghost player cleanup...`)
      console.log(`🔒 Protected player IDs:`, Array.from(activePlayerIds))

      const rooms = await this.getAllRooms()
      let totalGhostPlayersRemoved = 0

      for (const room of rooms) {
        if (Array.isArray(room.players) && room.players.length > 0) {
          const originalPlayerCount = room.players.length

          // Remove ALL guest players except those in the protected list
          room.players = room.players.filter((player) => {
            const isProtected = activePlayerIds.has(player.id)
            const isGuestPlayer = player.id.startsWith("guest-")
            const isTelegramUser = !isGuestPlayer // Telegram users have numeric IDs

            // Keep if: protected, OR is a real Telegram user
            const shouldKeep = isProtected || isTelegramUser

            if (!shouldKeep && isGuestPlayer) {
              console.log(`👻 Removing ghost guest player ${player.id} from room ${room.id}`)
            }

            return shouldKeep
          })

          // Update prize based on current player count
          room.prize = room.players.length * room.stake

          // Reset room status if no players left or insufficient players
          if (room.players.length === 0 && room.status !== "waiting") {
            room.status = "waiting"
            room.activeGames = 0
            room.calledNumbers = []
            room.currentNumber = undefined
            room.gameStartTime = undefined

            // Reset game state
            await this.resetGameState(room.id)
            console.log(`🔄 Reset room ${room.id} to waiting state (no active players)`)
          } else if (room.players.length < 2 && room.status !== "waiting") {
            // If we go below minimum players and game was active, reset
            room.status = "waiting"
            room.activeGames = 0
            room.calledNumbers = []
            room.currentNumber = undefined
            room.gameStartTime = undefined

            // Reset game state
            await this.resetGameState(room.id)
            console.log(`🔄 Reset room ${room.id} due to insufficient players`)
          }

          const ghostPlayersRemoved = originalPlayerCount - room.players.length
          if (ghostPlayersRemoved > 0) {
            totalGhostPlayersRemoved += ghostPlayersRemoved
            await this.setRoom(room.id, room)
            console.log(`🧹 Removed ${ghostPlayersRemoved} ghost players from room ${room.id}`)
          }
        }
      }

      // Additional cleanup: Remove duplicate Telegram users (same Telegram ID, different sessions)
      let duplicateTelegramUsers = 0
      const telegramUserMap = new Map<number, string[]>() // telegramId -> [playerIds]

      for (const room of rooms) {
        if (Array.isArray(room.players) && room.players.length > 0) {
          // Group players by Telegram ID
          room.players.forEach((player) => {
            if (player.telegramId && typeof player.telegramId === "number") {
              if (!telegramUserMap.has(player.telegramId)) {
                telegramUserMap.set(player.telegramId, [])
              }
              telegramUserMap.get(player.telegramId)!.push(player.id)
            }
          })
        }
      }

      // Find and remove duplicate Telegram users (keep the most recent session)
      for (const [telegramId, playerIds] of telegramUserMap.entries()) {
        if (playerIds.length > 1) {
          console.log(`🔍 Found ${playerIds.length} duplicate sessions for Telegram user ${telegramId}:`, playerIds)

          // Keep only the most recent session (last in array, or protected one if exists)
          const protectedPlayerId = playerIds.find((id) => activePlayerIds.has(id))
          const playerIdToKeep = protectedPlayerId || playerIds[playerIds.length - 1]
          const playerIdsToRemove = playerIds.filter((id) => id !== playerIdToKeep)

          console.log(`🔒 Keeping session: ${playerIdToKeep}, removing: [${playerIdsToRemove.join(", ")}]`)

          // Remove duplicate sessions from all rooms
          for (const room of rooms) {
            if (Array.isArray(room.players)) {
              const originalCount = room.players.length
              room.players = room.players.filter(
                (player) => !(player.telegramId === telegramId && playerIdsToRemove.includes(player.id)),
              )

              const removedCount = originalCount - room.players.length
              if (removedCount > 0) {
                duplicateTelegramUsers += removedCount
                room.prize = room.players.length * room.stake

                // Reset room if needed
                if (room.players.length === 0 && room.status !== "waiting") {
                  room.status = "waiting"
                  room.activeGames = 0
                  room.calledNumbers = []
                  room.currentNumber = undefined
                  room.gameStartTime = undefined
                  await this.resetGameState(room.id)
                }

                await this.setRoom(room.id, room)
                console.log(`🧹 Removed ${removedCount} duplicate Telegram sessions from room ${room.id}`)
              }
            }
          }

          // Clean up sessions and board selections for removed duplicates
          for (const playerId of playerIdsToRemove) {
            await this.removePlayerSession(playerId)
            await this.removePlayerFromAllBoardSelections(playerId)
          }
        }
      }

      // Also clean up orphaned player sessions for guest players
      const playerSessionKeys = await redis.keys("player:guest-*")
      let cleanedSessions = 0

      for (const key of playerSessionKeys) {
        const playerId = key.replace("player:", "")
        if (!activePlayerIds.has(playerId)) {
          await redis.del(key)
          cleanedSessions++
          console.log(`🗑️ Removed orphaned session for ghost player: ${playerId}`)
        }
      }

      // Clean up orphaned board selections for guest players
      const boardKeys = await redis.keys("boards:*")
      let cleanedBoardSelections = 0

      for (const key of boardKeys) {
        const roomId = key.replace("boards:", "")
        const selections = await redis.hgetall(key)

        if (selections && Object.keys(selections).length > 0) {
          const ghostPlayerKeys = []

          for (const playerId of Object.keys(selections)) {
            if (playerId.startsWith("guest-") && !activePlayerIds.has(playerId)) {
              ghostPlayerKeys.push(playerId)
            }
          }

          if (ghostPlayerKeys.length > 0) {
            await redis.hdel(key, ...ghostPlayerKeys)
            cleanedBoardSelections += ghostPlayerKeys.length
            console.log(`🧹 Removed ${ghostPlayerKeys.length} ghost board selections from room ${roomId}`)
          }
        }
      }

      console.log(`🔥 Aggressive cleanup completed:`)
      console.log(`   - ${totalGhostPlayersRemoved} ghost players removed from rooms`)
      console.log(`   - ${cleanedSessions} orphaned player sessions cleaned`)
      console.log(`   - ${cleanedBoardSelections} ghost board selections removed`)

      return {
        ghostPlayersRemoved: 0,
        sessionsRemoved: 0,
        boardSelectionsRemoved: 0,
        duplicateTelegramUsers: 0,
      }
    } catch (error) {
      console.error("Error during aggressive ghost cleanup:", error)
      return {
        ghostPlayersRemoved: 0,
        sessionsRemoved: 0,
        boardSelectionsRemoved: 0,
        duplicateTelegramUsers: 0,
      }
    }
  }

  // Game number calling with auto-increment - FIXED VERSION
  static async callNextNumber(roomId: string) {
    try {
      console.log(`🎲 Calling next number for room: ${roomId}`)

      let gameState = await this.getGameState(roomId)
      if (!gameState) {
        console.log(`❌ No game state found for room ${roomId}, creating new one`)
        // Create a new game state if it doesn't exist
        gameState = {
          roomId,
          calledNumbers: [],
          currentNumber: null,
          gameStatus: "active",
          winners: [],
          lastUpdate: new Date().toISOString(),
        }
        await this.setGameState(roomId, gameState)
      }

      if (gameState.gameStatus !== "active") {
        console.log(`⏹️ Game not active for room ${roomId}, status: ${gameState.gameStatus}`)
        return null
      }

      // Ensure calledNumbers is an array
      if (!Array.isArray(gameState.calledNumbers)) {
        console.log(`🔧 Initializing calledNumbers array for room ${roomId}`)
        gameState.calledNumbers = []
      }

      // Get available numbers (1-75 that haven't been called)
      const availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1).filter(
        (num) => !gameState.calledNumbers.includes(num),
      )

      console.log(`📊 Available numbers for room ${roomId}: ${availableNumbers.length}/75`)
      console.log(`📋 Already called: [${gameState.calledNumbers.join(", ")}]`)

      if (availableNumbers.length === 0) {
        // Game over - all numbers called
        console.log(`🏁 All numbers called for room ${roomId}, finishing game`)
        gameState.gameStatus = "finished"
        gameState.lastUpdate = new Date().toISOString()
        await this.setGameState(roomId, gameState)
        return null
      }

      // Pick a random available number
      const randomIndex = Math.floor(Math.random() * availableNumbers.length)
      const newNumber = availableNumbers[randomIndex]

      console.log(`🎯 Selected number: ${newNumber} (${randomIndex + 1}/${availableNumbers.length} available)`)

      // Update game state
      gameState.currentNumber = newNumber
      gameState.calledNumbers.push(newNumber)
      gameState.lastUpdate = new Date().toISOString()

      console.log(`💾 Updating game state for room ${roomId} with new number ${newNumber}`)
      await this.setGameState(roomId, gameState)

      console.log(`✅ Successfully called number ${newNumber} for room ${roomId}`)
      console.log(`📊 Total called: ${gameState.calledNumbers.length}/75`)

      return newNumber
    } catch (error) {
      console.error(`❌ Error calling next number for room ${roomId}:`, error)
      return null
    }
  }

  // Auto number calling scheduler
  static async scheduleNumberCalling(roomId: string) {
    try {
      console.log(`⏰ Scheduling number calling for room ${roomId}`)
      const key = `scheduler:${roomId}`
      await redis.setex(key, 300, "active") // 5 minutes TTL
      console.log(`✅ Number calling scheduled for room ${roomId}`)
    } catch (error) {
      console.error(`Error scheduling number calling for room ${roomId}:`, error)
    }
  }

  static async isNumberCallingActive(roomId: string) {
    try {
      const key = `scheduler:${roomId}`
      const exists = await redis.exists(key)
      console.log(`🔍 Number calling active for room ${roomId}: ${exists ? "YES" : "NO"}`)
      return exists
    } catch (error) {
      console.error(`Error checking number calling status for room ${roomId}:`, error)
      return false
    }
  }

  // Test Redis connection with detailed logging
  static async testConnection() {
    try {
      console.log("🧪 Testing Redis connection...")
      const testKey = "connection-test"
      const testValue = "test-value"

      console.log("📝 Setting test value...")
      await redis.set(testKey, testValue)

      console.log("📖 Getting test value...")
      const result = await redis.get(testKey)

      console.log("🗑️ Deleting test value...")
      await redis.del(testKey)

      const success = result === testValue
      console.log(`✅ Redis connection test ${success ? "passed" : "failed"}`)
      return success
    } catch (error) {
      console.error("❌ Redis connection test failed:", error)
      return false
    }
  }

  // Enhanced cleanup with board selection cleanup
  static async cleanup() {
    try {
      console.log("🧹 Starting Redis cleanup...")

      // Clean up expired game data
      const gameKeys = await redis.keys("game:*")
      let cleanedGames = 0
      for (const key of gameKeys) {
        try {
          const ttl = await redis.ttl(key)
          if (ttl <= 0) {
            await redis.del(key)
            cleanedGames++
          }
        } catch {
          console.error(`Error cleaning game key ${key}`)
          try {
            await redis.del(key)
            cleanedGames++
          } catch {}
        }
      }

      // Clean up expired player sessions
      const playerKeys = await redis.keys("player:*")
      let cleanedSessions = 0
      for (const key of playerKeys) {
        try {
          const ttl = await redis.ttl(key)
          if (ttl <= 0) {
            await redis.del(key)
            cleanedSessions++
          }
        } catch {
          console.error(`Error cleaning player session key ${key}`)
          try {
            await redis.del(key)
            cleanedSessions++
          } catch {}
        }
      }

      // Clean up corrupted room data
      const roomKeys = await redis.keys("room:*")
      let cleanedRooms = 0
      for (const key of roomKeys) {
        try {
          const data = await redis.get(key)
          if (data && typeof data === "string") {
            JSON.parse(data) // Test if it's valid JSON
          }
        } catch {
          console.log(`Deleting corrupted room data: ${key}`)
          try {
            await redis.del(key)
            cleanedRooms++
          } catch {}
        }
      }

      // Clean up board selections for all rooms
      const boardKeys = await redis.keys("boards:*")
      let cleanedBoards = 0
      for (const key of boardKeys) {
        try {
          const roomId = key.replace("boards:", "")
          await this.cleanupBoardSelections(roomId)
          cleanedBoards++
        } catch {
          console.log(`Deleting corrupted board data: ${key}`)
          try {
            await redis.del(key)
            cleanedBoards++
          } catch {}
        }
      }

      console.log(
        `✅ Cleanup completed: ${cleanedGames} games, ${cleanedRooms} rooms, ${cleanedBoards} board collections, ${cleanedSessions} player sessions`,
      )
    } catch (error) {
      console.error("Error during cleanup:", error)
    }
  }

  // Clear all data (for development/testing)
  static async clearAllData() {
    try {
      const allKeys = await redis.keys("*")
      if (allKeys.length > 0) {
        await redis.del(...allKeys)
      }
      console.log(`Cleared ${allKeys.length} keys from Redis`)
    } catch (error) {
      console.error("Error clearing data:", error)
    }
  }
}

// Rate limiting
export class RateLimiter {
  static async checkLimit(identifier: string, limit = 10, window = 60) {
    try {
      const key = `rate:${identifier}`
      const current = await redis.incr(key)

      if (current === 1) {
        await redis.expire(key, window)
      }

      return current <= limit
    } catch (error) {
      console.error(`Error checking rate limit for ${identifier}:`, error)
      return true // Allow request if rate limiting fails
    }
  }
}
