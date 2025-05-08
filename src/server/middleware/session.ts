import session from "express-session";
import type { RequestHandler } from "express";

export const sessionMiddleware: RequestHandler = session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false,
  saveUninitialized: false
});
