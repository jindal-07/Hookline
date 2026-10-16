import { Router } from "express";
import { z } from "zod";
import { buildDataset, latestDataset, getDataset, listDatasets } from "../services/dataset/datasetService.js";
import { playbookFor } from "../services/dataset/DatasetBuilder.js";
import { asyncRoute, validateReq, uuidParam } from "../middleware/index.js";
import { notFound } from "../utils/errors.js";

const r = Router();

r.get("/", asyncRoute(async (_req, res) => res.json({ items: await listDatasets() })));

r.get("/latest", asyncRoute(async (_req, res) => {
  const ds = await latestDataset();
  if (!ds) throw notFound("Dataset");
  res.json(ds);
}));

const buildBody = z.object({ batchIds: z.array(z.string().uuid()).optional(), name: z.string().max(255).optional(), excludeVideoIds: z.array(z.string().uuid()).max(10000).optional() }).strict();
/** Build a new dataset snapshot from training batches (all by default). */
r.post("/", validateReq("body", buildBody), asyncRoute(async (req, res) => {
  res.status(201).json(await buildDataset(req.body));
}));

r.get("/:id", validateReq("params", uuidParam), asyncRoute(async (req, res) => res.json(await getDataset(req.params.id))));

const playbookQuery = z.object({ genre: z.string().min(1).max(128), subgenre: z.string().max(128).optional() });
/** Preview exactly what the skill will receive for a genre/subgenre. */
r.get("/:id/playbook", validateReq("params", uuidParam), validateReq("query", playbookQuery), asyncRoute(async (req, res) => {
  const ds = await getDataset(req.params.id);
  res.json(playbookFor(ds.profile, req.validQuery));
}));

export default r;
