// Express application (no listening / process concerns — see index.js).
import path from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { config, ROOT_DIR } from "./config/env.js";
import batches from "./routes/batches.js";
import videos from "./routes/videos.js";
import system from "./routes/system.js";
import datasets from "./routes/datasets.js";
import scripts from "./routes/scripts.js";
import authRoutes from "./routes/auth.js";
import { apiLimiter, auth, errorHandler } from "./middleware/index.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors({ origin: config.corsOrigin, credentials: false }));
  app.use(express.json({ limit: "1mb" }));

  const api = express.Router();
  api.use(apiLimiter);
  api.use("/auth", authRoutes); // sign-in endpoints stay reachable without a session
  api.use(auth);
  api.use("/batches", batches);
  api.use("/videos", videos);
  api.use("/datasets", datasets);
  api.use("/scripts", scripts);
  api.use("/", system);
  api.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown API route" } }));
  app.use("/api", api);

  // Serve the built dashboard in production (single port).
  const dist = path.join(ROOT_DIR, "client", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
