export interface Player {
  id: string
  name: string
  telegramId?: number
  avatar?: string
  joinedAt: Date
}

export interface GameRoom {
  id: string
  stake: number
  players: Player[]
  maxPlayers: number
  status: "waiting" | "starting" | "active" | "finished"
  prize: number
  createdAt: Date
  gameStartTime?: Date
  activeGames?: number
  hasBonus: boolean
  calledNumbers?: number[]
  currentNumber?: number | null
}

export interface GameState {
  roomId: string
  calledNumbers: number[]
  currentNumber: number | null
  gameStatus: "waiting" | "active" | "finished"
  winners: Winner[]
  lastUpdate: string
  gameStartTime?: string
}

export interface Winner {
  playerId: string
  playerName: string
  winningPattern: string // e.g., "BINGO", "Line", "Four Corners"
  timestamp: string
}

export interface GameStateRequest {
  roomId: string
  action: "start-game" | "call-number" | "claim-bingo" | "reset-game"
  data?: {
    playerId?: string
    playerName?: string
    winningPattern?: string
  }
}

export interface JoinRoomRequest {
  action: "join" | "leave"
  roomId: string
  playerId: string
  playerData?: {
    name: string
    telegramId?: number
  }
}

export interface GameRoomSummary {
  id: string
  stake: number
  players: number
  maxPlayers: number
  status: "waiting" | "starting" | "active" | "finished"
  prize: number
  createdAt: string
  activeGames: number
  hasBonus: boolean
  gameStartTime?: string
  calledNumbers: number[]
  currentNumber?: number | null
}
