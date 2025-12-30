# Node.js 22 imajını kullan (Senin versiyonunla uyumlu)
FROM node:22-alpine

# Çalışma dizinini ayarla
WORKDIR /app

# 1. Önce sadece paket dosyalarını kopyala (Root context'ten)
COPY package.json package-lock.json ./

# 2. Paketleri yükle (Cache mekanizmasını bozmamak için)
RUN npm ci

# 3. Şimdi kaynak kodları kopyala
# Context "Root" olduğu için, backend klasörünü içeri alıyoruz
COPY backend ./backend

# Uploads klasörünü oluştur (Dosya yüklemeleri için)
RUN mkdir -p uploads

# 4. Worker'ı başlat
CMD ["node", "backend/worker.js"]
