FROM node:22-alpine

WORKDIR /app
COPY dist/broker.cjs /app/broker.cjs

RUN mkdir -p /audit && chown -R node:node /app /audit

EXPOSE 443 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=3s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/broker.cjs"]
