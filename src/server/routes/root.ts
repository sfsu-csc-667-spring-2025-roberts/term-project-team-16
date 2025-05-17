import express from "express";
import type { Request, Response, Express } from "express";

const router = express.Router();

router.get("/", (req: Request, res: Response) => {
  res.render("root", { 
    title: "BS Card Game",
    userId: req.session.userId,
    username: req.session.username
  });
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

// Chat is now handled through WebSocket events directly

export default router;
