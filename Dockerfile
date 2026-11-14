FROM node:24-slim

# Elektron viza PDF'i uchun headless Chromium va koreys/lotin shriftlari
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DB_PATH=/data/visa-admin.db \
    CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Tashqi npm paketlar yo'q — faqat kod
COPY package.json server.js entrypoint.sh ./
COPY src ./src
COPY public ./public

# Konteyner root bo'lib boshlanadi, /data volume egasini to'g'rilaydi,
# so'ng huquqlarni tashlab "node" foydalanuvchisi sifatida ishlaydi (entrypoint.sh).
CMD ["sh", "/app/entrypoint.sh"]
