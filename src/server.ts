import { createServer } from "http"
import { initializeSocketServer } from "./lib/socket-server"

const httpServer = createServer()
const io = initializeSocketServer(httpServer)

const PORT = process.env.PORT || 4000

httpServer.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`)
})

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server")
  httpServer.close(() => {
    console.log("HTTP server closed.")
    io.close(() => {
      console.log("Socket.IO server closed.")
      process.exit(0)
    })
  })
})

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing HTTP server")
  httpServer.close(() => {
    console.log("HTTP server closed.")
    io.close(() => {
      console.log("Socket.IO server closed.")
      process.exit(0)
    })
  })
})
