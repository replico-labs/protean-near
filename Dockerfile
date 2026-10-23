# The Protean bot (Telegram and Discord), for any Docker host (Railway, Fly,
# a VPS). Settings come from the host's environment, as in .env.example.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# The bot reads the published contracts' code hashes from orbits/deployments.
COPY orbits/deployments orbits/deployments
COPY bot/package.json bot/package-lock.json bot/
RUN cd bot && npm ci --omit=dev
COPY bot/src bot/src
WORKDIR /app/bot
# Chat links' local copy (data/), writable by the unprivileged user.
RUN mkdir -p data && chown node:node data
USER node
CMD ["node", "src/main.js"]
