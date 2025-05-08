import express from "express";
import type { Request, Response, Express } from "express";

const router = express.Router();

router.get("/", (_req: Request, res: Response) => {
  res.render("root", { title: "Jrob's site" });
});

router.post("/test-socket", (req: Request, res: Response): void => {
  const io = (req.app as Express).get("io");
  if (!io) {
    res.status(500).send("Socket server not available");
    return;
  }

  io.emit("test-event", {
    message: "This is a test message",
    timestamp: Date.now(),
  });

  res.status(200).send("Socket test message sent.");
});

router.post("/chat/:roomId", (req: Request, res: Response): void => {
  const io = (req.app as Express).get("io");
  const user = (req.session as any)?.user;
  if (!io || !user) {
    res.sendStatus(500);
    return;
  }

  const { roomId } = req.params;
  const { message } = req.body;

  io.to(roomId).emit(`chat-message-${roomId}`, {
    sender: { username: user.username },
    message,
    timestamp: Date.now(),
  });

  res.sendStatus(200);
});

export default router;
