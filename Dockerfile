FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node test ./test
COPY --chown=node:node finetune/*.js ./finetune/
RUN mkdir -p .data/control && chown -R node:node .data
USER node
ENV HOST=0.0.0.0 PORT=8874
EXPOSE 8874
CMD ["node","src/server.js"]
