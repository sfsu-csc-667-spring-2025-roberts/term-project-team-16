import { Server as IOServer } from "socket.io";
import type { Express } from "express";
import { sessionMiddleware } from "../middleware/session";
import handleLobbyConnection from "../socket-handlers/lobby";

export function configureSockets(io: IOServer, app: Express): void {
  app.set("io", io);
  io.engine.use(sessionMiddleware);

  io.on("connection", (socket) => {
    const req = socket.request as any;
    const user = req.session?.user;

    if (!user) {
      console.log("Unauthenticated socket tried to connect, disconnecting");
      return;
    }

    console.log(`User ${user.id} connected with socket ID ${socket.id}`);
    socket.join(user.id.toString());
    socket.join("0");

    handleLobbyConnection(socket);

    socket.on("disconnect", () => {
      console.log(`User ${user.id} disconnected`);
    });
  });
}
