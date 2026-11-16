# Accounts backend (server/api). Also runs the migrations and the make-admin command.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx (a dev dependency) is what runs the server, so dev dependencies are installed too.
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig*.json ./
COPY server ./server
USER node
EXPOSE 4319
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4319/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/api/server.ts"]
