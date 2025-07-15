import { gameState, stopNumberCalling } from "./gameState.js"
import { broadcastRoomUpdate } from "./server.js"

/**
 * Resets the state of a specific game room.
 * @param roomId The ID of the room to reset.
 * @param shouldBroadcast Whether to broadcast a room update after resetting.
 */
export function resetRoomState(roomId: number, shouldBroadcast: boolean): void {
  const room = gameState.rooms.get(roomId)
  if (!room) return

  console.log(`Resetting room ${roomId} state. Broadcasting: ${shouldBroadcast}`)

  // Stop any ongoing number calling
  stopNumberCalling(roomId) // This will clear room.gameInterval

  room.status = "waiting"
  room.calledNumbers = []
  room.currentNumber = undefined
  room.prize = 0
  room.players = 0
  room.winner = undefined // Clear winner info
  room.selectedBoards.clear() // Clear selected boards
  room.connectedPlayers.clear() // Clear connected players (they will need to rejoin)

  if (shouldBroadcast) {
    broadcastRoomUpdate()
  }
}
