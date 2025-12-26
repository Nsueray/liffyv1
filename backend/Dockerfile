FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Node dependencies
COPY package*.json ./
RUN npm ci --production

# App code
COPY . .

ENV NODE_ENV=production

CMD ["node", "worker.js"]
