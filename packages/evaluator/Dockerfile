FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node sdk ./sdk
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node web ./web
RUN mkdir /app/.data && chown node:node /app/.data
USER node
ENV EVALUATOR_HOST=0.0.0.0 EVALUATOR_PORT=4317 EVALUATOR_DATA_DIR=/app/.data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
