# Teachernow — tek imaj, iki proses modu (01-mimari kararı): MODE=web | MODE=worker
# Not: MVP imajı bilinçli olarak yalın tutulmadı (tam workspace + pnpm); boyut
# optimizasyonu (standalone output, prune) bilinen borç — pilot ölçeğinde önemsiz.
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .dependency-cruiser.cjs ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @teachernow/web build

COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3010
ENTRYPOINT ["/entrypoint.sh"]
