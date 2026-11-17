# Frontend: the production build, served by nginx, which also proxies /api to the services.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# Optional model URL overrides; Vite inlines VITE_* into the bundle, so never pass a secret here.
ARG VITE_DEMUCS_MODEL_URL
ARG VITE_ALIGN_MODEL_URL
ENV VITE_DEMUCS_MODEL_URL=${VITE_DEMUCS_MODEL_URL} \
    VITE_ALIGN_MODEL_URL=${VITE_ALIGN_MODEL_URL}
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
