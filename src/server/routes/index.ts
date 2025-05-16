export { default as rootRoutes } from "./root";
export { default as authRoutes } from "./auth";
import { sessionMiddleware } from "./middleware/session";
import { configureSockets } from "./config/socket"; 
