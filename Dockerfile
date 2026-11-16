# Vulnera: one container serves the web app and the API.
#   docker build -t vulnera .
#   docker run -p 8080:8080 --env-file .env vulnera
# Settings come from environment variables (see .env.example); nothing secret is baked into the image.

# ---- build: install everything, compile the server and the web app ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY server server
COPY client client
RUN npm run build

# ---- runtime: production dependencies of the server only ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--max-old-space-size=768
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY server/migrations server/migrations
# Saved vulnerability data (fallback when a live service is unreachable), the CISA KEV list and the sample project.
COPY data data
COPY samples/demo-app samples/demo-app
# The KEV list refreshes itself daily into data/, so that folder must be writable by the app user.
RUN chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
