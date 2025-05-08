import type { Socket } from "socket.io";

export default function handleLobbyConnection(socket: Socket): void {
  console.log(`[lobby] socket connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`[lobby] socket disconnected: ${socket.id}`);
  });
}
