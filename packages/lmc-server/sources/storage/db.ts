import { PrismaClient } from "@/generated/client";

export const db = new PrismaClient();

// Legacy embedded launcher is excluded from the LMC entry point.
export function getPGlite(): null { return null; }
