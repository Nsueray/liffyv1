# Node.js 22 Debian Slim
FROM node:22-slim

WORKDIR /app

# --- FONT VE ARAÇ PAKETLERİ (Universal PDF Support) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    poppler-data \
    mupdf-tools \
    ghostscript \
    fonts-noto \
    fonts-freefont-ttf \
    fonts-liberation \
    fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend

RUN mkdir -p uploads && mkdir -p /tmp

CMD ["node", "backend/worker.js"]
