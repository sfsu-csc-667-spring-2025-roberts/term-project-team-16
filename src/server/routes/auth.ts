import { Request, Response } from "express";
import express from "express";

const router = express.Router();

router.get("/register", async (_request: Request, response: Response) => {
  response.render("register", { error: null });
});

router.get("/login", async (_request: Request, response: Response) => {
  response.render("login", { error: null });
});

export default router;