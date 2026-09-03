// src/prisma/db.ts (or wherever you instantiate the client)
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const db = new PrismaClient({ adapter });