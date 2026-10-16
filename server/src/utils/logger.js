import pino from "pino";
import { config } from "../config/env.js";

export const logger = pino({
  level: config.isTest ? "silent" : config.logLevel,
  redact: ["req.headers.authorization", "*.apiKey", "*.api_key"],
  transport: config.env === "development" ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } : undefined,
});
