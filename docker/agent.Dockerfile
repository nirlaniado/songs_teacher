# Chord agent (server/ug): a local service that drives Chromium to read Ultimate Guitar charts.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UG_HEADLESS=true
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force
# The Chromium build that matches the installed playwright version, plus its system libraries.
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY tsconfig*.json ./
COPY server ./server
COPY src/ug ./src/ug
# The login profile and imported charts live here; compose mounts a volume over it.
RUN mkdir -p /app/.ug-agent && chown node:node /app/.ug-agent
USER node
EXPOSE 4318
CMD ["node", "--import", "tsx", "server/ug/server.ts"]
