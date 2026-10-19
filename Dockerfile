FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY sql ./sql
COPY config ./config
COPY scripts ./scripts
USER node
EXPOSE 3200
CMD ["node", "src/server.js"]
