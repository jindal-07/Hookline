// Progress events: in-process EventEmitter, bridged over Redis pub/sub when workers run in a
// separate process (BullMQ driver) so the API's SSE stream sees worker updates.
import { EventEmitter } from "node:events";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

const CHANNEL = "reelscript:events";
const local = new EventEmitter();
local.setMaxListeners(1000);
let pub = null, sub = null;
const origin = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export async function initEventBridge() {
  if (config.queueDriver !== "bullmq" || !config.redisUrl || pub) return;
  const { default: IORedis } = await import("ioredis");
  pub = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  sub = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  await sub.subscribe(CHANNEL);
  sub.on("message", (_ch, msg) => {
    try {
      const { origin: o, event } = JSON.parse(msg);
      if (o !== origin) local.emit("event", event);
    } catch (e) { logger.warn({ err: e }, "bad event message"); }
  });
}

export function publish(event) {
  const e = { ...event, at: new Date().toISOString() };
  local.emit("event", e);
  if (pub) pub.publish(CHANNEL, JSON.stringify({ origin, event: e })).catch(err => logger.warn({ err }, "event publish failed"));
}

export function subscribe(fn) {
  local.on("event", fn);
  return () => local.off("event", fn);
}

export async function closeEventBridge() {
  await Promise.all([pub?.quit(), sub?.quit()].filter(Boolean)).catch(() => {});
  pub = sub = null;
}
