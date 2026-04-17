import { initTRPC } from "@trpc/server";
import type { Request, Response } from "express";
import superjson from "superjson";

export interface Context {
  req: Request;
  res: Response;
  user: { id: string; name: string; email: string; role: string } | null;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
// Personal dashboard — no auth required, same as public
export const protectedProcedure = t.procedure;
