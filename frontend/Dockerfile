FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=18902 \
    HOSTNAME=0.0.0.0
COPY --from=builder /app .
EXPOSE 18902
CMD ["npm", "start", "--", "-H", "0.0.0.0", "-p", "18902"]
