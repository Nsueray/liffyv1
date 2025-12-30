# backend/Dockerfile
FROM node:22-alpine

WORKDIR /app

# KRİTİK DÜZELTME: 
# 1. poppler-utils: PDF okuma aracı
# 2. font-noto, ttf-freefont: PDF içindeki harfleri tanımak için gereken fontlar
RUN apk add --no-cache poppler-utils font-noto ttf-freefont

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend

RUN mkdir -p uploads && mkdir -p /tmp

CMD ["node", "backend/worker.js"]
