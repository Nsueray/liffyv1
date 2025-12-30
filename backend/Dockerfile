# backend/Dockerfile
FROM node:22-alpine

WORKDIR /app

# KRİTİK: pdftotext (poppler-utils) kurulumu
RUN apk add --no-cache poppler-utils

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend

RUN mkdir -p uploads && mkdir -p /tmp

CMD ["node", "backend/worker.js"]
