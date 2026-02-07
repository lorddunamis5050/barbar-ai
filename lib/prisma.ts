import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

type GlobalWithPrisma = typeof globalThis & {
  prisma?: PrismaClient;
  pgPool?: Pool;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

const pool =
  globalForPrisma.pgPool ?? new Pool({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.pgPool = pool;
}

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(pool),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { prisma };
