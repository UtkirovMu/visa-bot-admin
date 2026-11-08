FROM node:24-slim

ENV NODE_ENV=production \
    DB_PATH=/data/visa-admin.db

WORKDIR /app

# Tashqi paketlar yo'q — faqat kod
COPY package.json server.js entrypoint.sh ./
COPY src ./src
COPY public ./public

# Konteyner root bo'lib boshlanadi, /data volume egasini to'g'rilaydi,
# so'ng huquqlarni tashlab "node" foydalanuvchisi sifatida ishlaydi (entrypoint.sh).
CMD ["sh", "/app/entrypoint.sh"]
