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
    python3 \
    python3-pip \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# --- PYTHON PDF TABLE EXTRACTION ---
RUN pip install --break-system-packages pdfplumber

COPY package.json package-lock.json ./
RUN npm ci

# --- PLAYWRIGHT BROWSER (Chromium for mining) ---
RUN npx playwright install chromium --with-deps

COPY backend ./backend

RUN mkdir -p uploads && mkdir -p /tmp

CMD ["node", "backend/worker.js"]
