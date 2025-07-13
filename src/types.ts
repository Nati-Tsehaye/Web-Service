export interface GameRoom {
  id: number
  stake: number
  players: number
  prize: number
  status: "waiting" | "active"
  activeGames?: number // Added activeGames
  hasBonus: boolean // Added hasBonus
  connectedPlayers: Set<string> // Server-side only: Track connected player IDs
  selectedBoards: Map<number, string> // Server-side only: boardId -> playerId
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
  roomId?: number
  playerId?: string
  playerName?: string
  rooms?: GameRoomClient[] // Use client-friendly GameRoom
  message?: string
  boardId?: number // For select_board message
}

// Client-side representation of GameRoom (without Set)
export interface GameRoomClient {
  id: number
  stake: number
  players: number
  prize: number
  status: "waiting" | "active"
  activeGames?: number
  hasBonus: boolean
  selectedBoards: { boardId: number; playerId: string; playerName: string }[] // Client-side: array of selected boards
}

export interface ServerState {
  rooms: Map<number, GameRoom>
  players: Map<string, Player>
  connections: Map<any, string> // WebSocket -> Player ID mapping
}
