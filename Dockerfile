FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_OPTIONS=--use-system-ca
WORKDIR /app
# Engine and renderer packages are pinned; apt retains signature verification.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils=22.12.0-2+deb12u3 tesseract-ocr=5.3.0-2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=cloud_proxy_ca \
    if [ -s /run/secrets/cloud_proxy_ca ]; then \
      cp /run/secrets/cloud_proxy_ca /usr/local/share/ca-certificates/cloud-proxy-ca.crt; \
      update-ca-certificates; \
    fi
FROM runtime AS app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production OMP_THREAD_LIMIT=1
CMD ["npm", "run", "api"]
