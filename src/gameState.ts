import type { GameRoom, ServerState, GameRoomClient } from "./types"

// Initialize game rooms with default data
const initialRooms: GameRoom[] = [
  {
    id: 1,
    stake: 10,
    players: 0,
    prize: 0, // Initialized to 0
    status: "waiting",
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(), // Initialize selectedBoards
  },
  {
    id: 2,
    stake: 20,
    players: 0,
    prize: 0, // Initialized to 0
    status: "waiting",
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
  },
  {
    id: 3,
    stake: 50,
    players: 0,
    prize: 0, // Initialized to 0
    status: "waiting",
    activeGames: 0,
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
  },
  {
    id: 4,
    stake: 100,
    players: 0,
    prize: 0, // Initialized to 0
    status: "waiting",
    activeGames: 0,
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
  },
]

export const gameState: ServerState = {
  rooms: new Map(),
  players: new Map(),
  connections: new Map(),
}

// Initialize rooms
initialRooms.forEach((room) => {
  gameState.rooms.set(room.id, room)
})

export function getRoomsArray(): GameRoomClient[] {
  return Array.from(gameState.rooms.values()).map((room) => ({
    id: room.id,
    stake: room.stake,
    players: room.players,
    prize: room.prize,
    status: room.status,
    activeGames: room.activeGames,
    hasBonus: room.hasBonus,
    selectedBoards: Array.from(room.selectedBoards.entries()).map(([boardId, playerId]) => ({
      boardId,
      playerId,
      playerName: gameState.players.get(playerId)?.name || "Unknown",
    })),
  }))
}

export function joinRoom(playerId: string, roomId: number): boolean {
  const room = gameState.rooms.get(roomId)
  const player = gameState.players.get(playerId)

  if (!room || !player) {
    return false
  }

  // Leave current room if in one
  if (player.currentRoom) {
    leaveRoom(playerId, player.currentRoom)
  }

  // Join new room
  room.connectedPlayers.add(playerId)
  // room.players is now updated only when game starts
  // room.players = room.connectedPlayers.size

  player.currentRoom = roomId

  console.log(
    `Player ${player.name} joined room ${roomId}. Room now has ${room.connectedPlayers.size} connected players.`,
  )
  return true
}

export function leaveRoom(playerId: string, roomId: number): boolean {
  const room = gameState.rooms.get(roomId)
  const player = gameState.players.get(playerId)

  if (!room || !player) {
    return false
  }

  room.connectedPlayers.delete(playerId)
  // Update player count on leave, ensuring it doesn't go below zero
  room.players = Math.max(0, room.players - 1)

  // Remove player's selected board if they leave
  for (const [existingBoardId, existingPlayerId] of room.selectedBoards.entries()) {
    if (existingPlayerId === playerId) {
      room.selectedBoards.delete(existingBoardId)
    }
  }

  if (player.currentRoom === roomId) {
    player.currentRoom = undefined
  }

  console.log(
    `Player ${player.name} left room ${roomId}. Room now has ${room.connectedPlayers.size} connected players.`,
  )
  return true
}

export function addPlayer(playerId: string, playerName: string, websocket: any): void {
  gameState.players.set(playerId, {
    id: playerId,
    name: playerName,
    websocket,
  })
  gameState.connections.set(websocket, playerId)
  console.log(`Player ${playerName} (${playerId}) connected. Total players: ${gameState.players.size}`)
}

export function removePlayer(playerId: string): void {
  const player = gameState.players.get(playerId)

  if (player) {
    console.log(`Player ${player.name} (${playerId}) disconnecting...`)

    // Leave current room if in one
    if (player.currentRoom) {
      leaveRoom(playerId, player.currentRoom)
    }

    // Remove from connections map
    if (player.websocket) {
      gameState.connections.delete(player.websocket)
    }

    // Remove player
    gameState.players.delete(playerId)
    console.log(`Player ${player.name} removed. Total players: ${gameState.players.size}`)
  }
}

export function getPlayerByWebSocket(ws: any): string | undefined {
  return gameState.connections.get(ws)
}

export function selectBoard(playerId: string, roomId: number, boardId: number): boolean {
  const room = gameState.rooms.get(roomId)
  const player = gameState.players.get(playerId)

  if (!room || !player) {
    console.log(`Failed to select board: Room ${roomId} or Player ${playerId} not found.`)
    return false
  }

  // Check if the board is already selected by someone else
  if (room.selectedBoards.has(boardId) && room.selectedBoards.get(boardId) !== playerId) {
    console.log(`Board ${boardId} is already selected by another player.`)
    return false
  }

  // If the player previously selected a different board, remove that selection
  for (const [existingBoardId, existingPlayerId] of room.selectedBoards.entries()) {
    if (existingPlayerId === playerId && existingBoardId !== boardId) {
      room.selectedBoards.delete(existingBoardId)
      console.log(`Player ${player.name} unselected board ${existingBoardId}.`)
      break
    }
  }

  // Select the new board
  room.selectedBoards.set(boardId, playerId)
  console.log(`Player ${player.name} selected board ${boardId} in room ${roomId}.`)
  return true
}

export function startGameInRoom(roomId: number): boolean {
  const room = gameState.rooms.get(roomId)
  if (!room) {
    return false
  }

  if (room.status === "waiting") {
    room.status = "active"
    room.activeGames = (room.activeGames || 0) + 1
    room.players = room.connectedPlayers.size // Update player count when game starts
    room.prize = room.stake // Set prize directly to stake
    console.log(`Game started in room ${roomId}. Players: ${room.players}, Prize: ${room.prize}`)
    return true
  }
  return false
}
