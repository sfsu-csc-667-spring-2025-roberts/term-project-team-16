import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import express from "express";
import http from "http";
import httpErrors from "http-errors";
import morgan from "morgan";
import { Server as IOServer } from "socket.io";
import * as path from "path";

import * as routes from "./routes";
import { sessionMiddleware } from "./middleware/session";
import { configureSockets } from "./config/socket";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

configureSockets(io, app);

const PORT = process.env.PORT || 3000;

app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(process.cwd(), "src", "public")));
app.use(
  "/client",
  express.static(path.join(process.cwd(), "src", "client"))
);
app.use(cookieParser());
app.use(sessionMiddleware);

app.set("views", path.join(process.cwd(), "src", "server", "views"));
app.set("view engine", "ejs");

app.use("/", routes.rootRoutes);
app.use("/auth", routes.authRoutes);

app.use((_request, _response, next) => {
  next(httpErrors(404));
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
