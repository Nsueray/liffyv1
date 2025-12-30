# backend/Dockerfile
FROM node:22-alpine

WORKDIR /app

# --- KRİTİK GÜNCELLEME ---
# 1. poppler-utils: pdftotext aracı
# 2. poppler-data: PDF karakter kodlamaları (Bunu eklemezsek yazı çıkmaz!)
# 3. font-noto, ttf-freefont: Temel fontlar
# 4. msttcorefonts-installer: Arial, Times New Roman gibi Windows fontları
RUN apk add --no-cache \
    poppler-utils \
    poppler-data \
    font-noto \
    terminus-font \
    ttf-freefont \
    msttcorefonts-installer && \
    update-ms-fonts && \
    fc-cache -f

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend

RUN mkdir -p uploads && mkdir -p /tmp

CMD ["node", "backend/worker.js"]
