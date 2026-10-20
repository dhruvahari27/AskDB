# One image: builds the web app, then serves it and the API from a single Node process.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4711
# `npm run setup` creates tables, the read-only role and the sample warehouse if they are missing (safe to repeat).
CMD ["sh", "-c", "npm run setup && npm start"]
