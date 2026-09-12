FROM oven/bun:1

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Generate the Prisma client (no DB connection required for generation).
COPY prisma ./prisma
RUN bunx prisma generate

# Copy the rest of the source.
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]