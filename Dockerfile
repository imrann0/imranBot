FROM node:20-slim

WORKDIR /app

# Canvas text rendering için font paketi
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Önce sadece package.json kopyala — dependency katmanı cache'lenir
COPY package*.json ./

# Production dependency'leri yükle
RUN npm install --omit=dev

# Kaynak kodunu kopyala
COPY . .

CMD ["node", "index.js"]
