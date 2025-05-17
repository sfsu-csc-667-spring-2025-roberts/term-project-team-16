export { default as rootRoutes } from "./root";
export { default as authRoutes } from "./auth";
export { default as gameRoutes } from "./games/game-controller";
import { sessionMiddleware } from "../middleware/session";
import { configureSockets } from "../config/socket";
