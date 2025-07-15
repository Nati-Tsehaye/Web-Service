export interface GameRoom {
  id: number
  stake: number
  players: number
  prize: number
  status: "waiting" | "active" | "starting" | "game_over" // Added "game_over" status
  activeGames?: number // Added activeGames
  hasBonus: boolean // Added hasBonus
  connectedPlayers: Set<string> // Server-side only: Track connected player IDs
  selectedBoards: Map<number, string> // Server-side only: boardId -> playerId
  startTime?: number // New: Timestamp when the game started (for countdown sync)
  calledNumbers: number[] // New: Track all called numbers
  currentNumber?: number // New: Current number being called
  gameInterval?: NodeJS.Timeout // New: Timer for calling numbers
  winner?: { playerId: string; playerName: string; prize: number } // New: Store winner info
}

export interface Player {
  id: string
  name: string
  currentRoom?: number
  websocket?: any
}

export interface WebSocketMessage {
  type:
    | "join_room"
    | "leave_room"
    | "room_update"
    | "player_joined"
    | "player_left"
    | "error"
    | "select_board"
    | "start_game"
    | "number_called"
    | "bingo_won" // New: For broadcasting win
  roomId?: number
  playerId?: string
  playerName?: string
  rooms?: GameRoomClient[] // Use client-friendly GameRoom
  message?: string
  boardId?: number // For select_board message
  calledNumber?: number // New: The number that was called
  allCalledNumbers?: number[] // New: All numbers called so far
  winnerPlayerId?: string // New: ID of the player who won
  winnerName?: string // New: Name of the player who won
  winningPrize?: number // New: Prize amount for the winner
}

// Client-side representation of GameRoom (without Set)
export interface GameRoomClient {
  id: number
  stake: number
  players: number
  prize: number
  status: "waiting" | "active" | "starting" | "game_over" // Added "game_over" status
  activeGames?: number
  hasBonus: boolean
  selectedBoards: { boardId: number; playerId: string; playerName: string }[] // Client-side: array of selected boards
  startTime?: number // New: Timestamp when the game started (for countdown sync)
  calledNumbers: number[] // New: Track all called numbers
  currentNumber?: number // New: Current number being called
  winner?: { playerId: string; playerName: string; prize: number } // New: Store winner info
}

export interface ServerState {
  rooms: Map<number, GameRoom>
  players: Map<string, Player>
  connections: Map<any, string> // WebSocket -> Player ID mapping
}
