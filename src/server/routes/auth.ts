import express from "express";
import type { Request, Response } from "express";


const router = express.Router();

router.get("/register", (_req: Request, res: Response) => {
  res.render("register", { error: null });
});

router.post("/register", (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  (req.session as any).user = { id: username, username, email };
  res.redirect("/");
});

router.get("/login", (_req: Request, res: Response) => {
  res.render("login", { error: null });
});

router.post("/login", (req: Request, res: Response) => {
  const { username } = req.body;
  (req.session as any).user = { id: username, username };
  res.redirect("/");
});

export default router;
