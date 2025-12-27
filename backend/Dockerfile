ARG CACHE_BUST=2025-01-27
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

ENV NODE_ENV=production

# 👇 Worker entrypoint (ZORUNLU)
CMD ["node", "worker.js"]
