import type { GameRoom, ServerState, GameRoomClient, WebSocketMessage } from "./types.js" // Added .js and WebSocketMessage
import { broadcastRoomUpdate } from "./server.js" // Import broadcastRoomUpdate
import { resetRoomState } from "./gameLogic.js" // Import the new reset function

// Initialize game rooms with default data
const initialRooms: GameRoom[] = [
  {
    id: 1,
    stake: 10,
    players: 0,
    prize: 0,
    status: "waiting",
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
    startTime: undefined,
    calledNumbers: [], // New
    currentNumber: undefined, // New
    gameInterval: undefined, // New
  },
  {
    id: 2,
    stake: 20,
    players: 0,
    prize: 0,
    status: "waiting",
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
    startTime: undefined,
    calledNumbers: [], // New
    currentNumber: undefined, // New
    gameInterval: undefined, // New
  },
  {
    id: 3,
    stake: 50,
    players: 0,
    prize: 0,
    status: "waiting",
    activeGames: 0,
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
    startTime: undefined,
    calledNumbers: [], // New
    currentNumber: undefined, // New
    gameInterval: undefined, // New
  },
  {
    id: 4,
    stake: 100,
    players: 0,
    prize: 0,
    status: "waiting",
    activeGames: 0,
    hasBonus: true,
    connectedPlayers: new Set(),
    selectedBoards: new Map(),
    startTime: undefined,
    calledNumbers: [], // New
    currentNumber: undefined, // New
    gameInterval: undefined, // New
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
  return Array.from(gameState.rooms.values()).map((room: GameRoom) => ({
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
    startTime: room.startTime,
    calledNumbers: room.calledNumbers, // New
    currentNumber: room.currentNumber, // New
    winner: room.winner, // Include winner info
  }))
}

export function joinRoom(playerId: string, roomId: number): boolean {
  const room = gameState.rooms.get(roomId)
  const player = gameState.players.get(playerId)

  if (!room || !player) {
    return false
  }

  // If player is already in this room, don't process again
  if (room.connectedPlayers.has(playerId)) {
    console.log(`Player ${player.name} is already in room ${roomId}`)
    return true
  }

  // Leave current room if in a different one
  if (player.currentRoom && player.currentRoom !== roomId) {
    leaveRoom(playerId, player.currentRoom)
  }

  // Join new room
  room.connectedPlayers.add(playerId)
  player.currentRoom = roomId
  room.players = room.connectedPlayers.size

  // Recalculate prize if the game is already active or starting
  if (room.status === "active" || room.status === "starting") {
    room.prize = room.stake * room.connectedPlayers.size
    console.log(`Prize updated in joinRoom for room ${roomId}: ${room.prize}`)
  }

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
  room.players = Math.max(0, room.players - 1)

  // Remove player's selected board if they leave
  for (const [existingBoardId, existingPlayerId] of room.selectedBoards.entries()) {
    if (existingPlayerId === playerId) {
      room.selectedBoards.delete(existingBoardId)
    }
  }

  // Reset room state when no players are left
  if (room.connectedPlayers.size === 0) {
    resetRoomState(roomId, false) // Reset without broadcasting immediately, broadcast will happen later
    console.log(`Room ${roomId} reset to initial state - no players remaining`)
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
    room.status = "starting"
    room.startTime = Date.now()
    room.activeGames = (room.activeGames || 0) + 1
    room.players = room.connectedPlayers.size
    room.prize = room.stake * room.connectedPlayers.size // Corrected prize calculation
    room.calledNumbers = [] // Reset called numbers
    room.currentNumber = undefined // Reset current number
    room.winner = undefined // Clear any previous winner

    console.log(`Game starting in room ${roomId}. Players: ${room.players}, Prize: ${room.prize}`)

    broadcastRoomUpdate()

    // After 40 seconds, transition to "active" and start calling numbers
    setTimeout(() => {
      const updatedRoom = gameState.rooms.get(roomId)
      if (updatedRoom && updatedRoom.status === "starting") {
        updatedRoom.status = "active"
        console.log(`Game in room ${roomId} is now active. Starting number calling...`)
        broadcastRoomUpdate()

        // Start calling numbers
        startNumberCalling(roomId)
      }
    }, 40 * 1000) // 40 seconds

    return true
  }
  return false
}

export function startNumberCalling(roomId: number): void {
  const room = gameState.rooms.get(roomId)
  if (!room || room.status !== "active") {
    return
  }

  // Clear any existing interval
  if (room.gameInterval) {
    clearInterval(room.gameInterval)
  }

  // Start calling numbers every 5 seconds
  room.gameInterval = setInterval(() => {
    callNextNumber(roomId)
  }, 5000) // Call a number every 5 seconds

  // Call the first number immediately
  callNextNumber(roomId)
}

function callNextNumber(roomId: number): void {
  const room = gameState.rooms.get(roomId)
  if (!room || room.status !== "active") {
    return
  }

  // Get available numbers (1-75 that haven't been called yet)
  const availableNumbers = []
  for (let i = 1; i <= 75; i++) {
    if (!room.calledNumbers.includes(i)) {
      availableNumbers.push(i)
    }
  }

  // If no more numbers available, end the game
  if (availableNumbers.length === 0) {
    resetRoomState(roomId, true) // Use the new reset function
    return
  }

  // Select a random number
  const randomIndex = Math.floor(Math.random() * availableNumbers.length)
  const calledNumber = availableNumbers[randomIndex]

  // Update room state
  room.calledNumbers.push(calledNumber)
  room.currentNumber = calledNumber

  console.log(`Room ${roomId}: Called number ${calledNumber}. Total called: ${room.calledNumbers.length}`)

  // Broadcast the called number to all players in the room
  broadcastNumberCall(roomId, calledNumber, room.calledNumbers)
}

function broadcastNumberCall(roomId: number, calledNumber: number, allCalledNumbers: number[]): void {
  const room = gameState.rooms.get(roomId)
  if (!room) return

  const message = {
    type: "number_called" as const,
    roomId,
    calledNumber,
    allCalledNumbers: [...allCalledNumbers], // Send a copy
  }

  const messageStr = JSON.stringify(message)
  console.log(`📡 Broadcasting number ${calledNumber} to room ${roomId}`)

  // Send to all players in this room
  room.connectedPlayers.forEach((playerId) => {
    const player = gameState.players.get(playerId)
    if (player && player.websocket && player.websocket.readyState === player.websocket.OPEN) {
      player.websocket.send(messageStr)
    }
  })
}

export function handleBingoWin(roomId: number, winnerPlayerId: string): boolean {
  const room = gameState.rooms.get(roomId)
  const winner = gameState.players.get(winnerPlayerId)

  if (!room || !winner) {
    console.log(`BINGO claim failed: Room ${roomId} or Winner ${winnerPlayerId} not found.`)
    return false
  }

  // Prevent multiple wins or claims after game over
  if (room.status === "game_over") {
    console.log(`BINGO already claimed in room ${roomId}.`)
    return false
  }

  console.log(`Player ${winner.name} claimed BINGO in room ${roomId}!`)

  // Set room status to game_over and store winner info
  room.status = "game_over"
  room.winner = {
    playerId: winner.id,
    playerName: winner.name,
    prize: room.prize, // The prize is already calculated based on current players
  }

  // Stop number calling immediately
  stopNumberCalling(roomId)

  // Broadcast the win to all players in the room
  const winMessage: WebSocketMessage = {
    type: "bingo_won",
    roomId: roomId,
    winnerPlayerId: winner.id,
    winnerName: winner.name,
    winningPrize: room.prize,
  }

  const winMessageStr = JSON.stringify(winMessage)
  room.connectedPlayers.forEach((playerId) => {
    const player = gameState.players.get(playerId)
    if (player && player.websocket && player.websocket.readyState === player.websocket.OPEN) {
      player.websocket.send(winMessageStr)
    }
  })

  // Reset the room after a delay (e.g., 10 seconds)
  setTimeout(() => {
    resetRoomState(roomId, true) // Use the new reset function and broadcast
  }, 10000) // 10 seconds before resetting the room

  return true
}

// The stopNumberCalling function remains here as it's specific to game state management
export function stopNumberCalling(roomId: number): void {
  const room = gameState.rooms.get(roomId)
  if (!room) return

  if (room.gameInterval) {
    clearInterval(room.gameInterval)
    room.gameInterval = undefined
    console.log(`Stopped number calling for room ${roomId}`)
  }
}
