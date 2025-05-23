import express from "express";
import type { Request, Response, Express } from "express";

const router = express.Router();

//oh thank god actual APIs that are almost readable
//well like it's not a json or anything, but I was 
// I am so afraid of making a single json in this god forsaken language
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

router.get("/settings", (req: Request, res: Response) => {
  if (!req.session?.userId) {
    return res.redirect("/auth/login");
  }
  res.render("settings", { 
    username: req.session.username,
    email: req.session.email
  });
});

export default router;
