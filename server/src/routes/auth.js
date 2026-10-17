// Password wall endpoints. Mounted before the auth middleware so the sign-in screen can reach them.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncRoute, validateReq, isAuthorized } from "../middleware/index.js";
import { passwordRequired, checkPassword, createSessionValue, sessionCookie } from "../services/auth/session.js";

const r = Router();

// Slow down password guessing: 10 attempts per 15 minutes per client IP (trust proxy is set for Render).
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, skipSuccessfulRequests: true,
  message: { error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Try again in 15 minutes." } },
});

const secure = (req) => req.secure || process.env.NODE_ENV === "production";

/** Whether this server needs a password, and whether this browser is signed in. */
r.get("/session", (req, res) => res.json({ required: passwordRequired(), authenticated: isAuthorized(req) }));

const loginBody = z.object({ password: z.string().min(1).max(500) }).strict();
r.post("/login", loginLimiter, validateReq("body", loginBody), asyncRoute(async (req, res) => {
  if (!passwordRequired()) return res.json({ authenticated: true });
  if (!checkPassword(req.body.password)) return res.status(401).json({ error: { code: "WRONG_PASSWORD", message: "That password isn't right." } });
  res.setHeader("Set-Cookie", sessionCookie(createSessionValue(), { secure: secure(req) }));
  res.json({ authenticated: true });
}));

r.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", { secure: secure(req), clear: true }));
  res.json({ authenticated: false });
});

export default r;
