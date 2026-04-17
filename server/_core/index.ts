import 'dotenv/config';
import express from "express";
import path from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import type { Context } from "./trpc";
import { startMarketMonitor } from "../market-monitor";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const isProd = process.env.NODE_ENV === "production";

app.use(express.json());

// tRPC API
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: ({ req, res }): Context => ({
      req,
      res,
      user: { id: "owner", name: "Owner", email: "", role: "admin" },
    }),
  })
);

if (isProd) {
  // Serve built frontend
  const distDir = path.resolve(process.cwd(), "dist/public");
  app.use(express.static(distDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
} else {
  // In dev, Vite serves the frontend on its own port — just log
  console.log("[Server] Dev mode: frontend served by Vite on a separate port");
}

app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});

// Pre-load PPO model so it's ready for trading decisions
import { ensurePPOLoaded } from "../ppo-agent";
ensurePPOLoaded().then(agent => {
  if (agent.totalEpisodes > 0) {
    console.log(`[PPO] Model loaded — ${agent.totalEpisodes} episodes, WR=${agent.winRate.toFixed(1)}%`);
  } else {
    console.log(`[PPO] No trained model found — run PPO training first`);
  }
}).catch(() => {});

// Start background market monitor
startMarketMonitor();

// Start fast executor (reads Claude's orders, executes at speed)
import { startFastExecutor } from "../fast-executor";
startFastExecutor();
